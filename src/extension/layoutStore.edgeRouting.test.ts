import { describe, expect, it } from 'vitest';
import { emptyLayout, mergeLayout, parseLayout, serializeLayout, serializeSharedLayout } from './layoutStore';
import { mergeThreeWay } from './mergeThreeWay';
import { applyDecisions } from './mergeResolver';
import { applyViewState, emptyViewState } from './viewStateStore';
import { EDGE_ROUTING_VERSION, hasRefEdgeShapes, type Layout } from '../shared/types';

const REF = 'public.a::fk|public.b::id';
const DEP = 'dep:public.a::x|public.b::y';

const layout = (overrides: Partial<Layout> = {}): Layout => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: { 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } },
  groups: {},
  edges: {},
  ...overrides,
});

const legacyText = (edges: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, ...extra, tables: { 'public.a': { x: 0, y: 0 } }, groups: {}, edges });

describe('edgeRouting marker — reader (spec 03)', () => {
  it('reads a marked file as is', () => {
    const l = parseLayout(legacyText({ [REF]: { sourceSide: 'bottom' } }, { edgeRouting: 2 }));
    expect(l.edgeRouting).toBe(2);
  });

  it('keeps a pre-0.4 file with FK shapes unmarked: the user has not decided yet', () => {
    for (const shape of [{ waypoints: [{ x: 1, y: 2 }] }, { sourceSide: 'left' }, { targetSide: 'top' }, { dx: 10 }]) {
      expect(parseLayout(legacyText({ [REF]: shape })).edgeRouting).toBeUndefined();
    }
  });

  it('stamps an unmarked file with nothing to migrate (colors, dep curves, no edges)', () => {
    expect(parseLayout(legacyText({})).edgeRouting).toBe(EDGE_ROUTING_VERSION);
    expect(parseLayout(legacyText({ [REF]: { color: '#abc' } })).edgeRouting).toBe(EDGE_ROUTING_VERSION);
    expect(parseLayout(legacyText({ [DEP]: { waypoints: [{ x: 1, y: 2 }] } })).edgeRouting).toBe(EDGE_ROUTING_VERSION);
    // ≤0.2.8 `Ref.id` keys resolve to no edge: the webview drops them, so they are nothing to migrate.
    expect(parseLayout(legacyText({ 'public.a(fk)->public.b(id)': { sourceSide: 'top' } })).edgeRouting).toBe(EDGE_ROUTING_VERSION);
  });

  it('stamps a file whose only FK shapes are self-loop flips: "Update relations" would change nothing', () => {
    const loop = 'public.a::parent_id|public.a::id';
    expect(parseLayout(legacyText({ [loop]: { sourceSide: 'left', targetSide: 'left' } })).edgeRouting).toBe(EDGE_ROUTING_VERSION);
    // A loop does not hide a real FK shape beside it, nor does a table whose name prefixes another.
    expect(parseLayout(legacyText({ [loop]: { sourceSide: 'left' }, [REF]: { dx: 4 } })).edgeRouting).toBeUndefined();
    expect(parseLayout(legacyText({ 'public.a::x|public.ab::id': { sourceSide: 'left' } })).edgeRouting).toBeUndefined();
  });

  it('ignores a malformed marker', () => {
    for (const bad of ['2', 0, -1, 1.5, null, true]) {
      expect(parseLayout(legacyText({ [REF]: { sourceSide: 'left' } }, { edgeRouting: bad })).edgeRouting).toBeUndefined();
    }
  });

  it('preserves a marker newer than this build', () => {
    expect(parseLayout(legacyText({ [REF]: { sourceSide: 'left' } }, { edgeRouting: 7 })).edgeRouting).toBe(7);
  });

  it('a brand-new diagram starts marked', () => {
    expect(emptyLayout().edgeRouting).toBe(EDGE_ROUTING_VERSION);
  });
});

