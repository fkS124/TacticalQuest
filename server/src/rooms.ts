import { randomBytes, randomUUID } from 'node:crypto';
import {
  DISCONNECT_GRACE_MS,
  MAX_MEMBERS_PER_ROOM,
  MAX_RECENT_ORDERS,
  MAX_ROOMS,
  POSITION_MIN_INTERVAL_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_EMPTY_TTL_MS,
  ROOM_MAX_AGE_MS,
} from '@tq/shared/constants';
import type {
  ErrorCode,
  MemberPublic,
  OrderMessage,
  Position,
  RoomState,
} from '@tq/shared/protocol';

export interface Member {
  id: string;
  /** Secret de re-binding — jamais exposé dans MemberPublic. */
  sessionToken: string;
  callsign: string;
  sidc: string;
  isLeader: boolean;
  connected: boolean;
  lastSeen: number;
  lastPosition: Position | null;
  socketId: string | null;
  lastPositionAcceptedAt: number;
}

export interface Room {
  code: string;
  createdAt: number;
  /** Instant où la room a perdu son dernier membre connecté, null sinon. */
  emptySince: number | null;
  members: Map<string, Member>;
  recentOrders: OrderMessage[];
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ErrorCode };

/**
 * Garde de type vers la branche d'échec. On ne se repose PAS sur le
 * rétrécissement de `if (!res.ok)` : soustraire le membre par intersection
 * `{ ok: true } & T` d'une union échoue selon la version de TypeScript (OK en
 * local, KO sur d'autres builds — ex. Vercel). Un prédicat explicite narrow de
 * façon fiable partout.
 */
export function isErr<T>(r: Result<T>): r is { ok: false; error: ErrorCode } {
  return !r.ok;
}

export interface SweepEvents {
  /** Membres dont la période de grâce a expiré. */
  memberTimeouts: { roomCode: string; memberId: string }[];
  /** Rooms supprimées (vides trop longtemps ou trop vieilles). */
  closedRooms: string[];
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  createRoom(callsign: string, sidc: string, socketId: string, now = Date.now()): Result<{ room: Room; member: Member }> {
    if (this.rooms.size >= MAX_ROOMS) return { ok: false, error: 'SERVER_FULL' };
    const room: Room = {
      code: this.generateCode(),
      createdAt: now,
      emptySince: null,
      members: new Map(),
      recentOrders: [],
    };
    this.rooms.set(room.code, room);
    const member = this.addMember(room, callsign, sidc, socketId, true, now);
    return { ok: true, room, member };
  }

  joinRoom(
    code: string,
    callsign: string,
    sidc: string,
    socketId: string,
    now = Date.now(),
    replace = false,
  ): Result<{ room: Room; member: Member; replacedMemberId?: string }> {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    const existing = [...room.members.values()].find(
      (m) => m.callsign.toLowerCase() === callsign.toLowerCase(),
    );
    let replacedMemberId: string | undefined;
    if (existing) {
      // Connecté : indicatif réellement occupé, refus net.
      if (existing.connected) return { ok: false, error: 'CALLSIGN_TAKEN' };
      // Déconnecté : remplaçable, mais seulement sur confirmation explicite.
      if (!replace) return { ok: false, error: 'CALLSIGN_TAKEN_DISCONNECTED' };
      room.members.delete(existing.id); // évince le fantôme, libère une place
      replacedMemberId = existing.id;
    }
    if (room.members.size >= MAX_MEMBERS_PER_ROOM) return { ok: false, error: 'ROOM_FULL' };
    const member = this.addMember(room, callsign, sidc, socketId, false, now);
    return { ok: true, room, member, replacedMemberId };
  }

  rejoin(code: string, memberId: string, sessionToken: string, socketId: string, now = Date.now()): Result<{ room: Room; member: Member }> {
    const room = this.rooms.get(code);
    const member = room?.members.get(memberId);
    if (!room || !member || member.sessionToken !== sessionToken) {
      return { ok: false, error: 'SESSION_INVALID' };
    }
    member.connected = true;
    member.socketId = socketId;
    member.lastSeen = now;
    room.emptySince = null;
    return { ok: true, room, member };
  }

