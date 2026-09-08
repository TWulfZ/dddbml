import { describe, expect, it } from 'vitest';
import { buildRelationPairs, relationsByOwner } from './relations';
import type { Ref } from '../../../shared/types';

const fk = (id: string, column: string): Ref => ({
  id,
  source: { table: 'orders', columns: [column], relation: '*' },
  target: { table: 'users', columns: ['id'], relation: '1' },
});

describe('relationsByOwner — collision suffix reaches the sibling inverse callback', () => {
  it('points each ManyToOne at the OneToMany name that was actually emitted', () => {
    const pairs = buildRelationPairs([fk('r1', 'created_by'), fk('r2', 'updated_by')], { singularize: true });
    const { byOwner } = relationsByOwner(pairs, new Set(['orders', 'users']));

    const userSides = byOwner.get('users')!;
    const orderSides = byOwner.get('orders')!;
    expect(userSides.map((s) => s.propertyName)).toEqual(['orders', 'orders_2']);
    expect(orderSides.map((s) => s.propertyName)).toEqual(['user', 'user_2']);

    // Each side's inverse must name its sibling's FINAL property, per ref.
    for (const side of [...userSides, ...orderSides]) {
      const owner = side.ownerTable === 'users' ? orderSides : userSides;
      const sibling = owner.find((s) => s.refId === side.refId)!;
      expect(side.inversePropertyName).toBe(sibling.propertyName);
    }
  });
});
