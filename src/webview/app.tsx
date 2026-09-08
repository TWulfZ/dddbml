import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useAppStore, isCanvasReadOnly } from './state/store';
import { autoLayout, estimateSize } from './layout/autoLayout';
import { TableNode } from './render/tableNode';
import { EdgeLayer } from './render/edgeLayer';
import { MergeGhosts } from './render/mergeGhosts';
import { MergePanel } from './render/mergePanel';
import { CollapsedGroupNode } from './render/collapsedGroupNode';
import { GroupContainer } from './render/groupContainer';
import { ZoomButtons } from './render/zoomButtons';
import { ActionsPanel } from './render/actionsPanel';
import { AppMenu } from './render/appMenu';
import { schedulePersist } from './persistence';
import { panBy, zoomAt } from './render/viewport';
import { SpatialIndex } from './render/spatialIndex';
import { lodForZoom } from './render/lod';
import { useVisibleNames } from './render/useVisibleNames';
import { GroupPanel, colorForGroup } from './groups/groupPanel';
import { Tooltip } from './render/tooltip';
import { ExportModal } from './render/exportModal';
import { ExportImageModal } from './render/exportImageModal';
import { SettingsPanel } from './render/settingsPanel';
import { GitPanel } from './render/gitPanel';
import { EdgeOrderProgress } from './render/edgeOrderProgress';
import { GitBanner, type DiffTarget } from './render/gitBanner';
import { DiffGhosts } from './render/diffGhosts';
import type { QualifiedName, Ref, RefDiffStatus, Table, WebviewToHost } from '../shared/types';

