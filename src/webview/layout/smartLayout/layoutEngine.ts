import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';

/**
 * Thin async wrapper over ELK (the compound-graph geometry engine). Isolated in one
 * module so the engine choice is swappable: smartLayout's DB-aware classify/cluster
 * never depend on ELK. Build an `ElkNode` graph (root → cluster containers → table
 * leaves) in layout.ts and hand it here.
 *
 * ELK returns each node's top-left **relative to its parent container**. We flatten
 * to absolute world coords by accumulating the parent-chain offset — the single most
 * error-prone porting step (see layoutEngine.test.ts).
 */

export interface NodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One engine instance is reused across calls — construction spins up ELK's worker.
const elk = new ELK();

/**
 * Lay out a compound graph and return absolute world-coord boxes for every **leaf**
 * node (the tables). Container nodes (clusters) are walked through, not returned.
 */
export async function runElk(graph: ElkNode): Promise<Map<string, NodeBox>> {
  const result = await elk.layout(graph);
  const out = new Map<string, NodeBox>();
  collectLeaves(result, 0, 0, out);
  return out;
}

function collectLeaves(
  node: ElkNode,
  originX: number,
  originY: number,
  out: Map<string, NodeBox>,
): void {
  const children = node.children ?? [];
  for (const child of children) {
    const ax = originX + (child.x ?? 0);
    const ay = originY + (child.y ?? 0);
    if (child.children && child.children.length > 0) {
      collectLeaves(child, ax, ay, out);
    } else {
      out.set(child.id, {
        x: ax,
        y: ay,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
    }
  }
}
