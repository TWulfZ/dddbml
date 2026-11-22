import type { EdgeLayout } from '../../shared/types';
import * as dagre from '@dagrejs/dagre';
import type { Architecture, ArchitectureGroup, ArchitectureLink, ArchitectureNode } from '../../shared/architecture';
import { portPoint, roundedPathString, STUB_DIR } from '../render/edgeRouter';
import { crossesTable, routeAroundTables } from '../render/portRoute';
import type { Bbox } from '../render/spatialIndex';
import type { PlacedLabel } from './diagramLabels';
import { measurePrintText } from './printTable';

export type Point = { x: number; y: number };
export interface ArchitectureNodeBox extends ArchitectureNode, Bbox {}
export interface ArchitectureGroupBox extends ArchitectureGroup, Bbox {
  movable: string[];
  depth: number;
}
export interface ArchitectureRoute {
  link: ArchitectureLink;
  color?: string;
  d: string;
  corners: Point[];
  spans: Point[][];
  waypoints: readonly Point[];
  sourceBox: Bbox;
  targetBox: Bbox;
  label?: { text: string; x: number; y: number; w: number };
}
export interface ArchitectureScene {
  nodes: ArchitectureNodeBox[];
  groups: ArchitectureGroupBox[];
  routes: ArchitectureRoute[];
  notes: readonly PlacedLabel[];
}

const FONT = 'Arial, sans-serif';
const PAD = 24;
const HEADER = 22;
const STACK_OFFSET = 10;
const CARD_HEIGHT = 76;

function nodeWidth(node: ArchitectureNode): number {
  return Math.max(190, Math.ceil(Math.max(
    measurePrintText(node.name, 15, FONT, 700),
    measurePrintText(nodeSubtitle(node), 12, FONT),
  )) + 84);
}

export const nodeSubtitle = (node: ArchitectureNode): string => [node.role, node.type].filter(Boolean).join(' · ');

function groupMinWidth(group: ArchitectureGroup): number {
  return Math.max(196, Math.ceil(measurePrintText(group.name, 13, FONT, 700)) + 40);
}

function union(a: Bbox, b: Bbox): Bbox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function frameGroup(group: ArchitectureGroup, children: Bbox): Bbox {
  return {
    x: children.x - PAD,
    y: children.y - PAD - (group.labelBottom ? 0 : HEADER),
    w: Math.max(groupMinWidth(group), children.w + PAD * 2),
    h: children.h + PAD * 2 + HEADER,
  };
}

interface Cluster { w: number; h: number; positions: Map<string, Point> }

const EMPTY_NOTES: readonly PlacedLabel[] = [];
const defaultsByModel = new WeakMap<Architecture, { notes: readonly PlacedLabel[]; positions: Map<string, Point> }>();

