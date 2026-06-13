import { forward as mgrsForward } from 'mgrs';
import { bus } from './state';

export type CoordFormat = 'mgrs' | 'utm' | 'latlng';

export const FORMAT_LABELS: Record<CoordFormat, string> = {
  mgrs: 'MGRS',
  utm: 'UTM',
  latlng: 'Géo',
};

const STORAGE_KEY = 'tq-coord-format';
const CYCLE: CoordFormat[] = ['mgrs', 'utm', 'latlng'];

const storage: Pick<Storage, 'getItem' | 'setItem'> =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {} };

let current: CoordFormat = (() => {
  const v = storage.getItem(STORAGE_KEY);
  return v === 'mgrs' || v === 'utm' || v === 'latlng' ? v : 'mgrs';
})();

export function getCoordFormat(): CoordFormat {
  return current;
}

export function setCoordFormat(f: CoordFormat): void {
  if (f === current) return;
  current = f;
  storage.setItem(STORAGE_KEY, f);
  bus.emit('coordfmt', f);
}

export function cycleCoordFormat(): void {
  setCoordFormat(CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length]!);
}

/** Formate au format courant (ou explicite). */
export function formatCoords(lat: number, lng: number, fmt: CoordFormat = current): string {
  switch (fmt) {
    case 'mgrs':
      return formatMgrs(lat, lng);
    case 'utm':
      return formatUtm(lat, lng);
    case 'latlng':
      return formatLatLng(lat, lng);
  }
}

function formatLatLng(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'O';
  return `${Math.abs(lat).toFixed(5)}°${ns} ${Math.abs(lng).toFixed(5)}°${ew}`;
}

/** '31TGL1402607502' → '31T GL 14026 07502' (lisible à la radio). */
function formatMgrs(lat: number, lng: number): string {
  const raw = mgrsForward([lng, lat], 5);
  const m = /^(\d{1,2}[C-X])([A-Z]{2})(\d{10})$/.exec(raw);
  if (!m) return raw;
  return `${m[1]} ${m[2]} ${m[3]!.slice(0, 5)} ${m[3]!.slice(5)}`;
}

function formatUtm(lat: number, lng: number): string {
  const { zone, band, easting, northing } = toUtm(lat, lng);
  return `${zone}${band} ${Math.floor(easting)} ${Math.floor(northing)}`;
}

// ---------------------------------------------------------------------------
// Conversion UTM (WGS84, formules classiques de Snyder, précision < 1 m).
// Mêmes exceptions de zone (Norvège/Svalbard) que la grille MGRS.
// ---------------------------------------------------------------------------

export interface UtmCoords {
  zone: number;
  band: string;
  easting: number;
  northing: number;
}

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

export function latitudeBand(lat: number): string {
  const i = Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)));
  return BANDS[i]!;
}

export function utmZone(lat: number, lng: number): number {
  let zone = Math.floor((lng + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lng >= 3 && lng < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lng >= 0 && lng < 9) zone = 31;
    else if (lng >= 9 && lng < 21) zone = 33;
    else if (lng >= 21 && lng < 33) zone = 35;
    else if (lng >= 33 && lng < 42) zone = 37;
  }
  return zone;
}

export function toUtm(lat: number, lng: number): UtmCoords {
  const a = 6378137;
  const e2 = 0.00669438;
  const k0 = 0.9996;
  const zone = utmZone(lat, lng);
  const latR = (lat * Math.PI) / 180;
  const lngR = (lng * Math.PI) / 180;
  const lngOriginR = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const ep2 = e2 / (1 - e2);

  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const tanLat = Math.tan(latR);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = ep2 * cosLat * cosLat;
  const A = cosLat * (lngR - lngOriginR);

  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * latR -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) * Math.sin(2 * latR) +
      ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * latR) -
      ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * latR));

  const easting =
    k0 *
      N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000;

  let northing =
    k0 *
    (M +
      N *
        tanLat *
        (A ** 2 / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;

  return { zone, band: latitudeBand(lat), easting, northing };
}