interface AppProps {
  post: (msg: WebviewToHost) => void;
}

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
  const ready = useAppStore((s) => s.ready);
  const groupState = useAppStore((s) => s.groups);
  const individuallyHidden = useAppStore((s) => s.hiddenTables);
  const tableColors = useAppStore((s) => s.tableColors);
  const selection = useAppStore((s) => s.selection);
  const panMode = useAppStore((s) => s.panMode);
  const spacePan = useAppStore((s) => s.spacePan);
  const panActive = panMode || spacePan;
  const mergeConflicts = useAppStore((s) => s.mergeConflicts);
  const gitView = useAppStore((s) => s.gitView);
  const readOnly = mergeConflicts != null || gitView != null;
  const diffByTable = useAppStore((s) => s.diffByTable);
  const columnDiffByTable = useAppStore((s) => s.columnDiffByTable);
  const diffBaseByTable = useAppStore((s) => s.diffBaseByTable);
  const refDiff = useAppStore((s) => s.refDiff);
  const diffGhosts = useAppStore((s) => s.diffGhosts);
  const diffRemovedRefs = useAppStore((s) => s.diffRemovedRefs);
  const focusDimming = useAppStore((s) => s.focusDimming);
  const diffActive = gitView?.kind === 'diff';
  // `viewport` itself is deliberately NOT selected here: it changes on every pan/zoom frame and
  // would re-render the whole tree (spec 04). Only its LOD projection (a stable string) is.
  const lod = useAppStore((s) => lodForZoom(s.viewport.zoom, s.settings.lod));
  const density = useAppStore((s) => s.settings.ui.density);
  const snapToGrid = useAppStore((s) => s.settings.ui.snapToGrid);
  const gridSize = useAppStore((s) => s.settings.ui.gridSize);

  useEffect(() => {
    document.body.dataset.density = density;
  }, [density]);

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
    // Maps each ref's STABLE id (Ref.id from the parser) to the composite edge key used by the edge
    // layer — lets the diff overlay tint a newly-added ref by its stable id (spec 16).
    const refKeyByStableId = new Map<string, string>();
    for (const r of schema.refs) {
      const srcM = mapEndpoint(r.source.table);
      const tgtM = mapEndpoint(r.target.table);
      if (srcM == null || tgtM == null) continue;
      if (srcM === tgtM) continue;
      const key = `${srcM}::${r.source.columns.join(',')}|${tgtM}::${r.target.columns.join(',')}`;
      refKeyByStableId.set(r.id, key);
      if (seen.has(key)) continue;
      seen.add(key);
      effectiveRefs.push({
        ...r,
        id: key,
        source: { ...r.source, table: srcM },
        target: { ...r.target, table: tgtM },
      });
    }

    return { hiddenTables, collapsedTables, collapsedNodes, containers, effectiveRefs, refKeyByStableId };
  }, [schema, positions, groupState, individuallyHidden, density]);

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
  }, [schema, positions, derived, density]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [viewportRect, setViewportRect] = useState({ w: 0, h: 0 });
  const worldMounted = ready && schema.tables.length > 0;

  // The camera is applied imperatively (same technique as the drag controller): Preact never owns
  // `.ddd-world`'s transform, so pan/zoom frames touch one style property and nothing re-renders.
  useEffect(() => {
    const apply = (vp: { x: number; y: number; zoom: number }) => {
      const el = worldRef.current;
      if (el) el.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
    };
    apply(store.getState().viewport);
    return store.subscribe((s, prev) => {
      if (s.viewport !== prev.viewport) apply(s.viewport);
    });
  }, [worldMounted]);

  // Read by the marquee pointerup without re-binding the listeners on every index rebuild.
  const spatialIndexRef = useRef(spatialIndex);
  spatialIndexRef.current = spatialIndex;
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
      const target = e.target as HTMLElement;
      // "Canvas" = the viewport background or anything inside the world (tables / groups / edges).
      // The floating chrome (zoom bar, app menu, panels) lives OUTSIDE `.ddd-world`, so panning must
      // NOT start on it — otherwise the pan tool would steal clicks from its own toggle and the menus.
      const onCanvas = target === el || target.closest('.ddd-world') != null;
      // Pan on the middle button, or the left button while the hand tool is active (toggle / Space).
      const panActive = store.getState().panMode || store.getState().spacePan;
      if (onCanvas && (e.button === 1 || (e.button === 0 && panActive))) {
        e.preventDefault();
        panning = true;
        lastX = e.clientX;
        lastY = e.clientY;
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-panning');
        return;
      }
      if (e.button === 0) {
        if (isCanvasReadOnly(store.getState())) return; // merge / git overlay: no marquee/selection
        // Only start marquee if click landed on empty viewport (not on a table / group / etc).
        if (target !== el && !target.classList.contains('ddd-world') && !target.classList.contains('ddd-group-container')) {
          return;
        }
        const rect = el.getBoundingClientRect();
        marqueeActive = true;
        marqueeStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setMarquee({ x0: marqueeStart.x, y0: marqueeStart.y, x1: marqueeStart.x, y1: marqueeStart.y });
        store.getState().setSelectedEdge(null);
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
        const hits = spatialIndexRef.current.query(world);
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
        store.getState().setSelectedEdge(null);
        return;
      }
      // Skip when typing inside an input/textarea/contenteditable (e.g. color popup).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // Hold Space → temporary pan (a navigation gesture, so allowed even in read-only overlays).
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        store.getState().setSpacePan(true);
        return;
      }
      if (isCanvasReadOnly(store.getState())) return; // merge / git overlay: no undo/redo (read-only)
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (store.getState().past.length === 0) return;
        store.getState().undo();
        schedulePersist();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        if (store.getState().future.length === 0) return;
        store.getState().redo();
        schedulePersist();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') store.getState().setSpacePan(false);
    };
    // Releasing focus while Space is held (alt-tab) would otherwise leave pan stuck on.
    const onBlur = () => store.getState().setSpacePan(false);
    // Keyboard (Space-pan, undo/redo, Escape) is bound on `window`, which only gets keys while the
    // webview iframe is focused. Merely hovering the canvas doesn't focus it, so hold-Space did
    // nothing. Focus the viewport when the pointer enters it — unless a field/dialog owns focus.
    const onPointerEnter = () => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
      if (a !== el) el.focus({ preventScroll: true });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('pointerenter', onPointerEnter);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('pointerenter', onPointerEnter);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [ready]);

  // Culled set; same Set instance while membership is unchanged (see useVisibleNames).
  const visibleNames = useVisibleNames(spatialIndex, viewportRect, ready);

  // Visible edge ids (≥ 1 endpoint visible). Memoized so EdgeLayer can route ALL refs once
  // (route-all-then-cull, spec 05 §8) and just filter the resulting routes by this set.
  const visibleRefIds = useMemo(() => {
    if (!visibleNames) return null;
    const ids = new Set<string>();
    for (const r of derived.effectiveRefs) {
      if (visibleNames.has(r.source.table) || visibleNames.has(r.target.table)) ids.add(r.id);
    }
    return ids;
  }, [visibleNames, derived.effectiveRefs]);

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
  }, [schema, positions, derived, density]);

  // Tables in a position conflict (spec 14): render ghosts for these, hide their normal node.
  const mergeTableKeys = new Set<QualifiedName>();
  if (mergeConflicts) for (const c of mergeConflicts) if (c.section === 'tables') mergeTableKeys.add(c.key);

  // Diff overlay (spec 16): translate added refs' stable ids to the edge layer's composite keys so
  // the matching edges can be tinted. Removed refs are drawn by DiffGhosts, not here.
  const edgeRefDiff = useMemo(() => {
    if (!refDiff) return null;
    const m = new Map<string, RefDiffStatus>();
    for (const [stableId, status] of refDiff) {
      if (status !== 'added') continue;
      const key = derived.refKeyByStableId.get(stableId);
      if (key) m.set(key, status);
    }
    return m;
  }, [refDiff, derived.refKeyByStableId]);

  // Diff change targets (changed live tables + removed ghosts) — feed the hover hit-layer and the
  // banner's prev/next camera navigation. Sorted for a stable step order.
  const diffTargets: DiffTarget[] = [];
  if (diffActive) {
    if (diffByTable) {
      for (const [name] of diffByTable) {
        const p = positions.get(name);
        const t = tablesByName.get(name);
        if (!p || !t) continue;
        const s = estimateSize(t.columns.length);
        diffTargets.push({ name, x: p.x, y: p.y, w: s.width, h: s.height });
      }
    }
    if (diffGhosts) {
      for (const g of diffGhosts) {
        const s = estimateSize(g.table.columns.length);
        diffTargets.push({ name: g.table.name, x: g.pos.x, y: g.pos.y, w: s.width, h: s.height });
      }
    }
    diffTargets.sort((a, b) => a.name.localeCompare(b.name));
  }

  const renderedTables = schema.tables.filter(
    (t) => !derived.hiddenTables.has(t.name) && !derived.collapsedTables.has(t.name),
  );

  const visibleTableCount = renderedTables.length + derived.collapsedNodes.length;
  const totalTableCount = schema.tables.length - derived.hiddenTables.size;

  return (
    <>
      <div class={panActive ? 'ddd-viewport is-pan-mode' : 'ddd-viewport'} ref={viewportRef} tabIndex={0}>
        {worldMounted ? (
          <div ref={worldRef} class={readOnly ? 'ddd-world is-merge-locked' : 'ddd-world'}>
            {snapToGrid ? (
              <div
                class="ddd-grid"
                style={{
                  left: `${worldBbox.x}px`,
                  top: `${worldBbox.y}px`,
                  width: `${worldBbox.w}px`,
                  height: `${worldBbox.h}px`,
                  backgroundSize: `${gridSize}px ${gridSize}px`,
                }}
              />
            ) : null}
            {derived.containers.map((c) => (
              <GroupContainer key={`container:${c.name}`} name={c.name} x={c.x} y={c.y} w={c.w} h={c.h} color={c.color} />
            ))}
            <EdgeLayer
              refs={derived.effectiveRefs}
              visibleRefIds={visibleRefIds}
              lod={lod}
              positions={positionsEffective}
              tablesByName={tablesByName}
              groupSizes={derived.collapsedNodes}
              worldBbox={worldBbox}
              refDiff={edgeRefDiff}
            />
            {renderedTables.map((t) => {
              if (visibleNames && !visibleNames.has(t.name)) return null;
              if (mergeTableKeys.has(t.name)) return null; // shown as ghosts during conflict resolution
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
                  diffStatus={diffByTable?.get(t.name)}
                  diffBase={diffBaseByTable?.get(t.name)}
                  columnDiff={columnDiffByTable?.get(t.name)}
                  dimmed={focusDimming && ((diffActive && !diffByTable?.has(t.name)) || (mergeConflicts != null && !mergeTableKeys.has(t.name)))}
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
            {mergeConflicts ? <MergeGhosts tablesByName={tablesByName} /> : null}
            {diffActive ? (
              <DiffGhosts
                ghosts={diffGhosts ?? []}
                removedRefs={diffRemovedRefs ?? []}
                positions={positions}
                tablesByName={tablesByName}
              />
            ) : null}
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
        {ready ? <AppMenu /> : null}
        {ready ? <GroupPanel /> : null}
        {ready ? <ZoomButtons /> : null}
        {ready && !readOnly ? <ActionsPanel /> : null}
        {ready && mergeConflicts ? <MergePanel /> : null}
        {ready && gitView ? <GitBanner diffTargets={diffTargets} /> : null}
      </div>
      {parseError ? (
        <div class="ddd-banner" title={parseError.message}>
          Parse error
          {parseError.line != null ? ` (line ${parseError.line})` : ''}: {parseError.message}
        </div>
      ) : null}
      {ready ? (
        <div class="ddd-statusbar">
          {visibleNames ? visibleNames.size : visibleTableCount}/{totalTableCount} visible · {derived.effectiveRefs.length} refs · zoom <ZoomPct />% · LOD {lod}
          {selection.size > 0 ? ` · ${selection.size} selected` : ''}
        </div>
      ) : null}
      <Tooltip />
      <ExportModal />
      <ExportImageModal derived={derived} />
      <SettingsPanel />
      <GitPanel />
      <EdgeOrderProgress />
    </>
  );
}

/** Statusbar zoom readout — the only piece of `App` that follows the camera, kept in its own leaf. */
function ZoomPct() {
  const pct = useAppStore((s) => Math.round(s.viewport.zoom * 100));
  return <>{pct}</>;
}