export function defaultArchitecturePositions(architecture: Architecture, notes: readonly PlacedLabel[] = EMPTY_NOTES): ReadonlyMap<string, Point> {
  const cached = defaultsByModel.get(architecture);
  if (cached?.notes === notes) return cached.positions;
  const nodes = new Map(architecture.nodes.map((node) => [node.id, node]));
  const groups = new Map(architecture.groups.map((group) => [group.id, group]));
  const noteBoxes = new Map(notes.map((note) => [note.layoutKey, note]));
  const parent = new Map(architecture.groups.flatMap((g) => g.children.map((id) => [id, g.id] as const)));
  const roots = [...nodes.keys(), ...groups.keys(), ...noteBoxes.keys()].filter((id) => !parent.has(id));

  const cluster = (id: string): Cluster => {
    const group = groups.get(id);
    if (!group) {
      const note = noteBoxes.get(id);
      const node = nodes.get(id);
      return { w: note?.w ?? (node ? nodeWidth(node) : 0), h: note?.h ?? (node ? CARD_HEIGHT : 0), positions: new Map([[id, { x: 0, y: 0 }]]) };
    }
    if (!group.children.length) return { w: groupMinWidth(group) + (group.stacked ? STACK_OFFSET : 0), h: 92 + (group.stacked ? STACK_OFFSET : 0), positions: new Map([[id, { x: 0, y: 0 }]]) };
    const contents = arrange(group.children.filter((child) => nodes.has(child) || groups.has(child) || noteBoxes.has(child)), group.id);
    return {
      w: Math.max(groupMinWidth(group), contents.w + PAD * 2) + (group.stacked ? STACK_OFFSET : 0),
      h: contents.h + PAD * 2 + HEADER + (group.stacked ? STACK_OFFSET : 0),
      positions: new Map([...contents.positions].map(([key, p]) => [key, { x: p.x + PAD, y: p.y + PAD + (group.labelBottom ? 0 : HEADER) }])),
    };
  };

  function arrange(ids: string[], scope?: string): Cluster {
    if (ids.length === 0) return { w: 0, h: 0, positions: new Map() };
    const clusters = new Map(ids.map((id) => [id, cluster(id)]));
    const graph = new dagre.graphlib.Graph()
      .setGraph({ rankdir: 'LR', ranksep: 104, nodesep: 54 })
      .setDefaultEdgeLabel(() => ({}));
    for (const [id, box] of clusters) graph.setNode(id, { width: box.w, height: box.h });
    const childOfScope = (id: string): string | undefined => {
      if (id === scope) return undefined;
      let child = id;
      while (parent.has(child) && parent.get(child) !== scope) child = parent.get(child)!;
      return clusters.has(child) ? child : undefined;
    };
    for (const link of architecture.links) {
      const from = childOfScope(link.operator === '<' ? link.to : link.from);
      const to = childOfScope(link.operator === '<' ? link.from : link.to);
      if (from && to && from !== to) graph.setEdge(from, to);
    }
    dagre.layout(graph);
    const positions = new Map<string, Point>();
    for (const [id, contents] of clusters) {
      const node = graph.node(id);
      for (const [key, p] of contents.positions) {
        positions.set(key, { x: Math.round(node.x - contents.w / 2 + p.x), y: Math.round(node.y - contents.h / 2 + p.y) });
      }
    }
    return { w: graph.graph().width ?? 0, h: graph.graph().height ?? 0, positions };
  }

  const output = new Map([...arrange(roots).positions].map(([id, p]) => [id, { x: p.x + 64, y: p.y + 72 }]));
  defaultsByModel.set(architecture, { notes, positions: output });
  return output;
}

function groupHull(group: ArchitectureGroupBox): Bbox {
  return group.stacked ? { ...group, w: group.w + STACK_OFFSET, h: group.h + STACK_OFFSET } : group;
}

export function buildArchitectureScene(architecture: Architecture, positions: ReadonlyMap<string, Point>, notes: readonly PlacedLabel[] = EMPTY_NOTES, edgeLayouts?: ReadonlyMap<string, EdgeLayout>): ArchitectureScene {
  const defaults = defaultArchitecturePositions(architecture, notes);
  const position = (id: string) => positions.get(id) ?? defaults.get(id) ?? { x: 0, y: 0 };
  const nodes: ArchitectureNodeBox[] = architecture.nodes.map((node) => ({
    ...node, ...position(node.id), w: nodeWidth(node), h: CARD_HEIGHT,
  }));
  const boxes = new Map<string, Bbox>(nodes.map((node) => [node.id, node]));
  const placedNotes = notes.map((note) => ({
    ...note,
    x: note.authoredPosition?.x ?? defaults.get(note.layoutKey)?.x ?? note.x,
    y: note.authoredPosition?.y ?? defaults.get(note.layoutKey)?.y ?? note.y,
  }));
  for (const note of placedNotes) boxes.set(note.layoutKey, note);
  const records = new Map(architecture.groups.map((group) => [group.id, group]));
  const groups = new Map<string, ArchitectureGroupBox>();
  const parent = new Map(architecture.groups.flatMap((group) => group.children.map((id) => [id, group.id] as const)));
  const groupBox = (group: ArchitectureGroup, depth: number): ArchitectureGroupBox => {
    const existing = groups.get(group.id);
    if (existing) return existing;
    let bounds: Bbox | undefined;
    const movable: string[] = [];
    for (const child of group.children) {
      const childGroup = records.get(child);
      const derived = childGroup ? groupBox(childGroup, depth + 1) : undefined;
      const box = derived ? groupHull(derived) : boxes.get(child);
      if (!box) continue;
      bounds = bounds ? union(bounds, box) : box;
      movable.push(...(derived?.movable ?? [child]));
    }
    const box = bounds
      ? frameGroup(group, bounds)
      : { ...position(group.id), w: groupMinWidth(group), h: 92 };
    const result = { ...group, ...box, movable: movable.length ? movable : [group.id], depth };
    groups.set(group.id, result);
    boxes.set(group.id, result);
    return result;
  };
  for (const group of architecture.groups) if (!parent.has(group.id)) groupBox(group, 0);
  const sortedGroups = [...groups.values()].sort((a, b) => a.depth - b.depth);
  const obstacles = [...nodes, ...placedNotes.map((note) => ({ ...note, id: note.layoutKey }))];
  const routes = architecture.links.flatMap((link) => {
    const from = boxes.get(link.from), to = boxes.get(link.to);
    return from && to ? [route(link, from, to, obstacles, edgeLayouts?.get(link.id))] : [];
  });
  return { nodes, groups: sortedGroups, routes, notes: placedNotes };
}

