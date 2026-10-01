import type { QualifiedName, Ref } from '../../shared/types';

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
