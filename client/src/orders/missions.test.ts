import { describe, expect, it } from 'vitest';
import type { OrderMessage } from '@tq/shared/protocol';
import { deriveMissions, isActive } from './missions';

const mission = (id: string, assignee: string, ts = 1): OrderMessage => ({
  id,
  authorId: 'chef',
  ts,
  kind: 'mission',
  payload: { kind: 'mission', missionType: 'seize', lat: 45, lng: 5, assignee },
});

const status = (id: string, missionId: string, s: 'ack' | 'done', by: string, ts: number): OrderMessage => ({
  id,
  authorId: by,
  ts,
  kind: 'mission_status',
  payload: { kind: 'mission_status', missionId, status: s },
});

const remove = (id: string, orderId: string): OrderMessage => ({
  id,
  authorId: 'chef',
  ts: 9,
  kind: 'remove',
  payload: { kind: 'remove', orderId },
});

describe('deriveMissions', () => {
  it('mission neuve : statut pending, active', () => {
    const m = deriveMissions(new Map([['m1', mission('m1', 'bravo')]]));
    expect(m).toHaveLength(1);
    expect(m[0]!.status).toBe('pending');
    expect(m[0]!.assignee).toBe('bravo');
    expect(isActive(m[0]!)).toBe(true);
  });

  it('progression pending → ack → done (dernier ts gagne)', () => {
    const orders = new Map<string, OrderMessage>([
      ['m1', mission('m1', 'bravo', 1)],
      ['s1', status('s1', 'm1', 'ack', 'bravo', 2)],
      ['s2', status('s2', 'm1', 'done', 'bravo', 3)],
    ]);
    const m = deriveMissions(orders)[0]!;
    expect(m.status).toBe('done');
    expect(isActive(m)).toBe(true); // reste affichée jusqu'à clôture par le chef
  });

  it('mission remplie puis clôturée par le chef : inactive', () => {
    const orders = new Map<string, OrderMessage>([
      ['m1', mission('m1', 'bravo', 1)],
      ['s2', status('s2', 'm1', 'done', 'bravo', 3)],
      ['r1', remove('r1', 'm1')],
    ]);
    const m = deriveMissions(orders)[0]!;
    expect(m.status).toBe('done');
    expect(m.removed).toBe(true);
    expect(isActive(m)).toBe(false);
  });

  it('un ack seul laisse la mission active', () => {
    const orders = new Map<string, OrderMessage>([
      ['m1', mission('m1', 'bravo', 1)],
      ['s1', status('s1', 'm1', 'ack', 'bravo', 2)],
    ]);
    const m = deriveMissions(orders)[0]!;
    expect(m.status).toBe('ack');
    expect(isActive(m)).toBe(true);
  });

  it('annulation : mission inactive', () => {
    const orders = new Map<string, OrderMessage>([
      ['m1', mission('m1', 'bravo', 1)],
      ['r1', remove('r1', 'm1')],
    ]);
    const m = deriveMissions(orders)[0]!;
    expect(m.removed).toBe(true);
    expect(isActive(m)).toBe(false);
  });

  it('tri par date décroissante', () => {
    const orders = new Map<string, OrderMessage>([
      ['m1', mission('m1', 'bravo', 1)],
      ['m2', mission('m2', 'charlie', 5)],
    ]);
    expect(deriveMissions(orders).map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('ignore les ordres non-mission', () => {
    const text: OrderMessage = {
      id: 't1', authorId: 'chef', ts: 1, kind: 'text',
      payload: { kind: 'text', body: 'rien' },
    };
    expect(deriveMissions(new Map([['t1', text]]))).toHaveLength(0);
  });
});
