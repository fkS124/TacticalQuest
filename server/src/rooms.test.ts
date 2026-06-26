import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_EMPTY_TTL_MS,
  ROOM_MAX_AGE_MS,
} from '@tq/shared/constants';
import { isErr, RoomManager } from './rooms';

const SIDC = 'SFGPUCI----';
const T0 = 1_000_000;

function createdRoom(manager: RoomManager, now = T0) {
  const res = manager.createRoom('Alpha 1', SIDC, 'sock-leader', now);
  if (isErr(res)) throw new Error(res.error);
  return res;
}

describe('génération des codes', () => {
  it('produit des codes de 6 caractères dans l’alphabet radio', () => {
    const manager = new RoomManager();
    for (let i = 0; i < 50; i++) {
      const { room } = createdRoom(manager);
      expect(room.code).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of room.code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
    expect(manager.rooms.size).toBe(50);
  });
});

describe('join', () => {
  it('rejette un code inconnu', () => {
    const manager = new RoomManager();
    const res = manager.joinRoom('ZZZZZZ', 'Bravo 2', SIDC, 's2', T0);
    expect(res).toEqual({ ok: false, error: 'ROOM_NOT_FOUND' });
  });

  it('rejette un indicatif déjà pris (insensible à la casse)', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const res = manager.joinRoom(room.code, 'alpha 1', SIDC, 's2', T0);
    expect(res).toEqual({ ok: false, error: 'CALLSIGN_TAKEN' });
  });

  it('le créateur est chef, les suivants non', () => {
    const manager = new RoomManager();
    const { room, member: leader } = createdRoom(manager);
    const res = manager.joinRoom(room.code, 'Bravo 2', SIDC, 's2', T0);
    expect(res.ok).toBe(true);
    expect(leader.isLeader).toBe(true);
    if (res.ok) expect(res.member.isLeader).toBe(false);
  });
});

describe('rejoin et période de grâce', () => {
  it('re-binde avec le bon sessionToken, rejette le mauvais', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    expect(member.connected).toBe(false);

    const bad = manager.rejoin(room.code, member.id, 'faux-token', 's2', T0 + 2000);
    expect(bad).toEqual({ ok: false, error: 'SESSION_INVALID' });

    const good = manager.rejoin(room.code, member.id, member.sessionToken, 's2', T0 + 2000);
    expect(good.ok).toBe(true);
    expect(member.connected).toBe(true);
    expect(member.socketId).toBe('s2');
  });

  it('supprime le membre après expiration de la grâce', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const joined = manager.joinRoom(room.code, 'Bravo 2', SIDC, 's2', T0);
    if (!joined.ok) throw new Error('join failed');
    manager.markDisconnected(room.code, joined.member.id, T0);

    expect(manager.sweep(T0 + DISCONNECT_GRACE_MS - 1).memberTimeouts).toHaveLength(0);
    const events = manager.sweep(T0 + DISCONNECT_GRACE_MS + 1);
    expect(events.memberTimeouts).toEqual([{ roomCode: room.code, memberId: joined.member.id }]);
    expect(room.members.has(joined.member.id)).toBe(false);
  });
});

describe('GC des rooms', () => {
  it('supprime une room vide depuis plus de ROOM_EMPTY_TTL_MS', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.leave(room.code, member.id, T0);
    expect(manager.sweep(T0 + ROOM_EMPTY_TTL_MS - 1).closedRooms).toHaveLength(0);
    expect(manager.sweep(T0 + ROOM_EMPTY_TTL_MS + 1).closedRooms).toEqual([room.code]);
    expect(manager.rooms.size).toBe(0);
  });

  it('on peut encore rejoindre une room vide avant le TTL', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.leave(room.code, member.id, T0);
    const res = manager.joinRoom(room.code, 'Bravo 2', SIDC, 's2', T0 + 60_000);
    expect(res.ok).toBe(true);
    expect(room.emptySince).toBeNull();
  });

  it('supprime une room au-delà de la durée de vie max, même occupée', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const events = manager.sweep(T0 + ROOM_MAX_AGE_MS + 1);
    expect(events.closedRooms).toEqual([room.code]);
  });
});

describe('throttle des positions', () => {
  it('rejette les fixes trop rapprochés et garde le dernier accepté', () => {
    const manager = new RoomManager();
    const { member } = createdRoom(manager);
    const fix = (ts: number) => ({ lat: 45, lng: 5, accuracy: 10, heading: null, speed: null, ts });

    expect(manager.acceptPosition(member, fix(T0), T0)).toBe(true);
    expect(manager.acceptPosition(member, fix(T0 + 500), T0 + 500)).toBe(false);
    expect(manager.acceptPosition(member, fix(T0 + 1000), T0 + 1000)).toBe(true);
    expect(member.lastPosition?.ts).toBe(T0 + 1000);
  });
});
