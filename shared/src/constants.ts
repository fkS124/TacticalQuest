// Limites et réglages partagés client/serveur.

// Sans 0/O/1/I/L : le code est destiné à être lu à la voix (radio).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

export const MAX_ROOMS = 200;
export const MAX_MEMBERS_PER_ROOM = 40;

export const CALLSIGN_REGEX = /^[\p{L}\p{N} _-]{1,16}$/u;
// SIDC lettre (2525C, 10-15 car.) ou numérique (APP-6D, 20-30 chiffres).
// Le serveur ne l'interprète pas, il borne juste le format. Toujours utilisé
// pour valider le SIDC des plots ENI (cf. orders.ts, HOSTILE_SIDC).
export const SIDC_REGEX = /^[A-Za-z0-9*-]{10,30}$/;
export const DEFAULT_SIDC = 'SFGPE----------'; // CDS (rond, chef de section)

// Rôle d'un membre dans l'arbre hiérarchique de commandement :
//   CDU (unité) > CDS:S (section 1-3) > CDG:S:G (groupe 1-3) >
//   CDE:S:G:T (équipe A/B) > GV (grenadier-voltigeur, non contraint).
// Le client dérive de cette chaîne le figuré ET la désignation (10/22/22A).
// Le serveur borne le format et impose l'unicité des postes (sauf GV).
export const ROLE_REGEX = /^(CDU|GV|CDS:[1-3]|CDG:[1-3]:[1-3]|CDE:[1-3]:[1-3]:[AB])$/;
export const DEFAULT_ROLE = 'CDS:1'; // section 10, choix par défaut

export const ROOM_MAX_AGE_MS = 24 * 60 * 60_000;
// Reconnexion : un membre déconnecté est conservé pendant la période de grâce
// (re-binding via sessionToken) et reste visible en grisé par les autres. On la
// cale sur la durée de vie de la room : un téléphone mis en veille des heures,
// en zone blanche ou dont la PWA a été tuée par l'OS retrouve sa place tant que
// la room existe. Au-delà, la room elle-même a disparu, donc rien à rejoindre.
export const DISCONNECT_GRACE_MS = ROOM_MAX_AGE_MS;
// Doit être ≥ à la grâce, sinon la room serait GC avant ses membres.
export const ROOM_EMPTY_TTL_MS = ROOM_MAX_AGE_MS;
export const GC_INTERVAL_MS = 60_000;

// Anti-abus.
export const POSITION_MIN_INTERVAL_MS = 900;
export const ROOM_CREATE_PER_IP_PER_HOUR = 10;
export const FAILED_JOIN_DELAY_MS = 1_000;

// Console d'admin : verrouillage par IP après trop d'échecs d'authentification
// (anti brute-force du code admin). Au-delà du seuil dans la fenêtre, l'IP est
// rejetée (429) jusqu'à expiration de la fenêtre glissante.
export const ADMIN_AUTH_MAX_FAILS = 8;
export const ADMIN_AUTH_WINDOW_MS = 15 * 60_000;

// Ordres (phase 5 — le serveur les relaie sans les interpréter).
// Missions + accusés de réception s'accumulent : marge confortable.
export const MAX_RECENT_ORDERS = 250;
export const MAX_ORDER_BYTES = 16_384;

// Côté client : cadence d'échantillonnage de la position. Volontairement lente
// et en basse précision (récepteur GPS éteint entre deux fixes) — les batteries
// sont comptées sur le terrain. Un point dès l'arrivée sur le site, puis un
// point toutes les 30 s tant que la page est au premier plan (la géoloc écran
// verrouillé a été abandonnée).
export const POSITION_INTERVAL_MS = 30_000;
