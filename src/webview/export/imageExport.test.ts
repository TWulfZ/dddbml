import { schemaForView } from '../layout/diagramView';
import { SceneCache } from '../render/sceneCache';
import { buildRowGeometry, fkColumnsByTable } from '../layout/tableRows';
import { describe, expect, it } from 'vitest';
import type { Ref, Schema } from '../../shared/types';
import { LOOP_OFFSET, routeRefs } from '../render/edgeRouter';
import { printTableWidth, estimateTextWidth } from '../layout/printTable';
import { crossesTable } from '../render/portRoute';
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
    expect(noBg).not.toMatch(new RegExp(`<rect[^>]*fill="${theme.canvas}"`));
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

describe('DBML relationship rendering', () => {
  it.each(['1', '*'] as const)('exports optional %s endpoints and DBML color', (relation) => {
    const src = source();
    src.derived = { ...derived, effectiveRefs: [{ ...ref, color: '#ff0000',
      source: { ...ref.source, relation, optional: true },
      target: { ...ref.target, relation, optional: true },
    }] };
    const model = buildExportModel(src, { scope: 'all', background: true, filename: 'd' })!;
    const kind = relation === '*' ? 'many' : 'one';
    expect(model.edges[0]).toMatchObject({ color: '#ff0000', startMarker: `url(#ddd-mk-${kind}-optional-s)`, endMarker: `url(#ddd-mk-${kind}-optional)` });
    const { svg } = renderSvg(model, theme, (c) => c);
    expect(svg).toContain(`marker-start="url(#ddd-mk-${kind}-optional-s)"`);
    expect(svg).toContain(`marker-end="url(#ddd-mk-${kind}-optional)"`);
    expect(svg).toContain('stroke="#ff0000"');
    expect(svg).toContain('circle cx="4" cy="6" r="3"');
    src.edgeLayouts = new Map([[ref.id, { color: '#00ff00' }]]);
    expect(buildExportModel(src, { scope: 'all', background: true, filename: 'd' })!.edges[0]!.color).toBe('#00ff00');
  });
});

it('does not overlay direction dots on cardinality symbols', () => {
  const model = buildExportModel(source(), { scope: 'all', background: true, filename: 'd' })!;
  const { svg } = renderSvg(model, theme, (c) => c);
  expect(svg).not.toContain(`<circle cx="${model.edges[0]!.source.x}" cy="${model.edges[0]!.source.y}" r="3"`);
  expect(svg).not.toContain(`<circle cx="${model.edges[0]!.target.x}" cy="${model.edges[0]!.target.y}" r="3"`);
});

it('exports the saved free endpoint positions on top and bottom borders', () => {
  const src = source();
  src.edgeLayouts = new Map([[ref.id, { sourceSide: 'top', sourcePort: .25, targetSide: 'bottom', targetPort: .75 }]]);
  const model = buildExportModel(src, { scope: 'all', background: true, filename: 'd' })!;
  expect(model.edges[0]!.source).toEqual({ x: 60, y: 0 });
  expect(model.edges[0]!.target).toEqual({ x: 780, y: 480 });
});

