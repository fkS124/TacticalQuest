import L from 'leaflet';
import ms from 'milsymbol';

/** Choix proposés dans le sélecteur (2525C, unités amies terrestres). */
export const SYMBOL_CHOICES: { sidc: string; label: string }[] = [
  { sidc: 'SFGPUCI----', label: 'Infanterie' },
  { sidc: 'SFGPUCIZ---', label: 'Inf. mécanisée' },
  { sidc: 'SFGPUCR----', label: 'Reconnaissance' },
  { sidc: 'SFGPUCA----', label: 'Blindé' },
  { sidc: 'SFGPUCAA---', label: 'Antichar' },
  { sidc: 'SFGPUCF----', label: 'Artillerie' },
  { sidc: 'SFGPUCFM---', label: 'Mortier' },
  { sidc: 'SFGPUCE----', label: 'Génie' },
  { sidc: 'SFGPUUS----', label: 'Transmissions' },
  { sidc: 'SFGPUSM----', label: 'Sanitaire' },
  { sidc: 'SFGPUSS----', label: 'Ravitaillement' },
  { sidc: 'SFGPUH-----', label: 'PC' },
];

export interface IconOpts {
  stale: boolean;
  disconnected: boolean;
  self: boolean;
}

// Le rendu milsymbol n'est pas gratuit sur CPU faible : mémoïsation par
// combinaison sidc + état visuel.
const iconCache = new Map<string, L.DivIcon>();

export function getIcon(sidc: string, o: IconOpts): L.DivIcon {
  const key = `${sidc}|${o.stale ? 1 : 0}${o.disconnected ? 1 : 0}${o.self ? 1 : 0}`;
  const cached = iconCache.get(key);
  if (cached) return cached;

  const sym = new ms.Symbol(sidc, { size: o.self ? 32 : 28 });
  const { width, height } = sym.getSize();
  const anchor = sym.getAnchor();
  const classes = ['tq-sym'];
  if (o.stale) classes.push('is-stale');
  if (o.disconnected) classes.push('is-disconnected');
  if (o.self) classes.push('is-self');

  const icon = L.divIcon({
    html: sym.asSVG(),
    className: classes.join(' '),
    iconSize: [width, height],
    iconAnchor: [anchor.x, anchor.y],
  });
  iconCache.set(key, icon);
  return icon;
}

/** SVG brut, pour le sélecteur et la liste des membres. */
export function symbolSvg(sidc: string, size = 26): string {
  return new ms.Symbol(sidc, { size }).asSVG();
}

/** Losange rouge APP-6 : unité terrestre hostile, sans fonction. */
export const HOSTILE_SIDC = 'SHGP-------';

const plotCache = new Map<string, L.DivIcon>();

/** Icône de plot (positions ennemies, futurs waypoints nommés). */
export function getPlotIcon(sidc: string): L.DivIcon {
  const cached = plotCache.get(sidc);
  if (cached) return cached;
  const sym = new ms.Symbol(sidc, { size: 22 });
  const { width, height } = sym.getSize();
  const anchor = sym.getAnchor();
  const icon = L.divIcon({
    html: sym.asSVG(),
    className: 'tq-sym tq-plot',
    iconSize: [width, height],
    iconAnchor: [anchor.x, anchor.y],
  });
  plotCache.set(sidc, icon);
  return icon;
}
