import L from 'leaflet';
import ms from 'milsymbol';
import { escapeHtml } from '../util';

// Choix proposés dans le sélecteur (2525C, identité amie → cadre bleu).
// Cadre rond (équipement, `…E……`) pour les postes de commandement CDS / CDU,
// cadre rectangle (unité, `…U……`) pour les éléments GCT / SCT. Le sigle est
// dessiné AU CENTRE du cadre (voir `decorateUnit`), et l'échelon (positions
// 11-12) ajoute les points bleus au-dessus des rectangles : section (C,
// 2 points) pour GCT, peloton (D, 3 points) pour SCT. Les ronds n'ont pas
// d'échelon. CDS / CDU sont deux ronds identiques au cadre près : on les
// distingue par un champ inerte du SIDC (indicatif de pays, non rendu).
export const SYMBOL_CHOICES: { sidc: string; label: string }[] = [
  { sidc: 'SFGPE----------', label: 'CDS' }, // rond — chef de section
  { sidc: 'SFGPE--------A--', label: 'CDU' }, // rond — commandant d'unité
  { sidc: 'SFGPU------C---', label: 'GCT' }, // rectangle + 2 points — groupe de combat
  { sidc: 'SFGPU------D---', label: 'SCT' }, // rectangle + 3 points — section
];

// SIDC → sigle à inscrire dans le cadre.
const UNIT_LABELS = new Map(SYMBOL_CHOICES.map((c) => [c.sidc, c.label]));

// Bleu ami milsymbol (remplissage des cadres) — réutilisé pour les points
// d'échelon, noirs par défaut, afin de respecter « garder le bleu ».
const FRIENDLY_BLUE = 'rgb(128,224,255)';

/**
 * Post-traite le SVG milsymbol d'une unité connue : recolore en bleu les points
 * d'échelon (noirs à l'origine) et inscrit le sigle au centre du cadre. Le
 * repère interne de milsymbol place toujours le centre du cadre en (100, 100),
 * quel que soit le `viewBox`. Sans correspondance, le SVG est renvoyé tel quel.
 */
function decorateUnit(svg: string, sidc: string): string {
  const label = UNIT_LABELS.get(sidc);
  if (!label) return svg;
  // Les seuls éléments noirs de ces symboles (fonction vide) sont les points
  // d'échelon : on peut donc recolorer sans toucher au cadre ni au tracé.
  const blue = svg.replace(/fill="black"/g, `fill="${FRIENDLY_BLUE}"`);
  const text =
    `<text x="100" y="100" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="monospace" font-weight="700" font-size="42" fill="#0a0a0a">${label}</text>`;
  return blue.replace('</svg>', `${text}</svg>`);
}

export interface IconOpts {
  /** Grisé tant que le membre n'est pas (re)connecté. */
  disconnected: boolean;
  self: boolean;
}

// Le rendu milsymbol n'est pas gratuit sur CPU faible : mémoïsation par
// combinaison sidc + état visuel.
const iconCache = new Map<string, L.DivIcon>();

export function getIcon(sidc: string, o: IconOpts): L.DivIcon {
  const key = `${sidc}|${o.disconnected ? 1 : 0}${o.self ? 1 : 0}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const sym = new ms.Symbol(sidc, { size: o.self ? 32 : 28 });
  const { width, height } = sym.getSize();
  const anchor = sym.getAnchor();
  const classes = ['tq-sym'];
  if (o.disconnected) classes.push('is-disconnected');
  if (o.self) classes.push('is-self');

  const icon = L.divIcon({
    html: decorateUnit(sym.asSVG(), sidc),
    className: classes.join(' '),
    iconSize: [width, height],
    iconAnchor: [anchor.x, anchor.y],
  });
  iconCache.set(key, icon);
  return icon;
}

/** SVG brut, pour le sélecteur et la liste des membres. */
export function symbolSvg(sidc: string, size = 26): string {
  return decorateUnit(new ms.Symbol(sidc, { size }).asSVG(), sidc);
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
