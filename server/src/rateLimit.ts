import { ROOM_CREATE_PER_IP_PER_HOUR } from '@tq/shared/constants';

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