describe('printer-friendly SVG', () => {
  const opts = { scope: 'all', background: false, filename: 'diagram', printerFriendly: true } as const;

  it('widens the tables for full labels and uses schema-defined keys and print colors', () => {
    const input = source();
    const longName = 'descriptive_foreign_key_column_ending_in_ID';
    const longType = 'character varying(255)';
    const composite = {
      ...ref,
      source: { ...ref.source, columns: ['id', 'label'] },
      target: { ...ref.target, columns: [longName, 'id'], optional: true },
    };
    input.schema = {
      ...schema,
      refs: [composite],
      tables: [schema.tables[0]!, {
        ...schema.tables[1]!,
        columns: [{ name: longName, type: longType, pk: true }, { name: 'id', type: 'int' }],
      }],
    };
    input.derived = { ...derived, effectiveRefs: [composite] };
    input.positions.set('public.a', { x: 300, y: 25 });
    input.positions.set('public.b', { x: 0, y: 0 });
    input.tableColors.set('public.b', '#123456');

    const model = buildExportModel(input, opts)!;
    const [a, b] = model.tables;
    const { svg } = renderSvg(model, theme, () => '#123456');
    expect(a!.columns.map((c) => c.key)).toEqual(['PK', '']);
    expect(b!.columns.map((c) => c.key)).toEqual(['FK', 'FK']);
    expect(b!.w).toBeGreaterThan(240);
    expect(a!.x).toBeGreaterThan(b!.x + b!.w);
    expect(input.positions.get('public.a')).toEqual({ x: 300, y: 25 });
    expect(model.edges[0]?.corners).toHaveLength(2);
    expect(svg).toContain(`>${longName}</text>`);
    expect(svg).toContain(`>${longType}</text>`);
    expect(svg).toContain('fill="#e1eef8"');
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('stroke="#000"');
    expect(svg).toContain('marker-end="url(#ddd-mk-many-optional)"');
    expect(svg).not.toContain('#123456');
  });

  it('detours around a table between facing endpoints', () => {
    const input = source();
    const blocker = { ...schema.tables[0]!, name: 'public.blocker', tableName: 'blocker' };
    input.schema = { ...schema, tables: [...schema.tables, blocker] };
    input.positions.set('public.b', { x: 900, y: 0 });
    input.positions.set(blocker.name, { x: 450, y: 0 });
    const model = buildExportModel(input, opts)!;
    const path = model.edges[0]!.corners;
    expect(path.length).toBeGreaterThan(2);
    expect(path.some((p, i) => i > 0 && model.tables.some((t) => crossesTable(path[i - 1]!, p, t)))).toBe(false);
  });

  it('uses the editor table widths and leaves edited positions and routes in place', () => {
    const input = { ...source(), editingPrintLayout: true };
    const [a, b] = input.schema.tables;
    const wideTable = { ...a!, tableName: 'a_very_long_table_title_in_the_print_layout' };
    input.schema = { ...input.schema, tables: [wideTable, b!] };
    input.positions.set('public.b', { x: 310, y: 15 });
    input.edgeLayouts.set(ref.id, { waypoints: [{ x: 285, y: -100 }] });
    const model = buildExportModel(input, opts)!;
    expect(model.tables[0]!.w).toBe(printTableWidth(wideTable, input.density, estimateTextWidth));
    expect(model.tables[1]!.x).toBe(310);
    expect(model.edges[0]!.corners.some((point) => point.y === -100)).toBe(true);
  });

  it('honors the on-canvas option independently for regular SVGs', () => {
    const regular = { ...opts, printerFriendly: false };
    const input = { ...source(), schema: { ...schema, refs: [ref] } };
    const stub = () => '#123456';
    const without = renderSvg(buildExportModel(input, regular)!, theme, stub).svg;
    const withKeys = renderSvg(buildExportModel({ ...input, showKeyColumn: true }, regular)!, theme, stub).svg;
    expect(without).not.toContain('>FK</text>');
    expect(withKeys).toContain('>FK</text>');
    expect(withKeys).not.toContain('fill="#e1eef8"');
  });
});

it('includes styled standalone labels and their bounds in printer-friendly SVGs', () => {
  const input = source();
  input.schema = { tables: [], refs: [], groups: [], labels: [
    { name: 'title', text: 'Schema <A>\nJanar & team', font: 'Georgia, serif', fontSize: 32, x: -160, y: -290 },
  ] };
  input.positions.clear();
  input.derived = { ...derived, effectiveRefs: [] };
  const model = buildExportModel(input, { scope: 'all', background: true, filename: 'labels', printerFriendly: true })!;
  expect(model.bounds.x).toBeLessThan(-160);
  expect(model.bounds.y).toBeLessThan(-290);
  const { svg } = renderSvg(model, theme, () => '#123456');
  expect(svg).toContain('font-family="Georgia, serif" font-size="32"');
  expect(svg).toContain('Schema &lt;A&gt;</text>');
  expect(svg).toContain('Janar &amp; team</text>');
});

it('keeps inactive relationships dotted in SVG and leaves the referring field unmarked', () => {
  const inactive: Ref = { ...ref, inactive: true };
  const input: ExportSource = {
    ...source(),
    schema: { ...schema, refs: [inactive] },
    derived: { ...derived, effectiveRefs: [inactive] },
  };
  const model = buildExportModel(input, { scope: 'all', filename: 'inactive', background: true, printerFriendly: true })!;
  const { svg } = renderSvg(model, theme, () => '#111');
  expect(svg).toContain('stroke-dasharray="1 5"');
  expect(svg).toContain('Inactive relationship');
  expect(model.tables[1]!.columns[1]!.key).toBe('');
});

