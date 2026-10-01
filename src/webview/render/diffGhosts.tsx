import type { QualifiedName, RefDiff, Schema } from '../../shared/types';
import { estimateSize } from '../layout/autoLayout';
import type { DiffGhost } from '../state/store';
import type { Bbox } from './spatialIndex';

/** The view filters a diff overlay must respect (App's `derived`). */
export interface DiffViewFilters {
  hiddenTables: Set<QualifiedName>;
  collapsedTables: Set<QualifiedName>;
  collapsedNodes: ReadonlyArray<{ name: string } & Bbox>;
}

/**
 * Where a live table is actually drawn: its own card, its collapsed group's node, or nowhere
 * (hidden). `node` names the drawn element so callers can dedupe tables sharing a collapsed node.
 */
export function liveViewBox(
  name: QualifiedName,
  positions: Map<QualifiedName, { x: number; y: number }>,
  tablesByName: Map<QualifiedName, Schema['tables'][number]>,
  filters: DiffViewFilters,
): { node: string; box: Bbox } | null {
  const t = tablesByName.get(name);
  if (!t || filters.hiddenTables.has(name)) return null;
  if (filters.collapsedTables.has(name)) {
    const g = t.groupName ? filters.collapsedNodes.find((n) => n.name === t.groupName) : undefined;
    return g ? { node: `__group__:${g.name}`, box: { x: g.x, y: g.y, w: g.w, h: g.h } } : null;
  }
  const p = positions.get(name);
  if (!p) return null;
  const s = estimateSize(t.columns.length);
  return { node: name, box: { x: p.x, y: p.y, w: s.width, h: s.height } };
}

interface DiffGhostsProps {
  ghosts: DiffGhost[];
  removedRefs: RefDiff[];
  /** Live table positions (head schema). */
  positions: Map<QualifiedName, { x: number; y: number }>;
  tablesByName: Map<QualifiedName, Schema['tables'][number]>;
  filters: DiffViewFilters;
}

/**
 * Diff overlay for the REMOVED side (spec 16, Phase 4): tables present at the diff base but gone in
 * the working tree have no live node, so they render here as dashed ghost cards at their base
 * position; removed refs draw as dashed connectors between endpoint centres. Lives inside the
 * transformed `.ddd-world`, so world coords are used directly. Read-only — pointer-events off.
 */
export function DiffGhosts({ ghosts, removedRefs, positions, tablesByName, filters }: DiffGhostsProps) {
  const ghostByName = new Map(ghosts.map((g) => [g.table.name, g]));

  const centerOf = (name: QualifiedName): { x: number; y: number } | null => {
    if (tablesByName.has(name)) {
      // Hidden endpoint → no line; collapsed → the group node, never the table's raw position.
      const v = liveViewBox(name, positions, tablesByName, filters);
      return v ? { x: v.box.x + v.box.w / 2, y: v.box.y + v.box.h / 2 } : null;
    }
    const g = ghostByName.get(name);
    if (g) {
      const s = estimateSize(g.table.columns.length);
      return { x: g.pos.x + s.width / 2, y: g.pos.y + s.height / 2 };
    }
    return null;
  };

  const lines = removedRefs
    .map((r) => ({ a: centerOf(r.source), b: centerOf(r.target), id: r.id }))
    .filter((l): l is { a: { x: number; y: number }; b: { x: number; y: number }; id: string } => l.a != null && l.b != null);

  return (
    <>
      {lines.length > 0 ? (
        <svg class="ddd-diff-ghost-lines" width="0" height="0" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
          {lines.map((l) => (
            <line key={l.id} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} class="ddd-diff-ghost-line" />
          ))}
        </svg>
      ) : null}
      {ghosts.map((g) => {
        const s = estimateSize(g.table.columns.length);
        return (
          <div
            key={g.table.name}
            class="ddd-table ddd-diff-ghost"
            style={{
              position: 'absolute',
              transform: `translate(${g.pos.x}px, ${g.pos.y}px)`,
              width: `${s.width}px`,
              pointerEvents: 'none',
            }}
          >
            <div class="ddd-table__header ddd-diff-ghost__header">
              <span class="ddd-table__title">
                {g.table.schemaName !== 'public' ? <span class="ddd-table__schema">{g.table.schemaName}.</span> : null}
                <span class="ddd-table__name">{g.table.tableName}</span>
              </span>
              <span class="ddd-diff-ghost__tag">Previous</span>
            </div>
            <ul class="ddd-table__cols">
              {g.table.columns.map((c) => (
                <li key={c.name} class="ddd-table__col is-diff-del">
                  <span class="ddd-table__col-sign" aria-hidden="true">−</span>
                  <span class="ddd-table__col-left">
                    <span class="ddd-table__col-name">{c.name}</span>
                  </span>
                  <span class="ddd-table__col-right">
                    <span class="ddd-table__col-type">{c.type}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}
