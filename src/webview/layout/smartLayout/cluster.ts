import type { QualifiedName, Ref, Table, TableGroup } from '../../../shared/types';
import type { TableMeta } from './classify';

export type ClusterKind = 'group' | 'aggregate' | 'component' | 'orphans';

export interface Cluster {
  id: string;
  kind: ClusterKind;
  /** Present when kind === 'group'. */
  groupName?: string;
  /** Hub or root anchoring the cluster (present for kind='aggregate'). */
  anchor?: QualifiedName;
  /** All tables that belong to this cluster. */
  members: QualifiedName[];
  /**
   * Satellites/leaves whose declared TableGroup differs from this cluster's group
   * (or have no group at all). Used by the group-border renderer to expand the
   * visual AABB without moving the tables out of their logical group. Data only
   * for now — the visual expansion is a follow-up (see spec 06).
   */
  adoptedForeign: QualifiedName[];
}

export function buildClusters(
  tables: Table[],
  refs: Ref[],
  groups: TableGroup[],
  meta: Map<QualifiedName, TableMeta>,
): Cluster[] {
  const tableByName = new Map<QualifiedName, Table>();
  for (const t of tables) tableByName.set(t.name, t);

  const clusters = new Map<string, Cluster>();
  const assigned = new Map<QualifiedName, string>();

  const mkId = (prefix: string, key: string) => `${prefix}:${key}`;
  const ensureCluster = (c: Cluster): Cluster => {
    clusters.set(c.id, c);
    return c;
  };
  const addMember = (cluster: Cluster, name: QualifiedName) => {
    cluster.members.push(name);
    assigned.set(name, cluster.id);
  };

  // 1. TableGroup clusters — highest priority.
  for (const g of groups) {
    const c = ensureCluster({
      id: mkId('group', g.name),
      kind: 'group',
      groupName: g.name,
      members: [],
      adoptedForeign: [],
    });
    for (const t of g.tables) {
      if (meta.has(t) && !assigned.has(t)) addMember(c, t);
    }
  }

  // 2. Satellite/leaf/chain adoption — attach to parent's cluster (cross-group allowed).
  //    Iterate until no more adoptions (handles chains of satellites).
  let adopted = true;
  while (adopted) {
    adopted = false;
    for (const m of meta.values()) {
      if (assigned.has(m.name)) continue;
      if (
        (m.role !== 'satellite' && m.role !== 'leaf' && m.role !== 'chain') ||
        !m.parent
      )
        continue;

      const parentCluster = assigned.get(m.parent);
      if (!parentCluster) continue;

      const c = clusters.get(parentCluster)!;
      addMember(c, m.name);

      const ownGroup = tableByName.get(m.name)?.groupName ?? null;
      const hostGroup = c.kind === 'group' ? c.groupName ?? null : null;
      if (c.kind === 'group' && ownGroup !== hostGroup) {
        c.adoptedForeign.push(m.name);
      }
      adopted = true;
    }
  }

  // 3. Junctions — join higher-degree endpoint's cluster.
  for (const m of meta.values()) {
    if (assigned.has(m.name)) continue;
    if (m.role !== 'junction' || !m.junctionEndpoints) continue;

    const [a, b] = m.junctionEndpoints;
    const aDeg = meta.get(a)?.totalDeg ?? 0;
    const bDeg = meta.get(b)?.totalDeg ?? 0;
    const anchor = aDeg >= bDeg ? a : b;
    const hostId = assigned.get(anchor);
    if (!hostId) continue;

    addMember(clusters.get(hostId)!, m.name);
  }

  // 4. Aggregates — unassigned hubs/roots seed their own cluster and pull
  //    unassigned satellites/leaves/junctions from their neighborhood.
  for (const m of meta.values()) {
    if (assigned.has(m.name)) continue;
    if (m.role !== 'hub' && m.role !== 'root') continue;

    const c = ensureCluster({
      id: mkId('agg', m.name),
      kind: 'aggregate',
      anchor: m.name,
      members: [],
      adoptedForeign: [],
    });
    addMember(c, m.name);

    for (const n of m.neighbors) {
      if (assigned.has(n)) continue;
      const nm = meta.get(n);
      if (!nm) continue;
      if (
        nm.role === 'satellite' ||
        nm.role === 'leaf' ||
        nm.role === 'junction' ||
        nm.role === 'chain'
      ) {
        addMember(c, n);
      }
    }
  }

  // 5. Remaining — connected components over the unassigned subgraph.
  const unassigned = [...meta.keys()].filter((n) => !assigned.has(n));
  const adj = new Map<QualifiedName, Set<QualifiedName>>();
  for (const n of unassigned) adj.set(n, new Set());
  for (const r of refs) {
    const a = adj.get(r.source.table);
    const b = adj.get(r.target.table);
    if (a && b) {
      a.add(r.target.table);
      b.add(r.source.table);
    }
  }

  const orphans: QualifiedName[] = [];
  let compIdx = 0;
  for (const start of unassigned) {
    if (assigned.has(start)) continue;

    const members: QualifiedName[] = [];
    const stack: QualifiedName[] = [start];
    const visiting = new Set<QualifiedName>();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === undefined) break;
      if (visiting.has(cur) || assigned.has(cur)) continue;
      visiting.add(cur);
      members.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!assigned.has(nb) && !visiting.has(nb)) stack.push(nb);
      }
    }

    if (members.length === 1) {
      const only = members[0]!;
      if ((meta.get(only)?.totalDeg ?? 0) === 0) {
        orphans.push(only);
        continue;
      }
    }

    const id = mkId('comp', String(compIdx++));
    const c = ensureCluster({
      id,
      kind: 'component',
      members: [],
      adoptedForeign: [],
    });
    for (const n of members) addMember(c, n);
  }

  if (orphans.length > 0) {
    const c = ensureCluster({
      id: 'orphans',
      kind: 'orphans',
      members: [],
      adoptedForeign: [],
    });
    for (const n of orphans) addMember(c, n);
  }

  return [...clusters.values()];
}
