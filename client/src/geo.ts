import {
  POSITION_KEEPALIVE_MS,
  POSITION_MIN_DISTANCE_M,
  POSITION_MIN_HEADING_DEG,
  POSITION_SEND_INTERVAL_MS,
} from '@tq/shared/constants';
import type { Position } from '@tq/shared/protocol';

/** Distance haversine en mètres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function headingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Throttle d'envoi (batterie + bande passante) :
 * max 1 fix / POSITION_SEND_INTERVAL_MS, et seulement si déplacement ou
 * changement de cap significatif — sauf keepalive périodique à l'arrêt.
 */
export function shouldSend(
  lastSent: Position | null,
  next: Position,
  lastSentAt: number,
  now: number,
): boolean {
  if (now - lastSentAt < POSITION_SEND_INTERVAL_MS) return false;
  if (!lastSent) return true;
  if (now - lastSentAt >= POSITION_KEEPALIVE_MS) return true;
  if (distanceM(lastSent, next) > POSITION_MIN_DISTANCE_M) return true;
  if (
    lastSent.heading !== null &&
    next.heading !== null &&
    headingDelta(lastSent.heading, next.heading) > POSITION_MIN_HEADING_DEG
  ) {
    return true;
  }
  return false;
}

export interface GeoHandlers {
  /** Appelé à chaque fix retenu pour l'envoi. */
  send: (p: Position) => void;
  /** Appelé à chaque fix (même non envoyé) pour l'affichage local. */
  onFix?: (p: Position) => void;
  onDenied: () => void;
  onUnavailable?: () => void;
}

export interface GeoWatcher {
  stop: () => void;
  /** Dernier fix, pour ré-émission après reconnexion. */
  getLastFix: () => Position | null;
  /** Force l'envoi du dernier fix (après rejoin). */
  resend: () => void;
}

export function startGeolocation(handlers: GeoHandlers): GeoWatcher | null {
  if (!('geolocation' in navigator)) {
    handlers.onDenied();
    return null;
  }

  let lastSent: Position | null = null;
  let lastSentAt = 0;
  let lastFix: Position | null = null;
  // Le keepalive est porté par un timer : watchPosition ne rappelle pas
  // quand l'appareil est immobile.
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const emit = (p: Position) => {
    lastSent = p;
    lastSentAt = Date.now();
    handlers.send(p);
  };

  const watchId = navigator.geolocation.watchPosition(
    (gp) => {
      const p: Position = {
        lat: gp.coords.latitude,
        lng: gp.coords.longitude,
        accuracy: gp.coords.accuracy,
        heading: gp.coords.heading !== null && !Number.isNaN(gp.coords.heading) ? gp.coords.heading : null,
        speed: gp.coords.speed !== null && !Number.isNaN(gp.coords.speed) ? gp.coords.speed : null,
        ts: gp.timestamp,
      };
      lastFix = p;
      handlers.onFix?.(p);
      if (shouldSend(lastSent, p, lastSentAt, Date.now())) emit(p);
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) handlers.onDenied();
      else handlers.onUnavailable?.();
    },
    { enableHighAccuracy: true, maximumAge: 3_000, timeout: 15_000 },
  );

  keepalive = setInterval(() => {
    if (lastFix && Date.now() - lastSentAt >= POSITION_KEEPALIVE_MS) {
      emit({ ...lastFix, ts: Date.now() });
    }
  }, POSITION_KEEPALIVE_MS / 2);

  return {
    stop() {
      navigator.geolocation.clearWatch(watchId);
      if (keepalive) clearInterval(keepalive);
    },
    getLastFix: () => lastFix,
    resend() {
      if (lastFix) emit({ ...lastFix, ts: Date.now() });
    },
  };
}
