import { describe, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
import type { Ref } from '../../shared/types';
import { isDipRun, routeRefs, type EdgeRoute } from './edgeRouter';
import { SelectedEdgeRuns } from './edgeLayer';

const ref = (id: string, source: string, target: string): Ref => ({
  id,
  source: { table: source, columns: ['a'], relation: '*' },
  target: { table: target, columns: ['b'], relation: '1' },
});
const boxes = (name: string) => ({ t: { x: 0, y: 0, w: 200, h: 100 }, u: { x: 600, y: 300, w: 200, h: 100 } })[name];
const columnY = (_t: string, c: string) => (c === 'a' ? 30 : 70);

type Node = VNode<{ children?: unknown; class?: string; onPointerDown?: (e: unknown) => void }>;

function nodes(v: unknown): Node[] {
  if (Array.isArray(v)) return v.flatMap(nodes);
  if (v == null || typeof v !== 'object' || !('type' in v)) return [];
  const n = v as Node;
  return [n, ...nodes(n.props.children)];
}

function render(route: EdgeRoute) {
  const onSelect = vi.fn();
  const onRunGrab = vi.fn();
  const tree = SelectedEdgeRuns({
    route, hover: null, onRunHover: vi.fn(), onRunUnhover: vi.fn(), onRunGrab, onSelect, onRunDblClick: vi.fn(), onGhostDown: vi.fn(),
  });
  const all = nodes(tree);
  const cls = (n: Node) => n.props.class ?? '';
  return {
    lines: all.filter((n) => n.type === 'line' && cls(n).includes('ddd-edge-segment-handle')),
    handles: all.filter((n) => n.type === 'circle' && /ddd-edge-(handle|ghost)/.test(cls(n))),
    onSelect,
    onRunGrab,
  };
}

const press = () => ({ stopPropagation: vi.fn(), clientX: 0, clientY: 0, button: 0 });

describe('selected self-loop controls (spec 05 §Self-loops)', () => {
  const loop = routeRefs([ref('l', 't', 't')], boxes, columnY)[0]!;

  it('keeps every run hit-testable so a click or right-click on the selected loop stays on it', () => {
    const { lines, handles, onSelect, onRunGrab } = render(loop);
    expect(lines).toHaveLength(loop.segments.length);
    expect(handles).toEqual([]);
    for (const line of lines) {
      line.props.onPointerDown?.(press());
    }
    expect(onSelect).toHaveBeenCalledTimes(loop.segments.length);
    expect(onRunGrab).not.toHaveBeenCalled();
  });

  it('never reads a loop run as a notch, so a double-click cannot write waypoints onto it', () => {
    loop.segments.forEach((_, i) => expect(isDipRun(loop, i)).toBe(false));
  });

  it('an ordinary edge still gets slide handles on its editable runs', () => {
    const edge = routeRefs([ref('e', 't', 'u')], boxes, columnY)[0]!;
    expect(render(edge).handles.length).toBeGreaterThan(0);
  });
});
