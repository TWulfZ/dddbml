import type { AutoArrangeMode, EdgeLayout, QualifiedName, Ref } from '../../../shared/types';
import { store, isCanvasReadOnly, type AppState } from '../../state/store';
import { buildArrangeCommand, buildEdgesResetCommand } from '../../state/history';
import { schedulePersist } from '../../persistence';
import { postToHost } from '../../vscode';
import { estimateSize } from '../autoLayout';
import { smartLayout } from './layout';
import { computeAutoShapeDrops, computeDepStrandResets, computeEdgeResets, computeSelectionDepResets, computeSelectionEdgeResets, movedNames, rawLayoutRefs } from './edgeReset';
import { computeEdgeOrdering } from './edgeOrdering';
import { edgeKeyedDeps, edgeKeyedRefs, type KeyedDepEdge } from '../../render/edgeKey';

/**
 * Options for an on-demand arrange. Both default ON (spec 05 §9): a table-arrange also orders the
 * edges, preserving any edge the user already shaped by hand.
 */
export interface ArrangeOptions {
  orderEdges?: boolean;
  preserveManualEdges?: boolean;
}

/**
 * Live AbortController for the in-flight edge-ordering run. Kept as a module singleton (not in the
 * store — it is non-serializable and must not break Object.is selector equality). A new run aborts
 * any prior one so a second arrange supersedes the first.
 */
let activeArrange: AbortController | null = null;

/**
 * Begin a progress run: supersede any prior run and show the overlay. Progress and cleanup are
 * gated on `activeArrange === ctrl`, so a superseded run finishing late cannot hide the new run's
 * overlay, detach its Cancel, or bump its bar (audit F45).
 */
function beginProgress(): { ctrl: AbortController; onProgress: (p: number) => void } {
  activeArrange?.abort();
  const ctrl = new AbortController();
  activeArrange = ctrl;
  store.getState().startEdgeOrderProgress();
  return {
    ctrl,
    onProgress: (p) => {
      if (activeArrange === ctrl) store.getState().setEdgeOrderProgress(p);
    },
  };
}

function endProgress(ctrl: AbortController): void {
  if (activeArrange !== ctrl) return;
  activeArrange = null;
  store.getState().endEdgeOrderProgress();
}

/**
 * True when the state an A* run was computed from is no longer current: a user edit or undo, a host
 * layout/schema push, or a merge/time-travel entered during the await. Applying anyway would clobber
 * those edits and record undo against a state that no longer exists (audit F44). Zustand updates
 * are immutable, so reference identity suffices.
 */
function staleSince(s: AppState): boolean {
  const now = store.getState();
  return (
    now.positions !== s.positions ||
    now.edgeLayouts !== s.edgeLayouts ||
    now.schema !== s.schema ||
    isCanvasReadOnly(now)
  );
}

/** Cancel the in-flight edge-ordering run (the overlay's Cancel button). Discards — no command pushed. */
export function cancelEdgeOrdering(): void {
  activeArrange?.abort();
}

/**
 * Schema refs re-keyed like the rendered edges, so results land on the `edgeLayouts` keys the
 * renderer reads. Hidden/collapsed endpoints are dropped: A* and the resets work on raw table
 * geometry, and those edges' layouts live under group-mapped keys.
 */
function offTables(s: AppState): Set<QualifiedName> {
  const off = new Set<QualifiedName>(s.hiddenTables);
  for (const g of s.schema.groups) {
    const st = s.groups[g.name];
    if (st?.hidden || st?.collapsed) for (const t of g.tables) off.add(t);
  }
  return off;
}

function layoutRefs(s: AppState): Ref[] {
  const off = offTables(s);
  return edgeKeyedRefs(s.schema.refs, (t) => (off.has(t) ? null : t)).refs;
}

function layoutDeps(s: AppState): KeyedDepEdge[] {
  const off = offTables(s);
  return edgeKeyedDeps(s.schema.deps ?? [], (t) => (off.has(t) ? null : t));
}

function selectionResets(s: AppState): Array<[string, EdgeLayout | null]> {
  return [
    ...computeSelectionEdgeResets(layoutRefs(s), s.selection, s.edgeLayouts),
    ...computeSelectionDepResets(layoutDeps(s), s.selection, s.edgeLayouts),
  ];
}

/** Merge stranded table-arrange resets with A* SET pairs; A* wins for an overlapping ref id. */
function mergeResets(
  stranded: Array<[string, EdgeLayout | null]>,
  ordered: Array<[string, EdgeLayout]>,
): Array<[string, EdgeLayout | null]> {
  const map = new Map<string, EdgeLayout | null>(stranded);
  for (const [id, layout] of ordered) map.set(id, layout);
  return [...map];
}

/**
 * Host glue: read state → run smart layout → (optionally) A*-order edges → batch-apply positions +
 * edge resets as a single undoable ArrangeCommand → schedule persist.
 *
 * `smartLayout` (dagre two-level) is synchronous. When `orderEdges` is on the function awaits the A*
 * engine, so the store is mutated EXACTLY ONCE, only on success: A* routes against the COMPUTED (not
 * yet applied) positions, and on abort nothing is applied (critic G2 — atomic, cancel = no-op).
 */
