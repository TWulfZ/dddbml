import type { QualifiedName } from '../../shared/types';

type PositionsMap = ReadonlyMap<QualifiedName, unknown>;

interface DeltaEntry {
  from: number;
  to: number;
  names: readonly QualifiedName[];
}

// Versions are keyed weakly and the log holds only names, so no superseded 5000-entry positions map
// is ever retained by this side channel.
const versions = new WeakMap<PositionsMap, number>();
const log: DeltaEntry[] = [];
let seq = 0;
/** Several store writes can land between two renders (Preact batches them); a drag needs ~1. */
const LOG_CAPACITY = 16;
/** Above this share of moved tables an incremental update stops paying off: rebuild instead. */
const MAX_INCREMENTAL_SHARE = 1 / 4;

function versionOf(map: PositionsMap): number {
  let v = versions.get(map);
  if (v === undefined) {
    v = ++seq;
    versions.set(map, v);
  }
  return v;
}

/** Records that `next` is `prev` with only `names` (re)positioned. Called by the store's position setters. */
export function recordPositionsDelta(prev: PositionsMap, next: PositionsMap, names: readonly QualifiedName[]): void {
  const from = versionOf(prev);
  const to = ++seq;
  versions.set(next, to);
  log.push({ from, to, names });
  if (log.length > LOG_CAPACITY) log.shift();
}

/**
 * Names whose position differs between two positions maps, when `next` descends from `prev` through
 * recorded deltas only; null when the lineage is unknown (layout load, undo, a reset…) and the
 * caller must rebuild from scratch.
 */
export function positionsMovedSince(prev: PositionsMap, next: PositionsMap): Set<QualifiedName> | null {
  const moved = new Set<QualifiedName>();
  if (prev === next) return moved;
  const target = versions.get(prev);
  let cur = versions.get(next);
  if (target === undefined || cur === undefined) return null;
  for (let i = log.length - 1; i >= 0 && cur !== target; i--) {
    const e = log[i]!;
    if (e.to !== cur) continue;
    for (const n of e.names) moved.add(n);
    cur = e.from;
  }
  return cur === target ? moved : null;
}

/** `positionsMovedSince`, but null when so much moved that a full rebuild is the cheaper path. */
export function smallPositionsDelta(prev: PositionsMap, next: PositionsMap): Set<QualifiedName> | null {
  const moved = positionsMovedSince(prev, next);
  if (!moved || moved.size > Math.max(1, next.size * MAX_INCREMENTAL_SHARE)) return null;
  return moved;
}