describe('edgeRouting marker — writer (spec 03)', () => {
  it('writes it in a fixed slot right after `version`, in both forms', () => {
    const l = layout({ edgeRouting: 2, edges: { [REF]: { sourceSide: 'left' } } });
    for (const text of [serializeSharedLayout(l), serializeLayout(l)]) {
      const lines = text.split('\n');
      expect(lines[1]).toBe('  "version": 1,');
      expect(lines[2]).toBe('  "edgeRouting": 2,');
    }
  });

  it('round-trips byte-identical, marked or pending', () => {
    const marked = serializeSharedLayout(layout({ edgeRouting: 2, edges: { [REF]: { waypoints: [{ x: 3, y: 4 }] } } }));
    expect(serializeSharedLayout(parseLayout(marked))).toBe(marked);
    const pending = serializeSharedLayout(layout({ edges: { [REF]: { waypoints: [{ x: 3, y: 4 }] } } }));
    expect(pending).not.toContain('edgeRouting');
    expect(serializeSharedLayout(parseLayout(pending))).toBe(pending);
    expect(JSON.parse(marked)).toMatchObject({ edgeRouting: 2 });
  });

  it('an ordinary write of a pending file does not stamp it (the notice must still ask)', () => {
    const pending = layout({ edges: { [REF]: { sourceSide: 'bottom' } } });
    const afterDrag = mergeLayout(pending, { tables: { 'public.a': { x: 10, y: 0 } } });
    expect(serializeSharedLayout(afterDrag)).not.toContain('edgeRouting');
  });

  it('stamps a pending file once no FK shape is left, even without an answer', () => {
    const pending = layout({ edges: { [REF]: { sourceSide: 'bottom', color: '#abc' } } });
    const reset = mergeLayout(pending, { edges: { [REF]: { color: '#abc' } } });
    expect(serializeSharedLayout(reset)).toContain('"edgeRouting": 2,');
  });

  it('a file with nothing to migrate stays byte-stable once read (no forced write on open)', () => {
    const text = serializeSharedLayout(parseLayout(legacyText({ [REF]: { color: '#abc' } })));
    expect(serializeSharedLayout(parseLayout(text))).toBe(text);
  });
});

describe('edgeRouting marker — host merges (spec 03 / 14)', () => {
  it('a persist that omits the marker keeps the current one; a persist that carries it wins', () => {
    const current = layout({ edgeRouting: 2 });
    expect(mergeLayout(current, { tables: {} }).edgeRouting).toBe(2);
    expect(mergeLayout(layout(), { edgeRouting: 2 }).edgeRouting).toBe(2);
    expect(mergeLayout(layout(), { tables: {} }).edgeRouting).toBeUndefined();
  });

  it('3-way: both marked → the newer; an unmarked side keeps the result unmarked', () => {
    const marked = layout({ edgeRouting: 2 });
    const newer = layout({ edgeRouting: 3 });
    const pending = layout({ edges: { [REF]: { sourceSide: 'bottom' } } });
    expect(mergeThreeWay(marked, marked, newer).merged.edgeRouting).toBe(3);
    expect(mergeThreeWay(pending, marked, pending).merged.edgeRouting).toBeUndefined();
    expect(mergeThreeWay(pending, pending, marked).merged.edgeRouting).toBeUndefined();
  });

  it('3-way: theirs answered "Update" while ours kept the old shapes untouched → no shape left → stamped on write', () => {
    const base = parseLayout(serializeSharedLayout(layout({ edges: { [REF]: { sourceSide: 'bottom' } } })));
    const theirs = parseLayout(serializeSharedLayout(layout({ edgeRouting: 2, edges: {} })));
    const { merged, conflicts } = mergeThreeWay(base, base, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.edgeRouting).toBeUndefined();
    expect(hasRefEdgeShapes(Object.entries(merged.edges ?? {}))).toBe(false);
    expect(serializeSharedLayout(merged)).toContain('"edgeRouting": 2,');
  });

  it('survives conflict resolution and the view-state split', () => {
    const merged = layout({ edgeRouting: 2 });
    expect(applyDecisions(merged, [], {}).edgeRouting).toBe(2);
    expect(applyViewState(merged, emptyViewState()).edgeRouting).toBe(2);
    expect(applyViewState(layout(), emptyViewState()).edgeRouting).toBeUndefined();
  });
});
