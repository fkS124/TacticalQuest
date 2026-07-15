import { bus, state } from '../state';

// Calques d'affichage des figurés (liserés, flèches, box, missions). Chaque
// graphique porte un nom de calque dans son style ; le filtrage est purement
// local : chacun choisit ce qu'il affiche, rien ne transite sur le réseau.
// Le bandeau en haut de l'écran liste les calques : un calque sélectionné est
// affiché, les autres sont masqués (plusieurs sélections possibles). Les
// figurés sans calque (« Général ») restent toujours visibles. Les nouveaux
// figurés vont dans le dernier calque sélectionné ('' = Général si aucun).

const LAYERS_KEY = 'tq-layers';
export const MAX_LAYER_NAME = 24;

/** Calques proposés d'office dans le bandeau. */
const DEFAULT_LAYERS = ['T1', 'ART'];

interface Persisted {
  names: string[];
  /** Calques affichés, dans l'ordre de sélection (le dernier est l'actif). */
  selected: string[];
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    const p = raw ? (JSON.parse(raw) as Persisted) : null;
    if (p && Array.isArray(p.names)) {
      return { names: p.names, selected: Array.isArray(p.selected) ? p.selected : [] };
    }
  } catch {
    /* stockage corrompu : on repart de zéro */
  }
  return { names: [], selected: [] };
}

const initial = load();
let names: string[] = [...new Set([...DEFAULT_LAYERS, ...initial.names])];
let selected: string[] = initial.selected;

function persist(): void {
  try {
    localStorage.setItem(LAYERS_KEY, JSON.stringify({ names, selected } satisfies Persisted));
  } catch {
    /* quota : l'état reste au moins en mémoire */
  }
}

function changed(): void {
  persist();
  bus.emit('overlays');
}

/** Nom de calque assaini (payload relayé = non fiable côté réception). */
function clean(name: string): string {
  return name.trim().slice(0, MAX_LAYER_NAME);
}

/** Calques présents dans les figurés reçus (les autres membres en créent aussi). */
function layersInOrders(): string[] {
  const out = new Set<string>();
  for (const o of state.orders.values()) {
    const layer =
      o.payload.kind === 'graphic'
        ? o.payload.style?.layer
        : o.payload.kind === 'waypoint'
          ? o.payload.layer
          : undefined;
    if (typeof layer === 'string' && clean(layer)) out.add(clean(layer));
  }
  return [...out];
}

/** Tous les calques connus (défaut ∪ créés localement ∪ portés par les figurés). */
export function knownLayers(): string[] {
  return [...new Set([...names, ...layersInOrders()])].sort((x, y) => x.localeCompare(y));
}

export function isLayerSelected(name: string): boolean {
  return selected.includes(name);
}

/** Un figuré est masqué si son calque n'est pas sélectionné ('' = toujours vu). */
export function isLayerHidden(layer?: string): boolean {
  const n = layer ? clean(layer) : '';
  return n !== '' && !selected.includes(n);
}

/** Bascule l'affichage d'un calque. Renvoie true s'il vient d'être sélectionné. */
export function toggleLayer(name: string): boolean {
  const on = !selected.includes(name);
  selected = on ? [...selected, name] : selected.filter((n) => n !== name);
  changed();
  return on;
}

/** Crée un calque et le sélectionne. Renvoie le nom retenu, null si invalide. */
export function createLayer(name: string): string | null {
  const n = clean(name);
  if (!n) return null;
  if (!knownLayers().includes(n)) names = [...names, n];
  if (!selected.includes(n)) selected = [...selected, n];
  changed();
  return n;
}

/** Calque des nouveaux figurés : le dernier sélectionné ('' = Général). */
export function activeLayer(): string {
  return selected[selected.length - 1] ?? '';
}