it('uses the named view for the scene and SVG while adding optional project text', () => {
  const input = source();
  const full: Schema = {
    ...schema, refs: [ref],
    project: { name: 'Diagram project', note: 'Project overview text' },
    labels: [
      { name: 'keep', text: 'Visible note', font: 'Arial', fontSize: 24 },
      { name: 'omit', text: 'Omitted note', font: 'Arial', fontSize: 24 },
    ],
  };
  const filtered = schemaForView(full, { name: 'focused', tables: ['public.b'], notes: ['keep'], groups: [], schemas: [] });
  const scene = new SceneCache().update({
    schema: filtered, positions: input.positions, groupState: {}, individuallyHidden: new Set(),
    tablesByName: new Map(filtered.tables.map((table) => [table.name, table])),
    rows: buildRowGeometry({ tables: filtered.tables, showOnlyPkFk: false, fkColumnsByTable: fkColumnsByTable(full.refs) }),
    density: 'cozy', showDeps: true, edgeLayouts: new Map(),
  });
  expect(scene.spatialIndex.getBbox('public.a')).toBeUndefined();
  expect(scene.derived.effectiveRefs).toEqual([]);
  const model = buildExportModel({ ...input, schema: filtered, derived: scene.derived }, {
    scope: 'all', filename: 'focused', background: true, includeProjectTitle: true, includeProjectNote: true,
  })!;
  expect(model.tables.map((t) => t.tableName)).toEqual(['b']);
  expect(model.labels.map((label) => label.text)).toEqual(['Visible note', 'Diagram project', 'Project overview text']);
  expect(model.edges).toEqual([]);
  expect(full.tables).toHaveLength(2);
  expect(full.labels).toHaveLength(2);
});

it('uses saved sidecar positions and typography for notes and both project captions', () => {
  const input = source();
  input.schema = {
    ...schema,
    project: { name: 'Project title', note: 'Project note text' },
    labels: [{ name: 'custom', text: 'Custom caption', x: 99, y: 101, font: 'Arial', fontSize: 20 }],
  };
  input.labelLayouts = {
    'note:custom': { x: 40, y: -200, font: 'Georgia', fontSize: 30 },
    'project:title': { x: 100, y: -341 },
    'project:note': { x: -250, y: -260, fontSize: 18 },
  };
  const model = buildExportModel(input, { scope: 'all', filename: 'labels', background: false,
    printerFriendly: true, includeProjectTitle: true, includeProjectNote: true,
  })!;
  expect(model.labels).toMatchObject([
    { text: 'Custom caption', x: 40, y: -200, font: 'Georgia', fontSize: 30 },
    { text: 'Project title', x: 100, y: -341 },
    { text: 'Project note text', x: -250, y: -260, fontSize: 18 },
  ]);
  expect(model.bounds.x).toBeLessThan(-250);
  expect(model.bounds.y).toBeLessThan(-341);
});

it('exports a title block as one positioned group with ordered fields and an embedded local image', () => {
  const input = source();
  const logo = 'data:image/png;base64,aW1hZ2U=';
  input.schema = {
    ...schema,
    project: {
      name: 'Project title', note: 'Project note', fontSize: 38,
      fields: [
        { key: 'database_type', value: 'Postgres 18.0' },
        { key: 'created', value: '31.12.2026' },
        { key: 'document_type', value: 'ERD & schema' },
        { key: 'author', value: 'Janar' },
      ],
      images: [{ key: 'logo', filename: 'logo.png', dataUri: logo }],
    },
  };
  input.labelLayouts = {
    'project:title-block': { template: 'title-block', x: -90, y: -355, fontSize: 46 },
    'project:title': { x: 1, y: 2 },
    'project:note': { x: 3, y: 4 },
  };
  const model = buildExportModel(input, { scope: 'all', filename: 'title-block', background: true,
    printerFriendly: true, includeProjectTitle: true, includeProjectNote: true,
  })!;
  expect(model.labels).toHaveLength(1);
  expect(model.labels[0]).toMatchObject({ layoutKey: 'project:title-block', x: -90, y: -355, fontSize: 46 });
  const { svg } = renderSvg(model, theme, () => '#111');
  expect(svg).toContain('transform="translate(-90 -355)"');
  expect(svg).toContain('font-size="46" font-weight="700"');
  expect(svg).toContain(`href="${logo}"`);
  expect(svg).toContain('Database type');
  expect(svg).toContain('Document type');
  expect(svg).toContain('Project note');
  expect(svg).toContain('ERD &amp; schema');
});
