import { describe, expect, it } from 'vitest';
import type { Ref, Schema } from '../../shared/types';
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
  headerBg: '#181818', edge: '#4a9eff',
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

  it('omits the background rect when background is off', () => {
    const withBg = renderSvg(buildExportModel(source(), { scope: 'all', background: true, filename: 'd' })!, theme, stub).svg;
    const noBg = renderSvg(buildExportModel(source(), { scope: 'all', background: false, filename: 'd' })!, theme, stub).svg;
    expect(withBg).toContain(`fill="${theme.canvas}"`);
    expect(noBg).not.toContain(`fill="${theme.canvas}"`);
  });
});
