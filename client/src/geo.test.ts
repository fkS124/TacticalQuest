import { describe, expect, it } from 'vitest';
import type { Position } from '@tq/shared/protocol';
import { distanceM, shouldSend } from './geo';

const fix = (over: Partial<Position> = {}): Position => ({
  lat: 45.0,
  lng: 5.0,
  accuracy: 10,
  heading: null,
  speed: null,
  ts: 0,
  ...over,
});

describe('shouldSend', () => {
  it('envoie toujours le premier fix', () => {
    expect(shouldSend(null, fix(), 0, 10_000)).toBe(true);
  });

  it('respecte l’intervalle minimum de 3 s', () => {
    const prev = fix();
    expect(shouldSend(prev, fix({ lat: 46 }), 10_000, 11_000)).toBe(false);
    expect(shouldSend(prev, fix({ lat: 46 }), 10_000, 13_500)).toBe(true);
  });

  it('ignore un fix quasi immobile sans changement de cap', () => {
    const prev = fix();
    // ~1 m de déplacement
    const next = fix({ lat: 45.00001 });
    expect(shouldSend(prev, next, 10_000, 20_000)).toBe(false);
  });

  it('envoie si déplacement > 5 m', () => {
    const prev = fix();
    // ~11 m
    const next = fix({ lat: 45.0001 });
    expect(shouldSend(prev, next, 10_000, 20_000)).toBe(true);
  });

  it('envoie si le cap tourne de plus de 15°', () => {
    const prev = fix({ heading: 10 });
    expect(shouldSend(prev, fix({ heading: 20 }), 10_000, 20_000)).toBe(false);
    expect(shouldSend(prev, fix({ heading: 30 }), 10_000, 20_000)).toBe(true);
  });

  it('gère le passage par le nord (350° → 5° = 15°)', () => {
    const prev = fix({ heading: 350 });
    expect(shouldSend(prev, fix({ heading: 5 }), 10_000, 20_000)).toBe(false);
    expect(shouldSend(prev, fix({ heading: 10 }), 10_000, 20_000)).toBe(true);
  });

  it('keepalive : envoie après 30 s même immobile', () => {
    const prev = fix();
    expect(shouldSend(prev, fix(), 10_000, 39_000)).toBe(false);
    expect(shouldSend(prev, fix(), 10_000, 40_001)).toBe(true);
  });
});

describe('distanceM', () => {
  it('ordre de grandeur correct (1° lat ≈ 111 km)', () => {
    const d = distanceM({ lat: 45, lng: 5 }, { lat: 46, lng: 5 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});