  /** Déconnexion socket : le membre reste en grâce (DISCONNECT_GRACE_MS). */
  markDisconnected(code: string, memberId: string, now = Date.now()): Member | null {
    const room = this.rooms.get(code);
    const member = room?.members.get(memberId);
    if (!room || !member) return null;
    member.connected = false;
    member.socketId = null;
    member.lastSeen = now;
    this.refreshEmptySince(room, now);
    return member;
  }

  /** Départ explicite : suppression immédiate, pas de grâce. */
  leave(code: string, memberId: string, now = Date.now()): boolean {
    const room = this.rooms.get(code);
    if (!room || !room.members.delete(memberId)) return false;
    this.refreshEmptySince(room, now);
    return true;
  }

  /** Throttle serveur des positions. Retourne false si le fix est rejeté. */
  acceptPosition(member: Member, position: Position, now = Date.now()): boolean {
    if (now - member.lastPositionAcceptedAt < POSITION_MIN_INTERVAL_MS) return false;
    member.lastPositionAcceptedAt = now;
    member.lastPosition = position;
    member.lastSeen = now;
    return true;
  }

  pushOrder(room: Room, order: OrderMessage): void {
    room.recentOrders.push(order);
    if (room.recentOrders.length > MAX_RECENT_ORDERS) room.recentOrders.shift();
  }

  /** GC périodique : grâce des membres, rooms vides, durée de vie max. */
  sweep(now = Date.now()): SweepEvents {
    const events: SweepEvents = { memberTimeouts: [], closedRooms: [] };
    for (const room of this.rooms.values()) {
      for (const member of room.members.values()) {
        if (!member.connected && now - member.lastSeen > DISCONNECT_GRACE_MS) {
          room.members.delete(member.id);
          events.memberTimeouts.push({ roomCode: room.code, memberId: member.id });
        }
      }
      this.refreshEmptySince(room, now);
      const emptyTooLong =
        room.emptySince !== null && now - room.emptySince > ROOM_EMPTY_TTL_MS;
      const tooOld = now - room.createdAt > ROOM_MAX_AGE_MS;
      if (emptyTooLong || tooOld) {
        this.rooms.delete(room.code);
        events.closedRooms.push(room.code);
      }
    }
    return events;
  }

  memberPublic(m: Member): MemberPublic {
    return {
      id: m.id,
      callsign: m.callsign,
      sidc: m.sidc,
      isLeader: m.isLeader,
      connected: m.connected,
      lastSeen: m.lastSeen,
      lastPosition: m.lastPosition,
    };
  }

  roomState(room: Room): RoomState {
    return {
      code: room.code,
      members: [...room.members.values()].map((m) => this.memberPublic(m)),
      recentOrders: room.recentOrders,
    };
  }

  private addMember(
    room: Room,
    callsign: string,
    sidc: string,
    socketId: string,
    isLeader: boolean,
    now: number,
  ): Member {
    const member: Member = {
      id: randomUUID(),
      sessionToken: randomBytes(16).toString('hex'),
      callsign,
      sidc,
      isLeader,
      connected: true,
      lastSeen: now,
      lastPosition: null,
      socketId,
      lastPositionAcceptedAt: 0,
    };
    room.members.set(member.id, member);
    room.emptySince = null;
    return member;
  }

  private refreshEmptySince(room: Room, now: number): void {
    const hasConnected = [...room.members.values()].some((m) => m.connected);
    if (hasConnected) room.emptySince = null;
    else if (room.emptySince === null) room.emptySince = now;
  }

  private generateCode(): string {
    for (;;) {
      let code = '';
      const bytes = randomBytes(ROOM_CODE_LENGTH);
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
  }
}
