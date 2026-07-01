import L from 'leaflet';
import ms from 'milsymbol';
import { escapeHtml } from '../util';

// Symbologie dérivée du poste dans l'arbre de commandement (cf. ROLE_REGEX) :
//   CDU / CDS / CDG → cadre rond (équipement) + sigle noir au centre.
//   CDE        → fantassin (rectangle barré par les diagonales) + un point bleu au-dessus.
//   GV         → fantassin seul.
// Le numéro (désignation 10 / 22 / 22A) est posé en bas à droite du figuré ; il
// est vide pour le CDU et les GV. Point et numéro sont des overlays HTML dans un
// `.tq-figure` (pas besoin de recalculer viewBox/anchor de milsymbol), donc rendus
// à l'identique sur la carte et dans les aperçus (accueil, roster).

export type RoleKind = 'CDU' | 'CDS' | 'CDG' | 'CDE' | 'GV';

export interface ParsedRole {
  kind: RoleKind;
  section?: number; // 1..3
  group?: number; // 1..3
  team?: 'A' | 'B';
  /** Désignation affichée (10 / 22 / 22A) ; vide pour CDU et GV. */
  designation: string;
}

/** Niveaux de l'arbre, dans l'ordre hiérarchique (sélecteur d'accueil). */
export const ROLE_KINDS: { kind: RoleKind; full: string }[] = [
  { kind: 'CDU', full: "Commandant d'unité" },
  { kind: 'CDS', full: 'Chef de section' },
  { kind: 'CDG', full: 'Chef de groupe' },
  { kind: 'CDE', full: "Chef d'équipe" },
  { kind: 'GV', full: 'Grenadier-voltigeur' },
];

// SIDC milsymbol par figuré (identité amie → cadre bleu).
const KIND_SIDC: Record<RoleKind, string> = {
  CDU: 'SFGPE--------A--',
  CDS: 'SFGPE----------',
  CDG: 'SFGPE----------',
  CDE: 'SFGPUCI--------',
  GV: 'SFGPUCI--------',
};

// Sigle noir inscrit au centre du cadre rond (CDU / CDS / CDG).
const KIND_SIGLE: Partial<Record<RoleKind, string>> = { CDU: 'CDU', CDS: 'CDS', CDG: 'CDG' };

/** Décompose un `role` canonique en figuré + désignation. */
export function parseRole(role: string): ParsedRole {
  const [kind, ...rest] = role.split(':') as [RoleKind, ...string[]];
  switch (kind) {
    case 'CDS': {
      const s = Number(rest[0]);
      return { kind, section: s, designation: String(s * 10) };
    }
    case 'CDG': {
      const s = Number(rest[0]);
      const g = Number(rest[1]);
      return { kind, section: s, group: g, designation: `${s}${g}` };
    }
    case 'CDE': {
      const s = Number(rest[0]);
      const g = Number(rest[1]);
      const t = rest[2] as 'A' | 'B';
      return { kind, section: s, group: g, team: t, designation: `${s}${g}${t}` };
    }
    default:
      return { kind, designation: '' }; // CDU, GV : pas de numéro
  }
}

/** Numéro d'entité (10 / 22 / 22A) ; vide pour CDU et GV. */
export function roleDesignation(role: string): string {
  return parseRole(role).designation;
}

// Le repère interne de milsymbol place toujours le centre du cadre en (100, 100).
function withSigle(svg: string, kind: RoleKind): string {
  const sigle = KIND_SIGLE[kind];
  if (!sigle) return svg;
  const text =
    `<text x="100" y="100" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="monospace" font-weight="700" font-size="42" fill="#0a0a0a">${sigle}</text>`;
  return svg.replace('</svg>', `${text}</svg>`);
}

/** Enveloppe le SVG milsymbol avec le point bleu au-dessus du cadre (CDE). */
function wrapFigure(svg: string, kind: RoleKind): string {
  const dot = kind === 'CDE' ? '<i class="tq-dot"></i>' : '';
  return `<span class="tq-figure">${withSigle(svg, kind)}${dot}</span>`;
}

export interface IconOpts {
  /** Grisé tant que le membre n'est pas (re)connecté. */
  disconnected: boolean;
  self: boolean;
}

// Le rendu milsymbol n'est pas gratuit sur CPU faible : mémoïsation par
// combinaison role + état visuel.
const iconCache = new Map<string, L.DivIcon>();

export function getIcon(role: string, o: IconOpts): L.DivIcon {
  const key = `${role}|${o.disconnected ? 1 : 0}${o.self ? 1 : 0}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const { kind } = parseRole(role);
  const sym = new ms.Symbol(KIND_SIDC[kind], { size: o.self ? 32 : 28 });
  const { width, height } = sym.getSize();
  const anchor = sym.getAnchor();
  const classes = ['tq-sym'];
  if (o.disconnected) classes.push('is-disconnected');
  if (o.self) classes.push('is-self');

  const icon = L.divIcon({
    html: wrapFigure(sym.asSVG(), kind),
    className: classes.join(' '),
    iconSize: [width, height],
    iconAnchor: [anchor.x, anchor.y],
  });
  iconCache.set(key, icon);
  return icon;
}

/** Figuré (sans numéro) pour l'aperçu d'accueil et le roster. */
export function roleFigure(role: string, size = 26): string {
  return wrapFigure(new ms.Symbol(KIND_SIDC[parseRole(role).kind], { size }).asSVG(), parseRole(role).kind);
}

/** Figuré d'un niveau (boutons de niveau du sélecteur). */
export function kindFigure(kind: RoleKind, size = 26): string {
  return wrapFigure(new ms.Symbol(KIND_SIDC[kind], { size }).asSVG(), kind);
}

/** Losange rouge APP-6 : unité terrestre hostile, sans fonction. */
export const HOSTILE_SIDC = 'SHGP-------';

const plotCache = new Map<string, L.DivIcon>();

/**
 * Icône de plot (positions ennemies). Un `label` non vide est posé en étiquette
 * flottante à droite du symbole (pastille sombre lisible, cohérente avec les
 * autres libellés de l'app) — l'amplificateur natif milsymbol étant minuscule
 * et noir sans fond.
 */
export function getPlotIcon(sidc: string, label = ''): L.DivIcon {
  const key = `${sidc}|${label}`;
  const cached = plotCache.get(key);
  if (cached) return cached;
  const sym = new ms.Symbol(sidc, { size: 22 });
  const { width, height } = sym.getSize();
  const anchor = sym.getAnchor();
  const tag = label ? `<b class="tq-plot-label">${escapeHtml(label)}</b>` : '';
  const icon = L.divIcon({
    html: sym.asSVG() + tag,
    className: 'tq-sym tq-plot',
    iconSize: [width, height],
    iconAnchor: [anchor.x, anchor.y],
  });
  plotCache.set(key, icon);
  return icon;
}
