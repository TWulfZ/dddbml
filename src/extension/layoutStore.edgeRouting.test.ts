import { describe, expect, it } from 'vitest';
import { emptyLayout, mergeLayout, parseLayout, serializeLayout, serializeSharedLayout } from './layoutStore';
import { mergeThreeWay } from './mergeThreeWay';
import { applyDecisions } from './mergeResolver';
import { applyViewState, emptyViewState } from './viewStateStore';
import { EDGE_ROUTING_VERSION, type Layout } from '../shared/types';

const REF = 'public.a::fk|public.b::id';

const layout = (overrides: Partial<Layout> = {}): Layout => ({
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  tables: { 'public.a': { x: 0, y: 0 }, 'public.b': { x: 400, y: 0 } },
  groups: {},
  edges: {},
  ...overrides,
});

const fileText = (edges: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, ...extra, tables: { 'public.a': { x: 0, y: 0 } }, groups: {}, edges });

describe('edgeRouting marker — reader (spec 03)', () => {
  it('keeps a valid marker, a newer one included', () => {
    expect(parseLayout(fileText({}, { edgeRouting: 2 })).edgeRouting).toBe(2);
    expect(parseLayout(fileText({}, { edgeRouting: 7 })).edgeRouting).toBe(7);
  });

  it('an unmarked file (≤ 0.4.0) reads as unmarked, shapes or not: nothing waits on an answer', () => {
    expect(parseLayout(fileText({})).edgeRouting).toBeUndefined();
    expect(parseLayout(fileText({ [REF]: { waypoints: [{ x: 1, y: 2 }], sourceSide: 'left' } })).edgeRouting).toBeUndefined();
  });

  it('ignores a malformed marker', () => {
    for (const bad of ['2', 0, -1, 1.5, null, true]) {
      expect(parseLayout(fileText({}, { edgeRouting: bad })).edgeRouting).toBeUndefined();
    }
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

  it('stamps an unmarked layout with the current router and keeps a newer marker', () => {
    expect(serializeSharedLayout(layout({ edges: { [REF]: { waypoints: [{ x: 3, y: 4 }] } } }))).toContain('"edgeRouting": 2,');
    expect(serializeSharedLayout(layout({ edgeRouting: 7 }))).toContain('"edgeRouting": 7,');
  });

  it('a marked file round-trips byte-identical (0.4.1 files never churn)', () => {
    const marked = serializeSharedLayout(layout({ edgeRouting: 2, edges: { [REF]: { waypoints: [{ x: 3, y: 4 }] } } }));
    expect(serializeSharedLayout(parseLayout(marked))).toBe(marked);
  });

  it('an unmarked file has the same shared form once read, so opening it never forces a write', () => {
    const text = fileText({ [REF]: { waypoints: [{ x: 3, y: 4 }] } });
    const read = serializeSharedLayout(parseLayout(text));
    expect(read).toContain('"edgeRouting": 2,');
    // The churn guard compares against this form: a write that changes nothing else stays skipped.
    expect(serializeSharedLayout(mergeLayout(parseLayout(text), {}))).toBe(read);
  });
});

describe('edgeRouting marker — host merges (spec 03 / 14)', () => {
  it('a persist (which never carries the marker) keeps the current one', () => {
    expect(mergeLayout(layout({ edgeRouting: 7 }), { tables: {} }).edgeRouting).toBe(7);
    expect(mergeLayout(layout(), { tables: {} }).edgeRouting).toBeUndefined();
  });

  it('3-way: the newer marker wins; one unmarked side does not unmark the result', () => {
    const marked = layout({ edgeRouting: 2 });
    const newer = layout({ edgeRouting: 3 });
    const unmarked = layout();
    expect(mergeThreeWay(marked, marked, newer).merged.edgeRouting).toBe(3);
    expect(mergeThreeWay(unmarked, unmarked, marked).merged.edgeRouting).toBe(2);
    expect(mergeThreeWay(unmarked, marked, unmarked).merged.edgeRouting).toBe(2);
    expect(mergeThreeWay(unmarked, unmarked, unmarked).merged.edgeRouting).toBeUndefined();
  });

  it('survives conflict resolution and the view-state split', () => {
    const merged = layout({ edgeRouting: 2 });
    expect(applyDecisions(merged, [], {}).edgeRouting).toBe(2);
    expect(applyViewState(merged, emptyViewState()).edgeRouting).toBe(2);
    expect(applyViewState(layout(), emptyViewState()).edgeRouting).toBeUndefined();
  });
});
