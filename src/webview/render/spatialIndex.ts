import type { QualifiedName } from '../../shared/types';

/**
 * Grid-bucketed spatial index for viewport culling.
 * Each node is registered in every cell its bounding box overlaps.
 * Query returns all node names in cells that overlap the query bbox — a superset
 * (caller must filter by actual bbox if exactness matters; for rendering overshoot is fine).
 *
 * Operations O(c) where c = number of cells the node spans (typically 1-4 for our table sizes).
 */

export interface Bbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CELL = 512;

export class SpatialIndex {
  private readonly cells = new Map<string, Set<QualifiedName>>();
  private readonly membership = new Map<QualifiedName, string[]>();
  private readonly bboxes = new Map<QualifiedName, Bbox>();
  private revision = 0;

  /** Bumped on every mutation: culling caches keyed on the instance must also key on this. */
  public get version(): number {
    return this.revision;
  }

  public clear(): void {
    this.revision++;
    this.cells.clear();
    this.membership.clear();
    this.bboxes.clear();
  }

  public insert(name: QualifiedName, bbox: Bbox): void {
    this.remove(name);
    const keys = this.cellKeys(bbox);
    for (const key of keys) {
      let set = this.cells.get(key);
      if (!set) {
        set = new Set();
        this.cells.set(key, set);
      }
      set.add(name);
    }
    this.membership.set(name, keys);
    this.bboxes.set(name, bbox);
    this.revision++;
  }

  public remove(name: QualifiedName): void {
    const prev = this.membership.get(name);
    if (!prev) return;
    for (const key of prev) {
      const set = this.cells.get(key);
      if (!set) continue;
      set.delete(name);
      if (set.size === 0) this.cells.delete(key);
    }
    this.membership.delete(name);
    this.bboxes.delete(name);
    this.revision++;
  }

  public move(name: QualifiedName, bbox: Bbox): void {
    this.insert(name, bbox);
  }

  public getBbox(name: QualifiedName): Bbox | undefined {
    return this.bboxes.get(name);
  }

  public size(): number {
    return this.bboxes.size;
  }

  public query(bbox: Bbox): Set<QualifiedName> {
    const out = new Set<QualifiedName>();
    const cx0 = Math.floor(bbox.x / CELL);
    const cy0 = Math.floor(bbox.y / CELL);
    const cx1 = Math.floor((bbox.x + bbox.w) / CELL);
    const cy1 = Math.floor((bbox.y + bbox.h) / CELL);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const set = this.cells.get(`${cx},${cy}`);
        if (!set) continue;
        for (const name of set) {
          const b = this.bboxes.get(name);
          if (!b) continue;
          if (b.x + b.w < bbox.x) continue;
          if (b.x > bbox.x + bbox.w) continue;
          if (b.y + b.h < bbox.y) continue;
          if (b.y > bbox.y + bbox.h) continue;
          out.add(name);
        }
      }
    }
    return out;
  }

  private cellKeys(bbox: Bbox): string[] {
    const cx0 = Math.floor(bbox.x / CELL);
    const cy0 = Math.floor(bbox.y / CELL);
    const cx1 = Math.floor((bbox.x + bbox.w) / CELL);
    const cy1 = Math.floor((bbox.y + bbox.h) / CELL);
    const keys: string[] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        keys.push(`${cx},${cy}`);
      }
    }
    return keys;
  }
}
