import { describe, expect, it } from 'vitest';
import type { Ref, Schema } from '../../shared/types';
import { LOOP_OFFSET, routeRefs } from '../render/edgeRouter';
import { columnCenterY, estimateSize } from '../layout/autoLayout';
import { buildExportModel, renderSvg, type ExportDerived, type ExportSource, type ThemeTokens } from './imageExport';

const schema: Schema = {
  tables: [
    { name: 'public.a', schemaName: 'public', tableName: 'a', columns: [
      { name: 'id', type: 'int', pk: true }, { name: 'label', type: 'varchar', notNull: true },
    ] },
    { name: 'public.b', schemaName: 'public', tableName: 'b', columns: [
      { name: 'id', type: 'int', pk: true }, { name: 'a_id', type: 'int' },
    ] },
  ],
  refs: [],
  groups: [],
};

const ref: Ref = {
  id: 'public.a::id|public.b::a_id',
  source: { table: 'public.a', columns: ['id'], relation: '1' },
  target: { table: 'public.b', columns: ['a_id'], relation: '*' },
};

const derived: ExportDerived = {
  hiddenTables: new Set(),
  collapsedTables: new Set(),
  collapsedNodes: [],
  containers: [],
  effectiveRefs: [ref],
};

function source(selection: Iterable<string> = []): ExportSource {
  return {
    schema,
    positions: new Map([
      ['public.a', { x: 0, y: 0 }],
      ['public.b', { x: 600, y: 400 }],
    ]),
    tableColors: new Map(),
    edgeLayouts: new Map(),
    selection: new Set(selection),
    density: 'cozy',
    derived,
  };
}

const theme: ThemeTokens = {
  canvas: '#101010', surface: '#202020', border: '#404040',
  fg: '#e0e0e0', fgMuted: '#909090', accent: '#4a9eff',
  headerBg: '#181818', edge: '#4a9eff', dep: '#b180d7',
};

describe('buildExportModel — scope', () => {
  it('all: every table + its edges', () => {
    const m = buildExportModel(source(), { scope: 'all', background: true, filename: 'd' })!;
    expect(m.tables.map((t) => t.tableName).sort()).toEqual(['a', 'b']);
    expect(m.edges).toHaveLength(1);
  });

  it('selection: only selected tables, edges needing both endpoints drop', () => {
    const m = buildExportModel(source(['public.a']), { scope: 'selection', background: true, filename: 'd' })!;
    expect(m.tables.map((t) => t.tableName)).toEqual(['a']);
    expect(m.edges).toHaveLength(0); // b not selected → edge a→b excluded
  });

  it('view: clips to the world rect; an edge touching the region is kept', () => {
    const viewRect = { x: -20, y: -20, w: 300, h: 300 }; // covers a only
    const m = buildExportModel(source(), { scope: 'view', background: true, filename: 'd', viewRect })!;
    expect(m.tables.map((t) => t.tableName)).toEqual(['a']);
    expect(m.bounds).toEqual({ x: -20, y: -20, w: 300, h: 300 });
    expect(m.edges).toHaveLength(1); // source endpoint (a) is in view → kept
  });

  it('returns null when the selection is empty', () => {
    expect(buildExportModel(source(), { scope: 'selection', background: true, filename: 'd' })).toBeNull();
  });

  it('all-bounds enclose every table plus padding', () => {
    const m = buildExportModel(source(), { scope: 'all', background: true, filename: 'd' })!;
    expect(m.bounds.x).toBeLessThan(0);
    expect(m.bounds.w).toBeGreaterThan(600);
  });

  it('all-bounds enclose an edge bent outside the table hull', () => {
    const bent = source();
    bent.edgeLayouts = new Map([[ref.id, { waypoints: [{ x: 300, y: -300 }] }]]);
    const m = buildExportModel(bent, { scope: 'all', background: true, filename: 'd' })!;
    expect(m.bounds.y).toBeLessThan(-300);
  });
});

describe('renderSvg', () => {
  const stub = () => '#123456';

  it('emits a self-contained SVG with no unresolved var() and the crow-foot markers', () => {
    const m = buildExportModel(source(), { scope: 'all', background: true, filename: 'd' })!;
    const { svg, width, height } = renderSvg(m, theme, stub);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toContain('var(');
    expect(svg).toContain('id="ddd-mk-many"');
    expect(svg).toContain('marker-end="url(#ddd-mk-many)"'); // target relation '*'
    expect(svg).toContain('marker-start="url(#ddd-mk-one-s)"'); // source relation '1'
    expect(svg).toContain('>a<'); // table name rendered
    expect(width).toBe(m.bounds.w);
    expect(height).toBe(m.bounds.h);
  });

  it('truncating a label never splits a surrogate pair (PNG/clipboard encode the SVG)', () => {
    const emoji = source();
    emoji.schema = {
      ...schema,
      tables: schema.tables.map((t) =>
        t.name === 'public.a' ? { ...t, columns: [{ name: 'abcdefghijklmnop😀xyz', type: 'int' }] } : t,
      ),
    };
    const { svg } = renderSvg(buildExportModel(emoji, { scope: 'all', background: true, filename: 'd' })!, theme, stub);
    expect(() => encodeURIComponent(svg)).not.toThrow();
  });

  it('omits the background rect when background is off', () => {
    const withBg = renderSvg(buildExportModel(source(), { scope: 'all', background: true, filename: 'd' })!, theme, stub).svg;
    const noBg = renderSvg(buildExportModel(source(), { scope: 'all', background: false, filename: 'd' })!, theme, stub).svg;
    expect(withBg).toContain(`fill="${theme.canvas}"`);
    expect(noBg).not.toContain(`fill="${theme.canvas}"`);
  });
});

