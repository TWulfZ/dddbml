import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useAppStore } from './state/store';
import { autoLayout, estimateSize } from './layout/autoLayout';
import { TableNode } from './render/tableNode';
import { EdgeLayer } from './render/edgeLayer';
import { CollapsedGroupNode } from './render/collapsedGroupNode';
import { GroupContainer } from './render/groupContainer';
import { ZoomButtons } from './render/zoomButtons';
import { ActionsPanel } from './render/actionsPanel';
import { panBy, zoomAt } from './render/viewport';
import { SpatialIndex } from './render/spatialIndex';
import { lodForZoom } from './render/lod';
import { GroupPanel, colorForGroup } from './groups/groupPanel';
import { Tooltip } from './render/tooltip';
import type { QualifiedName, Ref, Table, WebviewToHost } from '../shared/types';

interface AppProps {
  post: (msg: WebviewToHost) => void;
}

const VISIBILITY_MARGIN = 256;
const GROUP_NODE_W = 220;
const GROUP_NODE_H = 80;
const GROUP_CONTAINER_PADDING = 24;
const GROUP_CONTAINER_HEADER = 20;

const GROUP_PREFIX = '__group__:';
const groupId = (name: string) => GROUP_PREFIX + name;

export function App(_props: AppProps) {
  const schema = useAppStore((s) => s.schema);
  const parseError = useAppStore((s) => s.parseError);
  const positions = useAppStore((s) => s.positions);
  const viewport = useAppStore((s) => s.viewport);
  const ready = useAppStore((s) => s.ready);
  const groupState = useAppStore((s) => s.groups);
  const individuallyHidden = useAppStore((s) => s.hiddenTables);
  const tableColors = useAppStore((s) => s.tableColors);
  const selection = useAppStore((s) => s.selection);

  useEffect(() => {
    if (!ready) return;
    const missing = schema.tables.filter((t) => !positions.has(t.name));
    if (missing.length === 0) return;
    const sizeOf = (name: QualifiedName) => {
      const t = schema.tables.find((x) => x.name === name);
      return estimateSize(t?.columns.length ?? 0);
    };
    const layoutTargets = positions.size === 0 ? schema.tables : missing;
    const laidOut = autoLayout(layoutTargets, schema.refs, sizeOf);
    const entries: Array<[QualifiedName, { x: number; y: number }]> = [];
    for (const [name, pos] of laidOut) entries.push([name, pos]);
    if (entries.length > 0) store.getState().setPositionsBatch(entries);
  }, [schema, ready]);

  const columnCountByTable = useMemo(() => {
    const m = new Map<QualifiedName, number>();
    for (const t of schema.tables) m.set(t.name, t.columns.length);
    return m;
  }, [schema]);

  const tablesByName = useMemo(() => {
    const m = new Map<QualifiedName, Table>();
    for (const t of schema.tables) m.set(t.name, t);
    return m;
  }, [schema]);

  /** Set of "table::column" keys for every column that participates in any ref. */
  const fkColumnsByTable = useMemo(() => {
    const m = new Map<QualifiedName, Set<string>>();
    const add = (table: QualifiedName, col: string) => {
      let s = m.get(table);
      if (!s) { s = new Set(); m.set(table, s); }
      s.add(col);
    };
    for (const r of schema.refs) {
      for (const c of r.source.columns) add(r.source.table, c);
      for (const c of r.target.columns) add(r.target.table, c);
    }
    return m;
  }, [schema]);

  const derived = useMemo(() => {
    const hiddenTables = new Set<QualifiedName>(individuallyHidden);
    const collapsedTables = new Set<QualifiedName>();
    const collapsedNodes: Array<{ name: string; x: number; y: number; w: number; h: number; color: string; count: number }> = [];
    const containers: Array<{ name: string; x: number; y: number; w: number; h: number; color: string }> = [];

    for (const g of schema.groups) {
      const st = groupState[g.name];
      if (st?.hidden) {
        for (const t of g.tables) hiddenTables.add(t);
        continue;
      }
      if (!st?.collapsed) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let n = 0;
        for (const t of g.tables) {
          if (hiddenTables.has(t)) continue;
          const pos = positions.get(t);
          if (!pos) continue;
          const table = schema.tables.find((x) => x.name === t);
          const size = estimateSize(table?.columns.length ?? 0);
          if (pos.x < minX) minX = pos.x;
          if (pos.y < minY) minY = pos.y;
          if (pos.x + size.width > maxX) maxX = pos.x + size.width;
          if (pos.y + size.height > maxY) maxY = pos.y + size.height;
          n++;
        }
        if (n > 0) {
          containers.push({
            name: g.name,
            x: Math.round(minX - GROUP_CONTAINER_PADDING),
            y: Math.round(minY - GROUP_CONTAINER_PADDING - GROUP_CONTAINER_HEADER),
            w: Math.round(maxX - minX + GROUP_CONTAINER_PADDING * 2),
            h: Math.round(maxY - minY + GROUP_CONTAINER_PADDING * 2 + GROUP_CONTAINER_HEADER),
            color: st?.color ?? colorForGroup(g.name),
          });
        }
        continue;
      }
      if (st?.collapsed) {
        let sumX = 0, sumY = 0, n = 0;
        for (const t of g.tables) {
          const pos = positions.get(t);
          if (!pos) continue;
          const table = schema.tables.find((x) => x.name === t);
          const size = estimateSize(table?.columns.length ?? 0);
          sumX += pos.x + size.width / 2;
          sumY += pos.y + size.height / 2;
          n++;
          collapsedTables.add(t);
        }
        if (n > 0) {
          const cx = Math.round(sumX / n - GROUP_NODE_W / 2);
          const cy = Math.round(sumY / n - GROUP_NODE_H / 2);
          collapsedNodes.push({
            name: g.name,
            x: cx,
            y: cy,
            w: GROUP_NODE_W,
            h: GROUP_NODE_H,
            color: st.color ?? colorForGroup(g.name),
            count: g.tables.length,
          });
        }
      }
    }

    const mapEndpoint = (table: QualifiedName): QualifiedName | null => {
      if (hiddenTables.has(table)) return null;
      if (collapsedTables.has(table)) {
        const tbl = schema.tables.find((t) => t.name === table);
        if (tbl?.groupName) return groupId(tbl.groupName);
        return null;
      }
      return table;
    };

    const effectiveRefs: Ref[] = [];
    const seen = new Set<string>();
    for (const r of schema.refs) {
      const srcM = mapEndpoint(r.source.table);
      const tgtM = mapEndpoint(r.target.table);
      if (srcM == null || tgtM == null) continue;
      if (srcM === tgtM) continue;
      const key = `${srcM}::${r.source.columns.join(',')}|${tgtM}::${r.target.columns.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      effectiveRefs.push({
        ...r,
        id: key,
        source: { ...r.source, table: srcM },
        target: { ...r.target, table: tgtM },
      });
    }

    return { hiddenTables, collapsedTables, collapsedNodes, containers, effectiveRefs };
  }, [schema, positions, groupState, individuallyHidden]);

  const spatialIndex = useMemo(() => {
    const idx = new SpatialIndex();
    for (const t of schema.tables) {
      if (derived.hiddenTables.has(t.name) || derived.collapsedTables.has(t.name)) continue;
      const pos = positions.get(t.name);
      if (!pos) continue;
      const size = estimateSize(t.columns.length);
      idx.insert(t.name, { x: pos.x, y: pos.y, w: size.width, h: size.height });
    }
    for (const g of derived.collapsedNodes) {
      idx.insert(groupId(g.name), { x: g.x, y: g.y, w: g.w, h: g.h });
    }
    return idx;
  }, [schema, positions, derived]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportRect, setViewportRect] = useState({ w: 0, h: 0 });
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const cr = entry.contentRect;
      setViewportRect({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setViewportRect({ w: rect.width, h: rect.height });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = Math.pow(1.0015, -e.deltaY);
      zoomAt(screen, factor);
    };

    let panning = false;
    let lastX = 0;
    let lastY = 0;

    let marqueeActive = false;
    let marqueeStart = { x: 0, y: 0 };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        panning = true;
        lastX = e.clientX;
        lastY = e.clientY;
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-panning');
        return;
      }
      if (e.button === 0) {
        // Only start marquee if click landed on empty viewport (not on a table / group / etc).
        const target = e.target as HTMLElement;
        if (target !== el && !target.classList.contains('ddd-world') && !target.classList.contains('ddd-group-container')) {
          return;
        }
        const rect = el.getBoundingClientRect();
        marqueeActive = true;
        marqueeStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setMarquee({ x0: marqueeStart.x, y0: marqueeStart.y, x1: marqueeStart.x, y1: marqueeStart.y });
        if (!e.shiftKey) store.getState().clearSelection();
        el.setPointerCapture(e.pointerId);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (panning) {
        panBy(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
        return;
      }
      if (marqueeActive) {
        const rect = el.getBoundingClientRect();
        setMarquee({
          x0: marqueeStart.x,
          y0: marqueeStart.y,
          x1: e.clientX - rect.left,
          y1: e.clientY - rect.top,
        });
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (panning) {
        panning = false;
        try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        el.classList.remove('is-panning');
        return;
      }
      if (marqueeActive) {
        marqueeActive = false;
        try { el.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        const rect = el.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;
        const x0 = Math.min(marqueeStart.x, endX);
        const y0 = Math.min(marqueeStart.y, endY);
        const x1 = Math.max(marqueeStart.x, endX);
        const y1 = Math.max(marqueeStart.y, endY);
        setMarquee(null);
        // Skip trivial clicks.
        if (x1 - x0 < 4 && y1 - y0 < 4) return;
        const vp = store.getState().viewport;
        const world = {
          x: (x0 - vp.x) / vp.zoom,
          y: (y0 - vp.y) / vp.zoom,
          w: (x1 - x0) / vp.zoom,
          h: (y1 - y0) / vp.zoom,
        };
        const hits = spatialIndex.query(world);
        // Exclude synthetic group ids from selection.
        const realHits: string[] = [];
        for (const h of hits) if (!h.startsWith(GROUP_PREFIX)) realHits.push(h);
        if (e.shiftKey) {
          const merged = new Set(store.getState().selection);
          for (const n of realHits) merged.add(n);
          store.getState().setSelection(merged);
        } else {
          store.getState().setSelection(realHits);
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        store.getState().clearSelection();
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [ready, spatialIndex]);

  const visibleNames = useMemo(() => {
    if (!ready || viewportRect.w === 0 || viewportRect.h === 0) return null;
    const worldBbox = {
      x: (-viewport.x) / viewport.zoom - VISIBILITY_MARGIN,
      y: (-viewport.y) / viewport.zoom - VISIBILITY_MARGIN,
      w: viewportRect.w / viewport.zoom + VISIBILITY_MARGIN * 2,
      h: viewportRect.h / viewport.zoom + VISIBILITY_MARGIN * 2,
    };
    return spatialIndex.query(worldBbox);
  }, [spatialIndex, viewport, viewportRect, ready]);

  const positionsEffective = useMemo(() => {
    const m = new Map<QualifiedName, { x: number; y: number }>();
    for (const [k, v] of positions) m.set(k, v);
    for (const g of derived.collapsedNodes) m.set(groupId(g.name), { x: g.x, y: g.y });
    return m;
  }, [positions, derived.collapsedNodes]);

  // World bounding box covering every rendered element — used to size the SVG edge layer
  // so paths are inside its coordinate viewport (more robust than overflow:visible on 0x0 parent).
  const worldBbox = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of schema.tables) {
      if (derived.hiddenTables.has(t.name) || derived.collapsedTables.has(t.name)) continue;
      const pos = positions.get(t.name);
      if (!pos) continue;
      const size = estimateSize(t.columns.length);
      if (pos.x < minX) minX = pos.x;
      if (pos.y < minY) minY = pos.y;
      if (pos.x + size.width > maxX) maxX = pos.x + size.width;
      if (pos.y + size.height > maxY) maxY = pos.y + size.height;
    }
    for (const g of derived.collapsedNodes) {
      if (g.x < minX) minX = g.x;
      if (g.y < minY) minY = g.y;
      if (g.x + g.w > maxX) maxX = g.x + g.w;
      if (g.y + g.h > maxY) maxY = g.y + g.h;
    }
    for (const c of derived.containers) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x + c.w > maxX) maxX = c.x + c.w;
      if (c.y + c.h > maxY) maxY = c.y + c.h;
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 800, h: 600 };
    const P = 400;
    return { x: Math.round(minX - P), y: Math.round(minY - P), w: Math.round(maxX - minX + P * 2), h: Math.round(maxY - minY + P * 2) };
  }, [schema, positions, derived]);

  const lod = lodForZoom(viewport.zoom);
  const worldTransform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
  const visibleRefs = visibleNames
    ? derived.effectiveRefs.filter((r) => visibleNames.has(r.source.table) || visibleNames.has(r.target.table))
    : derived.effectiveRefs;

  const renderedTables = schema.tables.filter(
    (t) => !derived.hiddenTables.has(t.name) && !derived.collapsedTables.has(t.name),
  );

  const visibleTableCount = renderedTables.length + derived.collapsedNodes.length;
  const totalTableCount = schema.tables.length - derived.hiddenTables.size;

  return (
    <>
      <div class="ddd-viewport" ref={viewportRef} tabIndex={0}>
        {ready && schema.tables.length > 0 ? (
          <div class="ddd-world" style={{ transform: worldTransform }}>
            {derived.containers.map((c) => (
              <GroupContainer key={`container:${c.name}`} name={c.name} x={c.x} y={c.y} w={c.w} h={c.h} color={c.color} />
            ))}
            <EdgeLayer
              refs={visibleRefs}
              positions={positionsEffective}
              tablesByName={tablesByName}
              groupSizes={derived.collapsedNodes}
              worldBbox={worldBbox}
            />
            {renderedTables.map((t) => {
              if (visibleNames && !visibleNames.has(t.name)) return null;
              const pos = positions.get(t.name);
              if (!pos) return null;
              const groupColor = t.groupName ? (groupState[t.groupName]?.color ?? colorForGroup(t.groupName)) : undefined;
              const tColor = tableColors.get(t.name) ?? groupColor;
              return (
                <TableNode
                  key={t.name}
                  table={t}
                  x={pos.x}
                  y={pos.y}
                  lod={lod}
                  selected={selection.has(t.name)}
                  color={tColor}
                  fkColumns={fkColumnsByTable.get(t.name)}
                />
              );
            })}
            {derived.collapsedNodes.map((g) => {
              if (visibleNames && !visibleNames.has(groupId(g.name))) return null;
              return (
                <CollapsedGroupNode
                  key={g.name}
                  name={g.name}
                  tableCount={g.count}
                  x={g.x}
                  y={g.y}
                  w={g.w}
                  h={g.h}
                  color={g.color}
                />
              );
            })}
          </div>
        ) : null}
        {marquee ? (
          <div
            class="ddd-marquee"
            style={{
              left: `${Math.min(marquee.x0, marquee.x1)}px`,
              top: `${Math.min(marquee.y0, marquee.y1)}px`,
              width: `${Math.abs(marquee.x1 - marquee.x0)}px`,
              height: `${Math.abs(marquee.y1 - marquee.y0)}px`,
            }}
          />
        ) : null}
        {!ready ? <div class="ddd-empty">loading…</div> : null}
        {ready && schema.tables.length === 0 && !parseError ? (
          <div class="ddd-empty">empty DBML — define a Table to see it here.</div>
        ) : null}
        {ready ? <GroupPanel /> : null}
        {ready ? <ZoomButtons /> : null}
        {ready ? <ActionsPanel /> : null}
      </div>
      {parseError ? (
        <div class="ddd-banner" title={parseError.message}>
          Parse error
          {parseError.line != null ? ` (line ${parseError.line})` : ''}: {parseError.message}
        </div>
      ) : null}
      {ready ? (
        <div class="ddd-statusbar">
          {visibleNames ? visibleNames.size : visibleTableCount}/{totalTableCount} visible · {derived.effectiveRefs.length} refs · zoom {Math.round(viewport.zoom * 100)}% · LOD {lod}
          {selection.size > 0 ? ` · ${selection.size} selected` : ''}
        </div>
      ) : null}
      <Tooltip />
    </>
  );
}
