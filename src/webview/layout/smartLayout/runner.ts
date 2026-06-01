import type { EdgeLayout, QualifiedName } from '../../../shared/types';
import { store, isCanvasReadOnly } from '../../state/store';
import { buildArrangeCommand, buildEdgesResetCommand } from '../../state/history';
import { schedulePersist } from '../../persistence';
import { postToHost } from '../../vscode';
import { estimateSize } from '../autoLayout';
import { smartLayout, type SmartLayoutMode } from './layout';
import { computeEdgeResets, computeSelectionEdgeResets, movedNames } from './edgeReset';
import { computeEdgeOrdering } from './edgeOrdering';

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

/** Begin a progress run: supersede any prior run, show the overlay, return its signal + reporter. */
function beginProgress(): { signal: AbortSignal; onProgress: (p: number) => void } {
  activeArrange?.abort();
  activeArrange = new AbortController();
  store.getState().startEdgeOrderProgress();
  return {
    signal: activeArrange.signal,
    onProgress: (p) => store.getState().setEdgeOrderProgress(p),
  };
}

/** Cancel the in-flight edge-ordering run (the overlay's Cancel button). Discards — no command pushed. */
export function cancelEdgeOrdering(): void {
  activeArrange?.abort();
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
export async function runSmartLayout(mode: SmartLayoutMode, opts: ArrangeOptions = {}): Promise<void> {
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
  const strandedResets = computeEdgeResets(s.schema.refs, moved, edgesBefore);

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
  const { signal, onProgress } = beginProgress();
  let ordered: Array<[string, EdgeLayout]>;
  try {
    const res = await computeEdgeOrdering({
      schema: s.schema,
      positions: result,
      existingLayouts: edgesBefore,
      preserveManual,
      signal,
      onProgress,
    });
    ordered = res.resets;
  } catch {
    // Aborted (or engine error): apply NOTHING. Tables were never moved → true no-op.
    store.getState().endEdgeOrderProgress();
    activeArrange = null;
    return;
  }
  store.getState().endEdgeOrderProgress();
  activeArrange = null;
  if (signal.aborted) return;

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

  const { signal, onProgress } = beginProgress();
  let ordered: Array<[string, EdgeLayout]>;
  try {
    const res = await computeEdgeOrdering({
      schema: s.schema,
      positions,
      existingLayouts: edgesBefore,
      preserveManual,
      signal,
      onProgress,
    });
    ordered = res.resets;
  } catch {
    store.getState().endEdgeOrderProgress();
    activeArrange = null;
    return;
  }
  store.getState().endEdgeOrderProgress();
  activeArrange = null;
  if (signal.aborted || ordered.length === 0) return;

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
  const resets = computeSelectionEdgeResets(s.schema.refs, s.selection, s.edgeLayouts);
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
  return computeSelectionEdgeResets(s.schema.refs, s.selection, s.edgeLayouts).length;
}
