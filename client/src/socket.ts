import { io, type Socket } from 'socket.io-client';
import type {
  Ack,
  ClientToServerEvents,
  JoinedRoom,
  OrderMessage,
  Position,
  RoomState,
  ServerToClientEvents,
} from '@tq/shared/protocol';
import { applyRoomState, bus, clearSession, setConn, state } from './state';

const ACK_TIMEOUT_MS = 10_000;

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: false,
  reconnectionDelayMax: 5_000,
});

// --- événements room → état local ---

socket.on('room_state', applyRoomState);

socket.on('member_joined', ({ member }) => {
  state.members.set(member.id, member);
  bus.emit('members');
});

socket.on('member_left', ({ memberId }) => {
  state.members.delete(memberId);
  bus.emit('members');
});

socket.on('member_position', ({ memberId, position }) => {
  const m = state.members.get(memberId);
  if (!m) return;
  m.lastPosition = position;
  m.lastSeen = Date.now();
  bus.emit('position', memberId);
});

socket.on('member_updated', ({ memberId, sidc, connected }) => {
  const m = state.members.get(memberId);
  if (!m) return;
  if (sidc !== undefined) m.sidc = sidc;
  if (connected !== undefined) {
    m.connected = connected;
    m.lastSeen = Date.now();
  }
  bus.emit('members');
});

socket.on('order', (o) => {
  state.orders.set(o.id, o);
  bus.emit('orders');
});

socket.on('room_closed', () => {
  clearSession();
  bus.emit('session-lost', 'La salle a expiré.');
});

// --- cycle de connexion ---

socket.on('connect', () => {
  if (state.session) void rejoin();
  else setConn('connected');
});

socket.on('disconnect', () => setConn('reconnecting'));
socket.io.on('reconnect_failed', () => setConn('offline'));

async function rejoin(): Promise<void> {
  const s = state.session;
  if (!s) return;
  try {
    const res = await socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck('rejoin_room', {
        roomCode: s.roomCode,
        memberId: s.memberId,
        sessionToken: s.sessionToken,
      });
    if (res.ok) {
      applyRoomState(res.roomState);
      setConn('connected');
      bus.emit('rejoined');
    } else {
      // Room GC côté serveur : la session ne reviendra pas.
      clearSession();
      bus.emit('session-lost', 'La salle n’existe plus.');
    }
  } catch {
    // Timeout d'ack : Socket.IO va retenter la connexion, on réessaiera.
  }
}

function ensureConnected(): void {
  if (!socket.connected) socket.connect();
}

export async function createRoom(callsign: string, sidc: string): Promise<Ack<JoinedRoom>> {
  ensureConnected();
  return socket.timeout(ACK_TIMEOUT_MS).emitWithAck('create_room', { callsign, sidc });
}

export async function joinRoom(
  roomCode: string,
  callsign: string,
  sidc: string,
): Promise<Ack<JoinedRoom>> {
  ensureConnected();
  return socket.timeout(ACK_TIMEOUT_MS).emitWithAck('join_room', { roomCode, callsign, sidc });
}

export function connectForSession(): void {
  ensureConnected();
}

export function sendPosition(p: Position): boolean {
  if (!socket.connected || !state.session) return false;
  socket.emit('position_update', p);
  return true;
}

/** Envoie un ordre ; en cas de succès, l'ajoute aussi à l'état local
 *  (le serveur ne renvoie pas les ordres à leur auteur). */
export async function sendOrder(o: OrderMessage): Promise<boolean> {
  if (!socket.connected || !state.session) return false;
  try {
    const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('send_order', o);
    if (!res.ok) return false;
    state.orders.set(o.id, o);
    bus.emit('orders');
    return true;
  } catch {
    return false;
  }
}

export function sendSymbol(sidc: string): void {
  if (socket.connected) socket.emit('update_symbol', { sidc });
}

export function leaveRoom(): void {
  if (socket.connected) socket.emit('leave_room');
  clearSession();
  socket.disconnect();
}

export type { RoomState };