const center = (box: Bbox): Point => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const contains = (outer: Bbox, inner: Bbox) => outer.x <= inner.x && outer.y <= inner.y
  && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;

function route(link: ArchitectureLink, a: Bbox, b: Bbox, nodes: (Bbox & { id: string })[], layout?: EdgeLayout): ArchitectureRoute {
  const waypoints = layout?.waypoints ?? [];
  const ac = center(a), bc = center(b);
  const xGap = Math.max(b.x - a.x - a.w, a.x - b.x - b.w);
  const yGap = Math.max(b.y - a.y - a.h, a.y - b.y - b.h);
  const horizontal = xGap >= yGap;
  const sign = (horizontal ? bc.x - ac.x : bc.y - ac.y) >= 0 ? 1 : -1;
  const dir = (s: number): Point => horizontal ? { x: s, y: 0 } : { x: 0, y: s };
  const aDir = dir(contains(a, b) ? -sign : sign);
  const bDir = dir(contains(b, a) ? sign : -sign);
  const onBorder = (c: Point, box: Bbox, d: Point): Point => ({ x: c.x + d.x * box.w / 2, y: c.y + d.y * box.h / 2 });
  const start = onBorder(ac, a, aDir), end = onBorder(bc, b, bDir);
  const mid = horizontal ? (start.x + end.x) / 2 : (start.y + end.y) / 2;
  let corners: Point[] = horizontal
    ? [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end]
    : [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  if (link.from === link.to) {
    const right = a.x + a.w;
    corners = [
      { x: right, y: ac.y }, { x: right + 36, y: ac.y },
      { x: right + 36, y: a.y - 32 }, { x: ac.x, y: a.y - 32 },
      { x: ac.x, y: a.y },
    ];
  }
  const related = union(a, b);
  const overlaps = (box: Bbox) => box.x < related.x + related.w + 80 && box.y < related.y + related.h + 80
    && box.x + box.w > related.x - 80 && box.y + box.h > related.y - 80;
  const obstacles = nodes.filter((node) => node.id !== link.from && node.id !== link.to && overlaps(node));
  if (!contains(a, b) && !contains(b, a) && obstacles.length <= 13 &&
      corners.some((p, i) => i > 0 && obstacles.some((box) => crossesTable(corners[i - 1]!, p, box)))) {
    const stub = (p: Point, d: Point) => ({ x: p.x + d.x * 18, y: p.y + d.y * 18 });
    const detour = routeAroundTables(stub(start, aDir), stub(end, bDir), [...obstacles, a, b], aDir, bDir);
    if (detour) corners = [start, ...detour, end];
  }
  const pinnedSource = layout?.sourceSide;
  const pinnedTarget = layout?.targetSide;
  if (pinnedSource || pinnedTarget) {
    const first = pinnedSource ? portPoint(a, pinnedSource, layout.sourcePort ?? 0.5) : corners[0]!;
    const last = pinnedTarget ? portPoint(b, pinnedTarget, layout.targetPort ?? 0.5) : corners[corners.length - 1]!;
    const sourceDir = pinnedSource ? STUB_DIR[pinnedSource] : link.from === link.to ? STUB_DIR.right : aDir;
    const targetDir = pinnedTarget ? STUB_DIR[pinnedTarget] : link.from === link.to ? STUB_DIR.top : bDir;
    const stub = (end: Point, dir: Point) => ({ x: end.x + dir.x * 16, y: end.y + dir.y * 16 });
    const sourceStub = stub(first, sourceDir), targetStub = stub(last, targetDir);
    const avoid = [...obstacles.slice(0, 13), ...new Set([a, b])].filter((box) =>
      ![sourceStub, targetStub].some((p) => p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h));
    const detour = !waypoints.length && routeAroundTables(sourceStub, targetStub, avoid, sourceDir, targetDir);
    corners = [first, ...(detour || [sourceStub, { x: targetStub.x, y: sourceStub.y }, targetStub]), last];
  }
  let spans = [corners];
  if (waypoints.length) {
    const first = corners[0]!, last = corners[corners.length - 1]!;
    const portStub = (port: Point, along: Point) => ({
      x: port.x + 16 * Math.sign(along.x - port.x),
      y: port.y + 16 * Math.sign(along.y - port.y),
    });
    const startStub = portStub(first, corners.find((p) => distance(first, p) > 0) ?? first);
    const endStub = portStub(last, [...corners].reverse().find((p) => distance(last, p) > 0) ?? last);
    const anchors = [startStub, ...waypoints, endStub];
    spans = anchors.slice(1).map((p, i) => {
      const prev = anchors[i]!;
      const middleX = (prev.x + p.x) / 2;
      return [prev, { x: middleX, y: prev.y }, { x: middleX, y: p.y }, p];
    });
    spans[0]!.unshift(first);
    spans[spans.length - 1]!.push(last);
    corners = spans.flatMap((span, i) => i ? span.slice(1) : span);
  }
  const text = [link.protocol, link.host].filter(Boolean).join(' · ');
  const label = text ? placeLinkLabel(text, corners, nodes) : undefined;
  return { link, color: layout?.color ?? link.color, d: roundedPathString(corners, waypoints.length ? 0 : 7), corners, spans, waypoints, sourceBox: a, targetBox: b, label };
}

function placeLinkLabel(text: string, corners: Point[], blockers: Bbox[]): ArchitectureRoute['label'] {
  const w = measurePrintText(text, 11, FONT) + 12;
  const segments = corners.slice(1).map((p, i) => [corners[i]!, p] as const)
    .sort((a, b) => distance(...b) - distance(...a));
  for (const [a, b] of segments) {
    const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
    for (const dy of [-12, 12, -27, 27, -46, 46, -64, 64]) {
      if (blockers.every((box) => x + w / 2 <= box.x || x - w / 2 >= box.x + box.w ||
          y + dy + 9 <= box.y || y + dy - 9 >= box.y + box.h)) {
        return { text, x, y: y + dy, w };
      }
    }
  }
  const [a, b] = segments[0]!;
  return { text, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 12, w };
}

function distance(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function architectureBounds(scene: ArchitectureScene): Bbox | null {
  const parts: Bbox[] = [...scene.groups.map(groupHull), ...scene.nodes, ...scene.notes];
  for (const route of scene.routes) {
    parts.push(...route.corners.map((p) => ({ x: p.x - 8, y: p.y - 8, w: 16, h: 16 })));
    if (route.label) parts.push({ x: route.label.x - route.label.w / 2, y: route.label.y - 9, w: route.label.w, h: 18 });
  }
  return parts.length ? parts.slice(1).reduce(union, parts[0]!) : null;
}

export function architectureSelection(scene: ArchitectureScene, selection: ReadonlySet<string>): ArchitectureScene {
  const selected = new Set(selection);
  const groupsById = new Map(scene.groups.map((group) => [group.id, group]));
  const expanded = new Set<string>();
  const includeGroup = (id: string): void => {
    const group = groupsById.get(id);
    if (!group || expanded.has(id)) return;
    expanded.add(id);
    selected.add(id);
    for (const child of group.children) {
      selected.add(child);
      includeGroup(child);
    }
  };
  for (const group of scene.groups) {
    if (selected.has(group.id) || group.movable.every((id) => selection.has(id))) includeGroup(group.id);
  }
  const groups = scene.groups.filter((group) => expanded.has(group.id));
  return {
    groups, notes: scene.notes.filter((note) => selected.has(note.layoutKey)),
    nodes: scene.nodes.filter((node) => selected.has(node.id)),
    routes: scene.routes.filter(({ link }) => selected.has(link.from) && selected.has(link.to)),
  };
}

export function positionArchitectureCaptions(scene: ArchitectureScene, captions: readonly PlacedLabel[]): PlacedLabel[] {
  const bounds = architectureBounds(scene);
  if (!bounds) return [...captions];
  let y = bounds.y - 12;
  const positioned: PlacedLabel[] = [];
  for (const caption of [...captions].reverse()) {
    y -= caption.h + 8;
    positioned.push({
      ...caption, x: caption.authoredPosition?.x ?? bounds.x, y: caption.authoredPosition?.y ?? y,
    });
  }
  return positioned.reverse();
}