export async function runSmartLayout(mode: AutoArrangeMode, opts: ArrangeOptions = {}): Promise<void> {
  const orderEdges = opts.orderEdges ?? true;
  const preserveManual = opts.preserveManualEdges ?? true;

  const s = store.getState();
  if (s.schema.tables.length === 0) return;
  if (isCanvasReadOnly(s)) return; // blocking merge / git overlay (spec 14/16): the layout is read-only

  const colCount = new Map<QualifiedName, number>();
  for (const t of s.schema.tables) colCount.set(t.name, t.columns.length);
  const sizeOf = (name: QualifiedName) => estimateSize(colCount.get(name) ?? 0);

  const before = new Map(s.positions);
  const edgesBefore = new Map(s.edgeLayouts);

  let result: Map<QualifiedName, { x: number; y: number }>;
  try {
    result = smartLayout({
      tables: s.schema.tables,
      refs: s.schema.refs,
      groups: s.schema.groups,
      sizeOf,
      mode,
      existing: before,
      selection: s.selection,
      spacing: s.settings.ui.layoutSpacing,
    });
  } catch (err) {
    postToHost({
      type: 'error:log',
      payload: { message: `smart auto-layout failed: ${String(err)}`, stack: err instanceof Error ? err.stack : undefined },
    });
    return;
  }
  if (result.size === 0) return;

  const moved = movedNames(before, result);
  // Auto shapes are checked on every schema ref: one whose other endpoint is hidden or collapsed
  // is still A*'s and still stale once the visible endpoint moves.
  const strandedResets = [
    ...computeEdgeResets(layoutRefs(s), moved, edgesBefore),
    ...computeAutoShapeDrops(rawLayoutRefs(s.schema.refs), moved, edgesBefore),
    ...computeDepStrandResets(layoutDeps(s), moved, edgesBefore),
  ];

  if (!orderEdges) {
    // Original behavior: clear stranded waypoints, no A*.
    store.getState().setPositionsBatch([...result]);
    if (strandedResets.length > 0) store.getState().applyEdgeLayouts(strandedResets);
    const cmd = buildArrangeCommand(before, store.getState().positions, edgesBefore, strandedResets);
    if (cmd) store.getState().pushArrangeCommand(cmd);
    schedulePersist();
    return;
  }

  // Order edges against the COMPUTED positions (NOT the store — it still holds the old ones).
  const { ctrl, onProgress } = beginProgress();
  const { signal } = ctrl;
  let ordered: Array<[string, EdgeLayout]>;
  try {
    const res = await computeEdgeOrdering({
      schema: { ...s.schema, refs: layoutRefs(s) },
      positions: result,
      existingLayouts: edgesBefore,
      preserveManual,
      signal,
      onProgress,
    });
    ordered = res.resets;
  } catch (err) {
    // Aborted (or engine error): apply NOTHING. Tables were never moved → true no-op.
    if (!signal.aborted) console.error('[dddbml] edge ordering failed', err);
    endProgress(ctrl);
    return;
  }
  endProgress(ctrl);
  if (signal.aborted || staleSince(s)) return;

  // Atomic apply: positions + merged edge resets + one composite command, no await in between.
  const merged = mergeResets(strandedResets, ordered);
  store.getState().setPositionsBatch([...result]);
  if (merged.length > 0) store.getState().applyEdgeLayouts(merged);
  const cmd = buildArrangeCommand(before, store.getState().positions, edgesBefore, merged);
  if (cmd) store.getState().pushArrangeCommand(cmd);
  schedulePersist();
}

/**
 * Order edges only — tables stay fixed (spec 05 §9 "Order edges only"). Routes A* against the
 * CURRENT positions, applies the result as an edges-only ArrangeCommand (empty positions) so one
 * Ctrl+Z restores the prior edge shapes. Cancelable; abort pushes no command.
 */
export async function runEdgeOrdering(opts: { preserveManual?: boolean } = {}): Promise<void> {
  const preserveManual = opts.preserveManual ?? true;
  const s = store.getState();
  if (s.schema.tables.length === 0) return;
  if (isCanvasReadOnly(s)) return;

  const positions = new Map(s.positions);
  const edgesBefore = new Map(s.edgeLayouts);

  const { ctrl, onProgress } = beginProgress();
  const { signal } = ctrl;
  let ordered: Array<[string, EdgeLayout]>;
  try {
    const res = await computeEdgeOrdering({
      schema: { ...s.schema, refs: layoutRefs(s) },
      positions,
      existingLayouts: edgesBefore,
      preserveManual,
      signal,
      onProgress,
    });
    ordered = res.resets;
  } catch (err) {
    if (!signal.aborted) console.error('[dddbml] edge ordering failed', err);
    endProgress(ctrl);
    return;
  }
  endProgress(ctrl);
  if (signal.aborted || ordered.length === 0 || staleSince(s)) return;

  store.getState().applyEdgeLayouts(ordered);
  const cmd = buildEdgesResetCommand(
    edgesBefore,
    ordered,
    `Order ${ordered.length} edge${ordered.length === 1 ? '' : 's'}`,
  );
  if (cmd) store.getState().pushArrangeCommand(cmd);
  schedulePersist();
}

/**
 * Reset the relations of the currently-selected tables: every edge touching the selection
 * is reset to default routing (waypoints + legacy + sides cleared, color kept). One undoable
 * step. No-op when nothing is selected or nothing has a manual shape.
 */
export function resetSelectedEdges(): void {
  const s = store.getState();
  if (s.selection.size === 0) return;

  const edgesBefore = new Map(s.edgeLayouts);
  const resets = selectionResets(s);
  if (resets.length === 0) return;

  store.getState().applyEdgeLayouts(resets);
  const cmd = buildEdgesResetCommand(
    edgesBefore,
    resets,
    `Reset ${resets.length} relation${resets.length === 1 ? '' : 's'}`,
  );
  if (cmd) store.getState().pushArrangeCommand(cmd);
  schedulePersist();
}

/** Count of selected tables' edges that currently carry a manual shape (for menu labels). */
export function countResettableSelectionEdges(): number {
  const s = store.getState();
  if (s.selection.size === 0) return 0;
  return selectionResets(s).length;
}
