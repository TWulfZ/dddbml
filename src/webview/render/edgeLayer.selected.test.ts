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

describe('selected edge between close aligned tables (spec 05 §2)', () => {
  // 40 px gap, same row: 10 px stubs and a 20 px middle split at its midpoint into two 10 px halves.
  const close = (name: string) => ({ t: { x: 0, y: 0, w: 200, h: 100 }, u: { x: 240, y: 0, w: 200, h: 100 } })[name];
  const sameRow = () => 30;
  const edge = routeRefs([ref('e', 't', 'u')], close, sameRow)[0]!;
  const halves = edge.segments.map((s, i) => ({ s, i })).filter(({ s }) => !s.rigid);

  it('has two short editable halves', () => {
    expect(halves.map(({ s }) => Math.abs(s.x2 - s.x1))).toEqual([10, 10]);
  });

  it('grabs either half from its hit line even though it is too short for a knob', () => {
    const { lines, handles, onSelect, onRunGrab } = render(edge);
    expect(handles).toEqual([]);
    for (const { i } of halves) lines[i]!.props.onPointerDown?.(press());
    expect(onRunGrab).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('selected narrow-gap S (spec 05 §1)', () => {
  // 10 px gap, rows 30 / 270: full stubs cross, so the middle is down 120, across 38, down 120.
  const narrow = (name: string) => ({ t: { x: 0, y: 0, w: 200, h: 100 }, u: { x: 210, y: 240, w: 200, h: 100 } })[name];
  const rows = () => 30;
  const edge = routeRefs([ref('e', 't', 'u')], narrow, rows)[0]!;
  const runs = edge.segments.map((s, i) => ({ s, i })).filter(({ s }) => !s.rigid);

  it('exposes its three middle runs, each with a slide knob', () => {
    expect(runs.map(({ s }) => s.axis)).toEqual(['v', 'h', 'v']);
    const { lines, handles, onRunGrab } = render(edge);
    expect(handles.filter((h) => (h.props.class ?? '').includes('ddd-edge-handle'))).toHaveLength(3);
    for (const { i } of runs) lines[i]!.props.onPointerDown?.(press());
    expect(onRunGrab).toHaveBeenCalledTimes(3);
  });
});
