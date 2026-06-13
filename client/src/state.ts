import type { MemberPublic, OrderMessage, RoomState } from '@tq/shared/protocol';

export interface Session {
  roomCode: string;
  memberId: string;
  sessionToken: string;
  callsign: string;
  sidc: string;
  isLeader: boolean;
}

export type ConnStatus = 'connected' | 'reconnecting' | 'offline';

export type BusEvent =
  | 'members' // roster ou attributs d'un membre modifiés
  | 'position' // une position a bougé (détail: memberId)
  | 'orders' // ordre reçu/ajouté (graphiques, waypoints…)
  | 'coordfmt' // format de coordonnées changé (MGRS/UTM/géo)
  | 'conn'
  | 'rejoined' // re-binding réussi après coupure
  | 'session-lost'; // room GC côté serveur → retour accueil

type Listener = (detail?: unknown) => void;

const listeners = new Map<BusEvent, Set<Listener>>();

export const bus = {
  on(event: BusEvent, fn: Listener): void {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
  },
  emit(event: BusEvent, detail?: unknown): void {
    listeners.get(event)?.forEach((fn) => fn(detail));
  },
};

export const state = {
  session: null as Session | null,
  members: new Map<string, MemberPublic>(),
  orders: new Map<string, OrderMessage>(),
  conn: 'reconnecting' as ConnStatus,
};

const SESSION_KEY = 'tq-session';

export function saveSession(s: Session): void {
  state.session = s;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    state.session = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    state.session = null;
  }
  return state.session;
}

export function clearSession(): void {
  state.session = null;
  state.members.clear();
  state.orders.clear();
  sessionStorage.removeItem(SESSION_KEY);
}

/** Applique un snapshot complet — réconciliation sans diff. */
export function applyRoomState(rs: RoomState): void {
  state.members = new Map(rs.members.map((m) => [m.id, m]));
  state.orders = new Map(rs.recentOrders.map((o) => [o.id, o]));
  bus.emit('members');
  bus.emit('orders');
}

export function setConn(c: ConnStatus): void {
  if (state.conn === c) return;
  state.conn = c;
  bus.emit('conn', c);
}