describe('buildExportModel — deps (spec 18)', () => {
  const withDep = (scope: 'all' | 'selection', selection: string[] = []) => {
    const src = source(selection);
    src.derived = {
      ...derived,
      effectiveDeps: [{
        id: 'dep:public.a::|public.b::',
        upstream: { table: 'public.a', columns: [] },
        downstream: { table: 'public.b', columns: [] },
        name: null,
        note: null,
      }],
    };
    return buildExportModel(src, { scope, background: true, filename: 'd' })!;
  };

  it('exports a shown dep as a dashed arrowed curve in the theme dep color', () => {
    const m = withDep('all');
    expect(m.deps).toHaveLength(1);
    const { svg } = renderSvg(m, theme, (c) => c);
    expect(svg).toContain('stroke="#b180d7" stroke-width="1.6" stroke-dasharray="6 4"');
    expect(svg).toContain('marker-end="url(#ddd-mk-dep)"');
  });

  it('drops a dep whose downstream table is outside the selection', () => {
    expect(withDep('selection', ['public.a']).deps).toEqual([]);
  });
});

describe('buildExportModel — self-loops (spec 05 §Self-loops)', () => {
  const loop: Ref = {
    id: 'public.b::a_id|public.b::id',
    source: { table: 'public.b', columns: ['a_id'], relation: '*' },
    target: { table: 'public.b', columns: ['id'], relation: '1' },
  };

  it('exports the loop and grows the bounds past the table to hold it', () => {
    const plain = source(['public.b']);
    const withLoop = source(['public.b']);
    withLoop.derived = { ...derived, effectiveRefs: [ref, loop] };
    const without = buildExportModel(plain, { scope: 'selection', background: true, filename: 'd' })!;
    const m = buildExportModel(withLoop, { scope: 'selection', background: true, filename: 'd' })!;
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0]!.source.x).toBe(m.edges[0]!.target.x);
    expect(m.bounds.x + m.bounds.w).toBeGreaterThanOrEqual(without.bounds.x + without.bounds.w + LOOP_OFFSET);
  });
});

describe('buildExportModel — loops yield a lane to a passing Z (spec 05 §Self-loops)', () => {
  const table = (name: string, cols: number) => ({
    name, schemaName: 'public', tableName: name, columns: Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: 'int' })),
  });
  const r = (id: string, s: string, sc: string, t: string, tc: string): Ref =>
    ({ id, source: { table: s, columns: [sc], relation: '*' }, target: { table: t, columns: [tc], relation: '1' } });
  const refs = [r('emp-a', 'emp', 'c1', 'emp', 'c0'), r('emp-b', 'emp', 'c2', 'emp', 'c0'), r('dept-audit', 'dept', 'c2', 'audit', 'c0')];
  const cols: Record<string, number> = { emp: 5, dept: 3, audit: 3 };
  const w = estimateSize(5).width;
  const positions = new Map([['emp', { x: 0, y: 0 }], ['dept', { x: 0, y: estimateSize(5).height + 16 }], ['audit', { x: w + 64, y: 0 }]]);

  it('draws the same claimed lane as the live router', () => {
    const src: ExportSource = {
      schema: { tables: Object.entries(cols).map(([n, c]) => table(n, c)), refs, groups: [] },
      positions, tableColors: new Map(), edgeLayouts: new Map(), selection: new Set(), density: 'cozy',
      derived: { ...derived, effectiveRefs: refs },
    };
    const m = buildExportModel(src, { scope: 'all', background: true, filename: 'd' })!;
    const bboxOf = (n: string) => {
      const p = positions.get(n)!;
      const size = estimateSize(cols[n]!);
      return { x: p.x, y: p.y, w: size.width, h: size.height };
    };
    const colY = (_t: string, c: string) => columnCenterY(Number(c.slice(1)));
    const live = routeRefs(refs, bboxOf, colY, undefined, undefined, () => positions.keys());
    expect(live.find((e) => e.id === 'dept-audit')!.laneClaim).toBe(true);
    expect(m.edges.map((e) => e.d)).toEqual(live.map((e) => e.d));
  });
});
