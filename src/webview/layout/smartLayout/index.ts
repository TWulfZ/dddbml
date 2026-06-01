import type { QualifiedName, Schema } from '../../../shared/types';
import { classify, type TableMeta, type Role } from './classify';
import { buildClusters, type Cluster } from './cluster';

export type { TableMeta, Role } from './classify';
export type { Cluster, ClusterKind } from './cluster';
export { smartLayout } from './layout';
export type { SmartLayoutInput, SmartLayoutMode, Orientation } from './layout';
export { runSmartLayout, runEdgeOrdering, cancelEdgeOrdering, resetSelectedEdges, countResettableSelectionEdges } from './runner';
export type { ArrangeOptions } from './runner';

export interface Analysis {
  meta: Map<QualifiedName, TableMeta>;
  clusters: Cluster[];
}

export function analyze(schema: Schema): Analysis {
  const meta = classify(schema.tables, schema.refs);
  const clusters = buildClusters(schema.tables, schema.refs, schema.groups, meta);
  return { meta, clusters };
}

/** Human-readable dump for debugging / test snapshots. The tuning microscope. */
export function formatAnalysis(a: Analysis): string {
  const lines: string[] = [];

  const roleBuckets = new Map<Role, TableMeta[]>();
  for (const m of a.meta.values()) {
    const arr = roleBuckets.get(m.role) ?? [];
    arr.push(m);
    roleBuckets.set(m.role, arr);
  }

  const roleOrder: Role[] = [
    'hub', 'root', 'junction', 'satellite', 'leaf', 'chain', 'free', 'island',
  ];
  lines.push(`# Roles (${a.meta.size} tables)`);
  for (const role of roleOrder) {
    const arr = roleBuckets.get(role);
    if (!arr || arr.length === 0) continue;
    lines.push('');
    lines.push(`## ${role} (${arr.length})`);
    arr.sort((x, y) => x.name.localeCompare(y.name));
    for (const m of arr) {
      const parent = m.parent ? ` -> ${m.parent}` : '';
      const junc = m.junctionEndpoints ? ` [${m.junctionEndpoints.join(' <-> ')}]` : '';
      lines.push(`  ${m.name}  in=${m.inDeg} out=${m.outDeg} cols=${m.columnCount}${parent}${junc}`);
    }
  }

  lines.push('');
  lines.push(`# Clusters (${a.clusters.length})`);
  const clusters = [...a.clusters].sort((x, y) => {
    if (x.kind !== y.kind) return x.kind.localeCompare(y.kind);
    return x.id.localeCompare(y.id);
  });
  for (const c of clusters) {
    lines.push('');
    const anchor = c.anchor ? `  anchor=${c.anchor}` : '';
    lines.push(`## [${c.kind}] ${c.id}  members=${c.members.length}${anchor}`);
    if (c.adoptedForeign.length > 0) {
      lines.push(`  adopted-foreign: ${[...c.adoptedForeign].sort().join(', ')}`);
    }
    for (const m of [...c.members].sort()) lines.push(`  - ${m}`);
  }

  return lines.join('\n');
}
