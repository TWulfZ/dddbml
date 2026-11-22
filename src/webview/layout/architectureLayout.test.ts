import { describe, expect, it } from 'vitest';
import { parseLayout, serializeSharedLayout, emptyLayout } from '../../extension/layoutStore';
import { parseDbml } from '../../extension/parser';
import { buildExportModel, renderSvg, type ThemeTokens } from '../export/imageExport';
import { buildArchitectureScene, architectureSelection } from './architectureLayout';
import { diagramAnnotations } from './diagramLabels';

const source = `---
diagram_type: architecture
title: Orders platform
---
Internet clients
Server "Orders API" as api [color: #336699, style: dashed]
Database "Main database" as db [type: 'postgres']
Note guide { 'Writes go here' }
Group storage [label: bottom, stacked] { db guide }
Group "Production" as prd { api storage }
Link: clients > api [proto: HTTPS, host: 'api.example.test']
Link: api <> storage [style: dashed]
Link: db < guide
`;

const theme: ThemeTokens = {
  canvas: '#fff', surface: '#fff', border: '#000', fg: '#111', fgMuted: '#222',
  accent: '#111', headerBg: '#e1eef8', edge: '#000', dep: '#000',
};

function fixture() {
  const result = parseDbml(source);
  if (!result.schema?.architecture) throw new Error(result.error?.message ?? 'Expected architecture');
  return { schema: result.schema, architecture: result.schema.architecture };
}

describe('DBML architecture diagrams', () => {
  it('retains stable aliases, nested groups, note endpoints, and link semantics', () => {
    const { architecture, schema } = fixture();
    expect(architecture.title).toBe('Orders platform');
    const [clients, api, db] = architecture.nodes;
    const [storage, production] = architecture.groups;
    expect(api).toMatchObject({ id: 'arch:node:alias:api', role: 'Server', dashed: true, color: '#336699' });
    expect(db).toMatchObject({ type: 'postgres' });
    expect(storage).toMatchObject({ labelBottom: true, stacked: true, children: [db!.id, 'note:guide'] });
    expect(production!.children).toEqual([api!.id, storage!.id]);
    expect(architecture.links).toMatchObject([
      { from: clients!.id, to: api!.id, operator: '>', protocol: 'HTTPS', host: 'api.example.test' },
      { from: api!.id, to: storage!.id, operator: '<>', dashed: true },
      { from: db!.id, to: 'note:guide', operator: '<' },
    ]);

    const { notes } = diagramAnnotations(schema);
    const scene = buildArchitectureScene(architecture, new Map(), notes);
    expect(scene.routes).toHaveLength(3);
    const child = scene.groups.find((group) => group.id === storage!.id)!;
    const outer = scene.groups.find((group) => group.id === production!.id)!;
    expect(child.x).toBeGreaterThan(outer.x);
    expect(child.x + child.w).toBeLessThan(outer.x + outer.w);
    expect(outer.movable).toEqual([api!.id, db!.id, 'note:guide']);
    expect(architectureSelection(scene, new Set([production!.id])).groups).toHaveLength(2);
  });

  it('uses saved positions and exports arrows, labels, and notes without table markup', () => {
    const { architecture, schema } = fixture();
    const api = architecture.nodes.find((node) => node.id === 'arch:node:alias:api')!;
    const positions = new Map([[api.id, { x: -300, y: 410 }]]);
    const model = buildExportModel({
      schema, positions, tableColors: new Map(), edgeLayouts: new Map(), selection: new Set(), density: 'cozy',
      labelLayouts: { 'note:guide': { x: 120, y: 400 } },
      derived: { hiddenTables: new Set(), collapsedTables: new Set(), collapsedNodes: [], containers: [], effectiveRefs: [] },
    }, { scope: 'all', background: true, filename: 'architecture', printerFriendly: true, includeProjectTitle: true });
    expect(model?.tables).toEqual([]);
    expect(model?.architecture?.nodes.find((node) => node.id === api.id)).toMatchObject({ x: -300, y: 410 });
    expect(model?.labels.find((label) => label.layoutKey === 'note:guide')).toMatchObject({ x: 120, y: 400 });
    const svg = renderSvg(model!, theme, () => '#000').svg;
    expect(svg.match(/class="ddd-architecture-arrow"/g)).toHaveLength(4);
    expect(svg).toContain('HTTPS · api.example.test');
    expect(svg).toContain('Database · postgres');
    expect(svg).toContain('Writes go here');
    expect(svg).toContain('Orders platform');
    expect(svg).not.toContain('#336699');
  });

  it('round-trips a link bend through the shared sidecar and applies it to SVG bounds and routing', () => {
    const { architecture, schema } = fixture();
    const id = architecture.links[0]!.id;
    const waypoint = { x: 200, y: -500 };
    const saved = parseLayout(serializeSharedLayout({ ...emptyLayout(), edges: { [id]: { waypoints: [waypoint], sourceSide: 'top', sourcePort: 0.25, targetSide: 'bottom', targetPort: 0.75, color: 'var(--ddd-bc-2-border)' } } }));
    const edgeLayouts = new Map(Object.entries(saved.edges ?? {}));
    const scene = buildArchitectureScene(architecture, new Map(), diagramAnnotations(schema).notes, edgeLayouts);
    const route = scene.routes[0]!;
    expect(route.waypoints).toEqual([waypoint]);
    expect(route.corners[0]).toEqual({ x: route.sourceBox.x + route.sourceBox.w / 4, y: route.sourceBox.y });
    expect(route.corners.at(-1)).toEqual({
      x: route.targetBox.x + route.targetBox.w * 0.75, y: route.targetBox.y + route.targetBox.h,
    });
    expect(scene.routes[0]?.corners).toContainEqual(waypoint);
    expect(scene.routes[0]?.spans).toHaveLength(2);
    expect(scene.routes[1]?.waypoints).toEqual([]);

    const model = buildExportModel({
      schema, positions: new Map(), tableColors: new Map(), edgeLayouts, selection: new Set(), density: 'cozy',
      derived: { hiddenTables: new Set(), collapsedTables: new Set(), collapsedNodes: [], containers: [], effectiveRefs: [] },
    }, { scope: 'all', background: true, filename: 'architecture' });
    expect(model?.bounds.y).toBeLessThan(waypoint.y);
    const svg = renderSvg(model!, theme, () => '#aabbcc').svg;
    expect(svg).toContain(`d="${route.d}" fill="none" stroke="#aabbcc"`);
    expect(renderSvg({ ...model!, printerFriendly: true }, theme, () => '#aabbcc').svg).not.toContain('#aabbcc');
  });

  it('keeps usable group bounds even when the parser accepts a membership cycle', () => {
    const result = parseDbml('---\ndiagram_type: arch\n---\nGroup a { b }\nGroup b { a }');
    const scene = buildArchitectureScene(result.schema!.architecture!, new Map());
    expect(scene.groups.map((group) => group.name)).toEqual(['a', 'b']);
    expect(scene.groups.find((group) => group.name === 'b')?.children).toEqual([]);
  });
});
