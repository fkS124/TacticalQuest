import type { MissionType, OrderMessage } from '@tq/shared/protocol';

export type MissionStatus = 'pending' | 'ack' | 'done';

export interface MissionView {
  id: string;
  authorId: string;
  ts: number;
  type: MissionType;
  lat: number;
  lng: number;
  assignee: string;
  removed: boolean;
  status: MissionStatus;
  /** Horodatage du dernier changement d'état (création si pending). */
  statusTs: number;
}

export interface MissionDef {
  label: string;
  /** Étiquette courte sur la carte. */
  short: string;
  /** Couleur d'accent de la mission (distincte des liserés). */
  color: string;
  /** SVG (stroke=currentColor) pour bouton et marqueur. */
  icon: string;
}

const ICON = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// Glyphes inspirés des symboles de tâche tactique APP-6 (mesures de coordination
// d'objectif). À l'échelle d'une icône de 24 px on en garde la silhouette
// caractéristique : « X » de neutralisation, étoile d'éclatement de destruction,
// lettres C/S des tâches de sûreté (couvrir/éclairer), barre d'interdiction, etc.
export const MISSION_DEFS: Record<MissionType, MissionDef> = {
  seize: {
    label: "S'emparer de",
    short: 'EMPARER',
    color: '#e0533f',
    // Flèche encerclant l'objectif (point central à saisir).
    icon: ICON('<path d="M20 12a8 8 0 1 1-3.2-6.4"/><path d="M20 4.5v4.5h-4.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>'),
  },
  support: {
    label: 'Appuyer',
    short: 'APPUI',
    color: '#e8804a',
    // Appui (par le feu) : deux flèches convergentes vers l'objectif.
    icon: ICON('<path d="M4 15l7-7"/><path d="M6 7.5h5v5"/><path d="M9 20l7-7"/><path d="M11 12.5h5v5"/>'),
  },
  cover: {
    label: 'Couvrir',
    short: 'COUVRIR',
    color: '#4fb0a0',
    // Tâche de sûreté « Couvrir » : lettre C.
    icon: ICON('<path d="M18 7.6a8 8 0 1 0 0 8.8"/>'),
  },
  interdict: {
    label: 'Interdire',
    short: 'INTERD',
    color: '#4f9dd9',
    // Axe interdit : flèche butant sur une barre.
    icon: ICON('<path d="M12 21V8"/><path d="M7.5 12.5L12 8l4.5 4.5"/><path d="M5 4.5h14"/>'),
  },
  destroy: {
    label: 'Détruire',
    short: 'DETRUIRE',
    color: '#c0392b',
    // Éclatement (destruction).
    icon: ICON('<path d="M12 2.5v19M2.5 12h19M5.4 5.4l13.2 13.2M18.6 5.4L5.4 18.6"/>'),
  },
  neutralize: {
    label: 'Neutraliser',
    short: 'NEUTRA',
    color: '#d65db1',
    // Croix de neutralisation.
    icon: ICON('<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>'),
  },
  recon: {
    label: 'Reconnaître',
    short: 'RECO',
    color: '#e0a13a',
    icon: ICON('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  },
  screen: {
    label: 'Éclairer',
    short: 'ECLAIRER',
    color: '#7bc043',
    // Tâche de sûreté « Éclairer » (screen) : lettre S.
    icon: ICON('<path d="M16.5 7.5C15 6 13.4 5.5 12 5.5c-2.2 0-3.8 1.1-3.8 2.7 0 1.6 1.6 2.3 3.8 2.6s3.8 1 3.8 2.6-1.6 2.7-3.8 2.7c-1.4 0-3-.6-4.5-2"/>'),
  },
  hold: {
    label: 'Tenir',
    short: 'TENIR',
    color: '#6a7fd0',
    icon: ICON('<path d="M12 3l7 3v5c0 4.3-3 7.5-7 9-4-1.5-7-4.7-7-9V6z"/>'),
  },
};

export const MISSION_ORDER: MissionType[] = [
  'seize',
  'support',
  'cover',
  'interdict',
  'destroy',
  'neutralize',
  'recon',
  'screen',
  'hold',
];

/** Reconstruit l'état de chaque mission à partir du flux d'ordres. */
export function deriveMissions(orders: Map<string, OrderMessage>): MissionView[] {
  const removed = new Set<string>();
  const latestStatus = new Map<string, { status: 'ack' | 'done'; ts: number }>();

  for (const o of orders.values()) {
    if (o.payload.kind === 'remove') removed.add(o.payload.orderId);
    else if (o.payload.kind === 'mission_status') {
      const cur = latestStatus.get(o.payload.missionId);
      if (!cur || o.ts >= cur.ts) latestStatus.set(o.payload.missionId, { status: o.payload.status, ts: o.ts });
    }
  }

  const out: MissionView[] = [];
  for (const o of orders.values()) {
    if (o.payload.kind !== 'mission') continue;
    const st = latestStatus.get(o.id);
    out.push({
      id: o.id,
      authorId: o.authorId,
      ts: o.ts,
      type: o.payload.missionType,
      lat: o.payload.lat,
      lng: o.payload.lng,
      assignee: o.payload.assignee,
      removed: removed.has(o.id),
      status: st ? st.status : 'pending',
      statusTs: st ? st.ts : o.ts,
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * Une mission reste visible sur la carte tant que le chef ne l'a pas clôturée
 * (ordre `remove`). Une mission remplie (`done`) demeure donc affichée — c'est au
 * chef de la faire disparaître, pour qu'aucune mission ne soit close sans qu'il
 * l'ait vue.
 */
export function isActive(m: MissionView): boolean {
  return !m.removed;
}

export const STATUS_LABEL: Record<MissionStatus, string> = {
  pending: 'Aperçu attendu',
  ack: 'En cours',
  done: 'Remplie',
};
