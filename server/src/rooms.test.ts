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
  it('produit des codes de longueur ROOM_CODE_LENGTH dans l’alphabet radio', () => {
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

  it('rejette un indicatif tenu par un membre connecté', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const res = manager.joinRoom(room.code, 'alpha 1', SIDC, 's2', T0);
    expect(res).toEqual({ ok: false, error: 'CALLSIGN_TAKEN' });
  });

  it('signale (sans remplacer) un indicatif tenu par un membre déconnecté', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    const res = manager.joinRoom(room.code, 'alpha 1', SIDC, 's2', T0 + 2000);
    expect(res).toEqual({ ok: false, error: 'CALLSIGN_TAKEN_DISCONNECTED' });
    expect(room.members.size).toBe(1); // le fantôme n'est pas touché
  });

  it('remplace un indicatif déconnecté quand replace=true (évince le fantôme)', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    const res = manager.joinRoom(room.code, 'Alpha 1', SIDC, 's2', T0 + 2000, true);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.replacedMemberId).toBe(member.id);
      expect(res.member.id).not.toBe(member.id);
      expect(res.member.connected).toBe(true);
    }
    expect(room.members.size).toBe(1); // l'ancien évincé, le nouveau à sa place
    expect(room.members.has(member.id)).toBe(false);
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

describe('administration', () => {
  it('closeRoom supprime la room et signale l’absence', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    expect(manager.closeRoom(room.code)).toBe(true);
    expect(manager.rooms.has(room.code)).toBe(false);
    expect(manager.closeRoom(room.code)).toBe(false);
  });

  it('extendRoom remet createdAt à maintenant et repousse l’expiration', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const later = T0 + ROOM_MAX_AGE_MS - 1000;
    expect(manager.extendRoom(room.code, later)).toBe(true);
    expect(room.createdAt).toBe(later);
    // Occupée par un membre connecté → pas en compte à rebours "vide".
    expect(room.emptySince).toBeNull();
    expect(manager.extendRoom('ZZZZZ', later)).toBe(false);
  });

  it('extendRoom redémarre le compte à rebours "vide" si la room est vide', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0);
    const later = T0 + 10_000;
    manager.extendRoom(room.code, later);
    expect(room.emptySince).toBe(later);
  });

  it('kickMember retire le membre et renvoie son socketId', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const joined = manager.joinRoom(room.code, 'Bravo 2', SIDC, 'sock-b2', T0);
    if (isErr(joined)) throw new Error(joined.error);
    const removed = manager.kickMember(room.code, joined.member.id);
    expect(removed?.socketId).toBe('sock-b2');
    expect(room.members.has(joined.member.id)).toBe(false);
    expect(manager.kickMember(room.code, joined.member.id)).toBeNull();
  });

  it('summarize expose les rooms, l’effectif connecté et l’expiration', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    const joined = manager.joinRoom(room.code, 'Bravo 2', SIDC, 'sock-b2', T0);
    if (isErr(joined)) throw new Error(joined.error);
    manager.markDisconnected(room.code, joined.member.id, T0);
    const summary = manager.summarize(T0)[0]!;
    expect(summary.code).toBe(room.code);
    expect(summary.memberCount).toBe(2);
    expect(summary.connectedCount).toBe(1);
    expect(summary.expiresAt).toBe(room.createdAt + ROOM_MAX_AGE_MS);
    // Le chef remonte en tête de liste.
    expect(summary.members[0]!.id).toBe(member.id);
    expect(summary.members[0]!.isLeader).toBe(true);
  });
});
