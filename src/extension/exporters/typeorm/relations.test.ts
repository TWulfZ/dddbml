import { describe, expect, it } from 'vitest';
import { toClassName } from './naming';
import { buildRelationPairs, relationsByOwner } from './relations';
import type { Ref } from '../../../shared/types';

const fk = (id: string, column: string): Ref => ({
  id,
  source: { table: 'orders', columns: [column], relation: '*' },
  target: { table: 'users', columns: ['id'], relation: '1' },
});

describe('relationsByOwner — relation properties never reuse a column property', () => {
  it('suffixes the relation when a column is named after the target entity', () => {
    const ref: Ref = {
      id: 'r1',
      source: { table: 'sections', columns: ['category'], relation: '*' },
      target: { table: 'categories', columns: ['id'], relation: '1' },
    };
    const pairs = buildRelationPairs([ref], {
      className: (t) => toClassName(t, { singularize: true }),
      singularize: true,
      tables: new Map(),
    });
    const columns = new Map([['sections', ['id', 'category']], ['categories', ['id', 'name']]]);
    const { byOwner } = relationsByOwner(pairs, new Set(['sections', 'categories']), columns);

    const section = byOwner.get('sections')!;
    expect(section.map((s) => s.propertyName)).toEqual(['category_2']);
    expect(byOwner.get('categories')![0]!.inversePropertyName).toBe('category_2');
  });
});

describe('relationsByOwner — collision suffix reaches the sibling inverse callback', () => {
  it('points each ManyToOne at the OneToMany name that was actually emitted', () => {
    const pairs = buildRelationPairs([fk('r1', 'created_by'), fk('r2', 'updated_by')], {
      className: (t) => toClassName(t, { singularize: true }),
      singularize: true,
      tables: new Map(),
    });
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
