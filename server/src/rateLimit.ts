import {
  ADMIN_AUTH_MAX_FAILS,
  ADMIN_AUTH_WINDOW_MS,
  ROOM_CREATE_PER_IP_PER_HOUR,
} from '@tq/shared/constants';

const WINDOW_MS = 60 * 60_000;

/** Limiteur glissant en mémoire : créations de room par IP. */
export class IpRateLimiter {
  private readonly creations = new Map<string, number[]>();

  tryCreate(ip: string, now = Date.now()): boolean {
    const recent = (this.creations.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= ROOM_CREATE_PER_IP_PER_HOUR) {
      this.creations.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.creations.set(ip, recent);
    return true;
  }
}

/**
 * Verrouillage anti brute-force du code admin : compte les échecs
 * d'authentification par IP sur une fenêtre glissante. Au-delà du seuil, l'IP
 * est bloquée jusqu'à expiration de la fenêtre. Un succès remet le compteur à
 * zéro.
 */
export class AdminAuthLimiter {
  private readonly fails = new Map<string, number[]>();

  /** Vrai si l'IP a encore le droit de tenter (non verrouillée). */
  allow(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length < ADMIN_AUTH_MAX_FAILS;
  }

  /** Enregistre un échec d'authentification. */
  recordFailure(ip: string, now = Date.now()): void {
    const recent = this.recent(ip, now);
    recent.push(now);
    this.fails.set(ip, recent);
  }

  /** Authentification réussie : on oublie les échecs de cette IP. */
  reset(ip: string): void {
    this.fails.delete(ip);
  }

  /** Secondes avant déverrouillage (pour l'en-tête Retry-After). */
  retryAfterSec(ip: string, now = Date.now()): number {
    const recent = this.recent(ip, now);
    if (!recent.length) return 0;
    return Math.ceil((recent[0]! + ADMIN_AUTH_WINDOW_MS - now) / 1000);
  }

  private recent(ip: string, now: number): number[] {
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < ADMIN_AUTH_WINDOW_MS);
    this.fails.set(ip, recent);
    return recent;
  }
}
