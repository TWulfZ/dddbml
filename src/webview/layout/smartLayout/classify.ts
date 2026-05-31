import type { QualifiedName, Ref, Table } from '../../../shared/types';

/**
 * Database-aware role classification — the "brain" of smart auto-layout, fully
 * engine-agnostic. The geometry engine (dagre) never sees these roles; they drive
 * clustering and radial placement (see cluster.ts, layout.ts).
 */
export type Role =
  | 'island'
  | 'satellite'
  | 'leaf'
  | 'chain'
  | 'junction'
  | 'hub'
  | 'root'
  | 'free';

export interface TableMeta {
  name: QualifiedName;
  inDeg: number;
  outDeg: number;
  totalDeg: number;
  neighbors: Set<QualifiedName>;
  columnCount: number;
  role: Role;
  parent?: QualifiedName;
  junctionEndpoints?: [QualifiedName, QualifiedName];
  pairCount: Map<QualifiedName, number>;
}

export const HUB_THRESHOLD = 5;
/** Max inDeg for a table to still qualify as a junction. */
export const JUNCTION_MAX_IN_DEG = 1;

export function classify(tables: Table[], refs: Ref[]): Map<QualifiedName, TableMeta> {
  const meta = new Map<QualifiedName, TableMeta>();

  for (const t of tables) {
    meta.set(t.name, {
      name: t.name,
      inDeg: 0,
      outDeg: 0,
      totalDeg: 0,
      neighbors: new Set(),
      columnCount: t.columns.length,
      role: 'free',
      pairCount: new Map(),
    });
  }

  const distinctOutTargets = new Map<QualifiedName, Set<QualifiedName>>();
  const fkColumnsBySource = new Map<QualifiedName, number>();

  for (const r of refs) {
    // Normalize orientation: `child` = FK-holder (many side), `parent` = PK-holder (one side).
    // @dbml/core reports endpoint order inconsistently, so use relation tags.
    // If source.relation === '*' OR target.relation === '1', source is the child.
    const sourceIsChild = r.source.relation === '*' || r.target.relation === '1';
    const child = sourceIsChild ? r.source : r.target;
    const parent = sourceIsChild ? r.target : r.source;

    const c = meta.get(child.table);
    const p = meta.get(parent.table);
    if (!c || !p) continue;

    c.outDeg++;
    p.inDeg++;
    c.neighbors.add(p.name);
    p.neighbors.add(c.name);
    c.pairCount.set(p.name, (c.pairCount.get(p.name) ?? 0) + 1);
    p.pairCount.set(c.name, (p.pairCount.get(c.name) ?? 0) + 1);

    let set = distinctOutTargets.get(c.name);
    if (!set) {
      set = new Set();
      distinctOutTargets.set(c.name, set);
    }
    set.add(p.name);

    fkColumnsBySource.set(
      c.name,
      (fkColumnsBySource.get(c.name) ?? 0) + child.columns.length,
    );
  }

  for (const m of meta.values()) {
    m.totalDeg = m.inDeg + m.outDeg;
  }

  for (const m of meta.values()) {
    // Island: no connections. Will land in the orphans cluster.
    if (m.totalDeg === 0) {
      m.role = 'island';
      continue;
    }

    // Junction: 2 distinct outgoing targets, low incoming, mostly FK columns.
    if (m.outDeg >= 2 && m.inDeg <= JUNCTION_MAX_IN_DEG) {
      const targets = [...(distinctOutTargets.get(m.name) ?? [])];
      const [t0, t1] = targets;
      if (targets.length === 2 && t0 !== undefined && t1 !== undefined) {
        const fkCols = fkColumnsBySource.get(m.name) ?? 0;
        const threshold = Math.max(2, Math.floor(m.columnCount * 0.5));
        if (fkCols >= threshold) {
          m.role = 'junction';
          m.junctionEndpoints = [t0, t1];
          continue;
        }
      }
    }

    // Satellite: one outgoing FK, no incoming. Column count no longer restricts —
    // even large detail tables with a single parent should orbit that parent.
    if (m.outDeg === 1 && m.inDeg === 0) {
      const parent = m.neighbors.values().next().value;
      if (parent !== undefined) {
        m.role = 'satellite';
        m.parent = parent;
        continue;
      }
    }

    // Leaf: no outgoing, exactly one referencer.
    if (m.outDeg === 0 && m.inDeg >= 1 && m.neighbors.size === 1) {
      const parent = m.neighbors.values().next().value;
      if (parent !== undefined) {
        m.role = 'leaf';
        m.parent = parent;
        continue;
      }
    }

    // Chain link: one in, one out, two distinct neighbors. Sits in the middle
    // of a pipeline. Parent = the higher-degree neighbor (the "anchor" of the chain).
    if (m.outDeg === 1 && m.inDeg === 1 && m.neighbors.size === 2) {
      const [n1, n2] = [...m.neighbors];
      if (n1 !== undefined && n2 !== undefined) {
        const d1 = meta.get(n1)?.totalDeg ?? 0;
        const d2 = meta.get(n2)?.totalDeg ?? 0;
        m.role = 'chain';
        m.parent = d1 >= d2 ? n1 : n2;
        continue;
      }
    }

    // Hub: high connectivity.
    if (m.totalDeg >= HUB_THRESHOLD) {
      m.role = 'hub';
      continue;
    }

    // Root: multiple incoming, low outgoing.
    if (m.inDeg >= 2 && m.outDeg <= 1) {
      m.role = 'root';
      continue;
    }

    m.role = 'free';
  }

  return meta;
}
