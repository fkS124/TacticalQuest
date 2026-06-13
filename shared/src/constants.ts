// Limites et réglages partagés client/serveur.

// Sans 0/O/1/I/L : le code est destiné à être lu à la voix (radio).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export const MAX_ROOMS = 200;
export const MAX_MEMBERS_PER_ROOM = 40;

export const CALLSIGN_REGEX = /^[\p{L}\p{N} _-]{1,16}$/u;
// SIDC lettre (2525C, 10-15 car.) ou numérique (APP-6D, 20-30 chiffres).
// Le serveur ne l'interprète pas, il borne juste le format.
export const SIDC_REGEX = /^[A-Za-z0-9*-]{10,30}$/;
export const DEFAULT_SIDC = 'SFGPUCI----'; // infanterie amie

// Reconnexion : un membre déconnecté est conservé pendant la période de
// grâce (re-binding via sessionToken) et reste visible en grisé par les
// autres. 20 min : un téléphone en veille ou en zone blanche ne disparaît
// pas de la situation tactique.
export const DISCONNECT_GRACE_MS = 20 * 60_000;
// Doit dépasser la grâce, sinon la room serait GC avant ses membres.
export const ROOM_EMPTY_TTL_MS = 30 * 60_000;
export const ROOM_MAX_AGE_MS = 24 * 60 * 60_000;
export const GC_INTERVAL_MS = 60_000;

// Anti-abus.
export const POSITION_MIN_INTERVAL_MS = 900;
export const ROOM_CREATE_PER_IP_PER_HOUR = 10;
export const FAILED_JOIN_DELAY_MS = 1_000;

// Ordres (phase 5 — le serveur les relaie sans les interpréter).
export const MAX_RECENT_ORDERS = 50;
export const MAX_ORDER_BYTES = 16_384;

// Côté client : throttle d'envoi des positions.
export const POSITION_SEND_INTERVAL_MS = 3_000;
export const POSITION_KEEPALIVE_MS = 30_000;
export const POSITION_MIN_DISTANCE_M = 5;
export const POSITION_MIN_HEADING_DEG = 15;
export const STALE_AFTER_MS = 30_000;
