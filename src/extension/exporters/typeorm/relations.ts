import type { QualifiedName, Ref } from '../../../shared/types';
import { pluralize, toCamelCase, toClassName } from './naming';

export type Cardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

export interface RelationSide {
  /** The class this relation lives on. */
  ownerTable: QualifiedName;
  /** The class this relation points to. */
  targetTable: QualifiedName;
  /** Decorator to emit (e.g. 'OneToMany'). */
  decorator: 'OneToOne' | 'OneToMany' | 'ManyToOne' | 'ManyToMany';
  /** Property name on the owner class. */
  propertyName: string;
  /** TS type — may be `Target` or `Target[]`. */
  tsType: string;
  /** If set, this side owns the JoinColumn / JoinTable. */
  isOwning: boolean;
  /** Columns on the owner that form the FK (only meaningful when `isOwning`). */
  fkColumns: string[];
  /** Inverse property name on the other entity, used for the `tgt => tgt.foo` callback. */
  inversePropertyName: string;
  /** Original ref id — for traceability + dedup. */
  refId: string;
}

export interface RelationPair {
  cardinality: Cardinality;
  source: RelationSide;
  target: RelationSide;
}

interface NamingOpts {
  singularize: boolean;
}

function cardinalityOf(ref: Ref): Cardinality {
  const a = ref.source.relation;
  const b = ref.target.relation;
  if (a === '1' && b === '1') return 'one-to-one';
  if (a === '1' && b === '*') return 'one-to-many';
  if (a === '*' && b === '1') return 'many-to-one';
  return 'many-to-many';
}

function decoratorFor(card: Cardinality, side: 'source' | 'target'): RelationSide['decorator'] {
  switch (card) {
    case 'one-to-one':
      return 'OneToOne';
    case 'one-to-many':
      return side === 'source' ? 'OneToMany' : 'ManyToOne';
    case 'many-to-one':
      return side === 'source' ? 'ManyToOne' : 'OneToMany';
    case 'many-to-many':
      return 'ManyToMany';
  }
}

function propNameFor(
  decorator: RelationSide['decorator'],
  targetTable: QualifiedName,
  opts: NamingOpts,
): string {
  const className = toClassName(targetTable, opts);
  const camel = toCamelCase(className);
  if (decorator === 'OneToMany' || decorator === 'ManyToMany') return pluralize(camel);
  return camel;
}

function tsTypeFor(
  decorator: RelationSide['decorator'],
  targetTable: QualifiedName,
  opts: NamingOpts,
): string {
  const cls = toClassName(targetTable, opts);
  if (decorator === 'OneToMany' || decorator === 'ManyToMany') return `${cls}[]`;
  return cls;
}

/**
 * Convert refs into relation pairs. Each Ref produces two RelationSides — one per endpoint.
 * Ownership rules: see specs/09-exporters.md § Relations.
 */
export function buildRelationPairs(refs: ReadonlyArray<Ref>, opts: NamingOpts): RelationPair[] {
  const out: RelationPair[] = [];
  for (const ref of refs) {
    const card = cardinalityOf(ref);

    const sourceDecorator = decoratorFor(card, 'source');
    const targetDecorator = decoratorFor(card, 'target');

    // Ownership: source side owns JoinColumn for 1:1, *:1, *:*; target side owns JoinColumn for 1:*.
    // i.e. the side whose decorator is ManyToOne / (the picked owner for OneToOne / ManyToMany).
    let sourceOwns: boolean;
    switch (card) {
      case 'one-to-one':
        sourceOwns = true; // DBML inline `ref:` writer convention
        break;
      case 'many-to-many':
        sourceOwns = true;
        break;
      case 'many-to-one':
        sourceOwns = true; // source side has the FK columns
        break;
      case 'one-to-many':
        sourceOwns = false; // target side is the *-side that holds the FK
        break;
    }

    const sourceProp = propNameFor(sourceDecorator, ref.target.table, opts);
    const targetProp = propNameFor(targetDecorator, ref.source.table, opts);

    out.push({
      cardinality: card,
      source: {
        ownerTable: ref.source.table,
        targetTable: ref.target.table,
        decorator: sourceDecorator,
        propertyName: sourceProp,
        tsType: tsTypeFor(sourceDecorator, ref.target.table, opts),
        isOwning: sourceOwns,
        fkColumns: sourceOwns ? [...ref.source.columns] : [],
        inversePropertyName: targetProp,
        refId: ref.id,
      },
      target: {
        ownerTable: ref.target.table,
        targetTable: ref.source.table,
        decorator: targetDecorator,
        propertyName: targetProp,
        tsType: tsTypeFor(targetDecorator, ref.source.table, opts),
        isOwning: !sourceOwns,
        fkColumns: !sourceOwns ? [...ref.target.columns] : [],
        inversePropertyName: sourceProp,
        refId: ref.id,
      },
    });
  }
  return out;
}

/**
 * Group RelationSides by ownerTable. Each entry is what to emit on that entity.
 * Resolves property-name collisions by suffixing with `_N`.
 */
export function relationsByOwner(
  pairs: ReadonlyArray<RelationPair>,
  liveTables: Set<QualifiedName>,
): { byOwner: Map<QualifiedName, RelationSide[]>; orphanedRefIds: Set<string> } {
  const byOwner = new Map<QualifiedName, RelationSide[]>();
  const orphanedRefIds = new Set<string>();

  const push = (side: RelationSide) => {
    if (!liveTables.has(side.ownerTable) || !liveTables.has(side.targetTable)) {
      orphanedRefIds.add(side.refId);
      return;
    }
    const list = byOwner.get(side.ownerTable) ?? [];
    // Avoid name collisions on the same entity.
    const used = new Set(list.map((s) => s.propertyName));
    let candidate = side.propertyName;
    let i = 2;
    while (used.has(candidate)) {
      candidate = `${side.propertyName}_${i++}`;
    }
    list.push({ ...side, propertyName: candidate });
    byOwner.set(side.ownerTable, list);
  };

  for (const pair of pairs) {
    push(pair.source);
    push(pair.target);
  }

  return { byOwner, orphanedRefIds };
}
