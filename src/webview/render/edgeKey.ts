import { DEP_EDGE_KEY_PREFIX, type Dep, type DepEndpoint, type QualifiedName, type Ref } from '../../shared/types';

/**
 * Key of an edge's persisted EdgeLayout (spec 03 `edges`). Built from the endpoints AFTER the
 * hide/collapse remap, so it differs from the parser's stable `Ref.id`; every reader and writer of
 * `edgeLayouts` must use this, or layouts land on keys the renderer never looks up.
 */
export function edgeKey(
  src: QualifiedName,
  srcCols: readonly string[],
  tgt: QualifiedName,
  tgtCols: readonly string[],
): string {
  return `${src}::${srcCols.join(',')}|${tgt}::${tgtCols.join(',')}`;
}

/** Edge ordering and resets once persisted entries under `Ref.id`; a real edge key always has `::`. */
export function isEdgeKey(id: string): boolean {
  return id.includes('::');
}

/**
 * Refs re-identified by `edgeKey`, endpoints remapped by `mapEndpoint` (null = drop the ref).
 * Refs collapsing onto one node are dropped; refs sharing a key keep the first occurrence.
 */
export function edgeKeyedRefs(
  refs: readonly Ref[],
  mapEndpoint: (table: QualifiedName) => QualifiedName | null,
): { refs: Ref[]; keyByStableId: Map<string, string> } {
  const out: Ref[] = [];
  const keyByStableId = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of refs) {
    const src = mapEndpoint(r.source.table);
    const tgt = mapEndpoint(r.target.table);
    if (src == null || tgt == null || src === tgt) continue;
    const key = edgeKey(src, r.source.columns, tgt, r.target.columns);
    keyByStableId.set(r.id, key);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, id: key, source: { ...r.source, table: src }, target: { ...r.target, table: tgt } });
  }
  return { refs: out, keyByStableId };
}

/** A `Dep` edge after the hide/collapse remap, keyed for `edgeLayouts` (spec 18). */
export interface KeyedDepEdge {
  id: string;
  upstream: DepEndpoint;
  downstream: DepEndpoint;
  color?: string;
  note?: string | null;
  name: string | null;
}

/**
 * Deps get their own `dep:` namespace so a dep and an FK between the same columns keep separate
 * waypoints/colors, and are never deduped against each other.
 */
export function depKey(up: QualifiedName, upCols: readonly string[], down: QualifiedName, downCols: readonly string[]): string {
  return DEP_EDGE_KEY_PREFIX + edgeKey(up, upCols, down, downCols);
}

export function edgeKeyedDeps(
  deps: readonly Dep[],
  mapEndpoint: (table: QualifiedName) => QualifiedName | null,
): KeyedDepEdge[] {
  const out: KeyedDepEdge[] = [];
  const seen = new Set<string>();
  for (const d of deps) {
    for (const e of d.edges) {
      const up = mapEndpoint(e.upstream.table);
      const down = mapEndpoint(e.downstream.table);
      if (up == null || down == null || up === down) continue;
      // A collapsed group endpoint has no column rows, so its port falls back to the header.
      const upCols = up === e.upstream.table ? e.upstream.columns : [];
      const downCols = down === e.downstream.table ? e.downstream.columns : [];
      const id = depKey(up, upCols, down, downCols);
      if (seen.has(id)) continue;
      seen.add(id);
      const edge: KeyedDepEdge = {
        id,
        upstream: { table: up, columns: upCols },
        downstream: { table: down, columns: downCols },
        note: d.note ?? null,
        name: d.name,
      };
      if (d.color) edge.color = d.color;
      out.push(edge);
    }
  }
  return out;
}
