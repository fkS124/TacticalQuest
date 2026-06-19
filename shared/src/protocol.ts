// Source de vérité unique pour tout ce qui transite sur le réseau.
// Client et serveur typent leurs sockets contre ces interfaces.

export interface Position {
  lat: number;
  lng: number;
  /** Précision GPS en mètres. */
  accuracy: number;
  /** Cap en degrés (0 = nord), null si indisponible. */
  heading: number | null;
  /** Vitesse en m/s, null si indisponible. */
  speed: number | null;
  /** Horodatage du fix (epoch ms, horloge du client émetteur). */
  ts: number;
}

export interface MemberPublic {
  id: string;
  callsign: string;
  /** Code symbole APP-6 / 2525C (milsymbol). */
  sidc: string;
  isLeader: boolean;
  connected: boolean;
  /** Dernière activité vue par le serveur (epoch ms serveur). */
  lastSeen: number;
  lastPosition: Position | null;
}

export interface RoomState {
  code: string;
  members: MemberPublic[];
  /** Vide en MVP ; les retardataires recevront les ordres par ce champ. */
  recentOrders: OrderMessage[];
}

// ---------------------------------------------------------------------------
// Ordres (phase 5) — enveloppe générique, jamais interprétée par le serveur.
// Un nouveau `kind` est un changement client uniquement.
// ---------------------------------------------------------------------------

export interface GraphicStyle {
  color?: string;
  weight?: number;
  dashArray?: string;
  /** Pointe de flèche en bout de ligne (axe d'effort, direction). */
  arrow?: boolean;
}

/** Tâches tactiques transmissibles (ordres rapides). */
export type MissionType =
  | 'seize' // S'emparer de
  | 'support' // Appuyer
  | 'cover' // Couvrir
  | 'interdict' // Interdire
  | 'destroy' // Détruire
  | 'neutralize' // Neutraliser
  | 'recon' // Reconnaître
  | 'screen' // Éclairer
  | 'hold'; // Tenir

export type OrderPayload =
  | { kind: 'text'; body: string }
  | { kind: 'waypoint'; name: string; lat: number; lng: number; sidc?: string }
  | { kind: 'graphic'; geojson: unknown; style?: GraphicStyle }
  | { kind: 'remove'; orderId: string }
  | { kind: 'ack'; orderId: string }
  // Ordre de mission assigné à un membre, ancré sur un point de la carte.
  | { kind: 'mission'; missionType: MissionType; lat: number; lng: number; assignee: string }
  // Évolution d'état d'une mission (accusé de réception, mission remplie).
  | { kind: 'mission_status'; missionId: string; status: 'ack' | 'done' };

export interface OrderMessage {
  /** uuid généré côté client (ré-émission idempotente). */
  id: string;
  authorId: string;
  ts: number;
  kind: OrderPayload['kind'];
  payload: OrderPayload;
}

// ---------------------------------------------------------------------------
// Acks et erreurs
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'CALLSIGN_TAKEN'
  | 'ROOM_FULL'
  | 'SERVER_FULL'
  | 'SESSION_INVALID'
  | 'INVALID_PAYLOAD'
  | 'RATE_LIMITED'
  | 'NOT_IN_ROOM';

export type Ack<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: ErrorCode };

export interface JoinedRoom {
  roomCode: string;
  memberId: string;
  /** Secret de re-binding après reconnexion. Jamais diffusé aux autres. */
  sessionToken: string;
  roomState: RoomState;
}

// ---------------------------------------------------------------------------
// Événements Socket.IO
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  create_room: (
    p: { callsign: string; sidc: string },
    ack: (res: Ack<JoinedRoom>) => void,
  ) => void;
  join_room: (
    p: { roomCode: string; callsign: string; sidc: string },
    ack: (res: Ack<JoinedRoom>) => void,
  ) => void;
  rejoin_room: (
    p: { roomCode: string; memberId: string; sessionToken: string },
    ack: (res: Ack<{ roomState: RoomState }>) => void,
  ) => void;
  /** Fire-and-forget, throttlé serveur (POSITION_MIN_INTERVAL_MS). */
  position_update: (p: Position) => void;
  update_symbol: (p: { sidc: string }) => void;
  leave_room: () => void;
  send_order: (p: OrderMessage, ack: (res: Ack) => void) => void;
}

export interface ServerToClientEvents {
  /** Snapshot complet — réconciliation sans diff au (re)join. */
  room_state: (s: RoomState) => void;
  member_joined: (p: { member: MemberPublic }) => void;
  member_left: (p: { memberId: string; reason: 'left' | 'timeout' }) => void;
  member_position: (p: { memberId: string; position: Position }) => void;
  member_updated: (p: { memberId: string; sidc?: string; connected?: boolean }) => void;
  room_closed: (p: { reason: 'expired' }) => void;
  order: (o: OrderMessage) => void;
}
