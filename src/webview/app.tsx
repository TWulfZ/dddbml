import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { store, useAppStore, isCanvasReadOnly } from './state/store';
import { autoLayout, estimateSize } from './layout/autoLayout';
import { smartLayout } from './layout/smartLayout/layout';
import { buildRowGeometry, fkColumnsByTable as fkColumnsOf } from './layout/tableRows';
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
import { isGestureActive } from './drag/dragController';
import { panBy, zoomAt } from './render/viewport';
import { SceneCache, CONTAINER_PREFIX, containerNodeId as containerId, groupNodeId as groupId } from './render/sceneCache';
import { lodForZoom } from './render/lod';
import { useVisibleEdgeIds, useVisibleNames } from './render/useVisibleNames';
import { GroupPanel, colorForGroup } from './groups/groupPanel';
import { Tooltip } from './render/tooltip';
import { ExportModal } from './render/exportModal';
import { ExportImageModal } from './render/exportImageModal';
import { SettingsPanel } from './render/settingsPanel';
import { GitPanel } from './render/gitPanel';
import { EdgeOrderProgress } from './render/edgeOrderProgress';
import { GitBanner, buildDiffTargets } from './render/gitBanner';
import { DiffGhosts } from './render/diffGhosts';
import { ErrorBoundary } from './ui/ErrorBoundary';
import type { QualifiedName, RefDiffStatus, Table, WebviewToHost } from '../shared/types';

interface AppProps {
  post: (msg: WebviewToHost) => void;
}

/** Synthetic index entries (collapsed groups, containers) — never selectable, never counted. */
const isSynthetic = (name: string) => name.startsWith('__');

const applyCamera = (el: HTMLElement, vp: { x: number; y: number; zoom: number }) => {
  el.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
};

/** Open overlays that consume Escape themselves; dismissing one must not also clear the selection. */
const ESCAPE_OWNING_OVERLAYS = 'dialog[open], .ddd-context-menu, .ddd-color-popup, .ddd-app-menu__popover';

/** Fields that consume Space/typing themselves (zoom %, group search, color popup hex input). */
const isTextField = (t: HTMLElement | null): boolean =>
  t != null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

export function App(_props: AppProps) {
  const schema = useAppStore((s) => s.schema);
  const parseError = useAppStore((s) => s.parseError);
  const positions = useAppStore((s) => s.positions);
  const ready = useAppStore((s) => s.ready);
  const groupState = useAppStore((s) => s.groups);
  const individuallyHidden = useAppStore((s) => s.hiddenTables);
  const tableColors = useAppStore((s) => s.tableColors);
  const edgeLayouts = useAppStore((s) => s.edgeLayouts);
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
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
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

  // Auto-layout tables that have no position. Depends on `positions` too: "Reset layout" empties
  // them without touching the schema, and the effect must re-run or the canvas stays blank.
  // The closure values are only re-run triggers: the effect flushes after paint, and a layout:loaded
  // that lands between render and flush (time-travel exit, reload) must not be overwritten by
  // positions laid out from the stale closure.
  useEffect(() => {
    const { ready: isReady, schema: liveSchema, positions: livePositions } = store.getState();
    if (!isReady) return;
    const missing = liveSchema.tables.filter((t) => !livePositions.has(t.name));
    if (missing.length === 0) return;
    const columnCount = new Map(liveSchema.tables.map((t) => [t.name, t.columns.length]));
    const sizeOf = (name: QualifiedName) => estimateSize(columnCount.get(name) ?? 0);
    // With tables already on the canvas, flat dagre would stack the new ones at its margin on top
    // of them (audit F19); smart 'new' mode places them by their group/FK neighbours, clear of others.
    const laidOut =
      livePositions.size === 0
        ? autoLayout(liveSchema.tables, liveSchema.refs, sizeOf)
        : smartLayout({
            tables: liveSchema.tables,
            refs: liveSchema.refs,
            groups: liveSchema.groups,
            sizeOf,
            mode: 'new',
            existing: livePositions,
            spacing: store.getState().settings.ui.layoutSpacing,
          });
    const entries: Array<[QualifiedName, { x: number; y: number }]> = [];
    for (const t of missing) {
      const pos = laidOut.get(t.name);
      if (pos) entries.push([t.name, pos]);
    }
    if (entries.length > 0) store.getState().setPositionsBatch(entries);
  }, [schema, positions, ready]);

  /** Set of "table::column" keys for every column that participates in any ref. */
  const fkColumnsByTable = useMemo(() => fkColumnsOf(schema.refs), [schema]);

  // Rows each table actually draws (PK/FK filter, inline diff): every on-canvas size and port must
  // count these, not the full column list, or edges and group boxes drift off the nodes.
  const rowGeometry = useMemo(
    () => buildRowGeometry({ tables: schema.tables, showOnlyPkFk, fkColumnsByTable, diffByTable, diffBaseByTable, columnDiffByTable }),
    [schema, showOnlyPkFk, fkColumnsByTable, diffByTable, diffBaseByTable, columnDiffByTable],
  );

  // Scene geometry, spatial index, edge boxes and world bbox. A drag frame's positions-only delta is
  // applied incrementally (index moves, edge re-boxing) instead of rebuilding over every table (spec 04).
  const [sceneCache] = useState(() => new SceneCache());
  const scene = useMemo(
    () => sceneCache.update({ schema, positions, groupState, individuallyHidden, tablesByName, rows: rowGeometry, edgeLayouts, density }),
    [sceneCache, schema, positions, groupState, individuallyHidden, tablesByName, rowGeometry, edgeLayouts, density],
  );
  const { derived, spatialIndex, edgeBoxes, worldBbox } = scene;

  const exportDerived = useMemo(() => ({ ...derived, containers: derived.exportContainers }), [derived]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const [viewportRect, setViewportRect] = useState({ w: 0, h: 0 });
  // A merge mounts the world even with no parsed tables (the .dbml can conflict too): the ghosts
  // fall back to chips, and without them table conflicts could not be picked.
  const worldMounted = ready && (schema.tables.length > 0 || mergeConflicts != null);

  // The camera is applied imperatively (same technique as the drag controller): Preact never owns
  // `.ddd-world`'s transform, so pan/zoom frames touch one style property and nothing re-renders.
  // The callback ref applies it as soon as any world node attaches (first mount, boundary Retry),
  // before paint — a post-paint effect showed one frame at identity scale.
  const attachWorld = useCallback((el: HTMLDivElement | null) => {
    worldRef.current = el;
    if (el) applyCamera(el, store.getState().viewport);
  }, []);
  useEffect(() => {
    if (worldRef.current) applyCamera(worldRef.current, store.getState().viewport);
    return store.subscribe((s, prev) => {
      if (s.viewport !== prev.viewport && worldRef.current) applyCamera(worldRef.current, s.viewport);
    });
  }, []);

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

    // "Canvas" = the viewport background or anything inside the world (tables / groups / edges).
    // The floating chrome (zoom bar, app menu, panels) lives OUTSIDE `.ddd-world`, so canvas gestures
    // must not start on it — panning would steal clicks from its toggles, and wheel-zoom would keep
    // its scrollable lists from scrolling.
    const isCanvasTarget = (target: EventTarget | null): boolean =>
      target === el || (target instanceof Element && target.closest('.ddd-world') != null);
    // Space-pan owns the key only for the viewport (canvas + its toolbars) or when nothing has focus.
    // Modals and portaled menus live outside it, so their buttons, radios and selects keep native
    // Space activation for keyboard users.
    const isSpacePanTarget = (t: HTMLElement | null): boolean =>
      t == null || t === document.body || t === document.documentElement || el.contains(t);

    const onWheel = (e: WheelEvent) => {
      if (!isCanvasTarget(e.target)) return;
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
      const onCanvas = isCanvasTarget(target);
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
        for (const h of hits) if (!isSynthetic(h)) realHits.push(h);
        if (e.shiftKey) {
          const merged = new Set(store.getState().selection);
          for (const n of realHits) merged.add(n);
          store.getState().setSelection(merged);
        } else {
          store.getState().setSelection(realHits);
        }
      }
    };

    // Capture phase on purpose: the overlays close on Escape from their own document/dialog
    // handlers, and Preact unmounts them in a microtask before a bubbling window listener would
    // run — by then the DOM no longer shows that this Escape belonged to a menu or modal.
    const onEscapeCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isTextField(e.target as HTMLElement | null)) return;
      if (document.querySelector(ESCAPE_OWNING_OVERLAYS)) return;
      store.getState().clearSelection();
      store.getState().setSelectedEdge(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (isTextField(t)) return;
      // Hold Space → temporary pan (a navigation gesture, so allowed even in read-only overlays).
      // Every keydown is cancelled, auto-repeats included: an uncancelled repeat arms the focused
      // toolbar button and its keyup then clicks it (an extra undo / zoom on release).
      if (e.key === ' ' && isSpacePanTarget(t)) {
        e.preventDefault();
        if (!e.repeat) store.getState().setSpacePan(true);
        return;
      }
      if (isCanvasReadOnly(store.getState())) return; // merge / git overlay: no undo/redo (read-only)
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      // Mid-gesture the drag rewrites positions/waypoints from its pointerdown snapshot and then
      // pushes a command that clears `future`, so an undo here would be silently lost (spec 11).
      if ((k === 'z' || k === 'y') && isGestureActive()) {
        e.preventDefault();
        return;
      }
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
      if (e.key !== ' ') return;
      if (store.getState().spacePan && !isTextField(e.target as HTMLElement | null)) e.preventDefault();
      store.getState().setSpacePan(false);
    };
    // Releasing focus while Space is held (alt-tab) would otherwise leave pan stuck on.
    const onBlur = () => store.getState().setSpacePan(false);
    // Keyboard (Space-pan, undo/redo, Escape) is bound on `window`, which only gets keys while the
    // webview iframe is focused. Merely hovering the canvas doesn't focus it, so hold-Space did
    // nothing. Focus the viewport when the pointer enters it — unless a field/dialog owns focus.
    const onPointerEnter = () => {
      const a = document.activeElement as HTMLElement | null;
      if (isTextField(a)) return;
      if (a !== el) el.focus({ preventScroll: true });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('pointerenter', onPointerEnter);
    window.addEventListener('keydown', onEscapeCapture, true);
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
      window.removeEventListener('keydown', onEscapeCapture, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [ready]);

  // Culled set; same Set instance while membership is unchanged (see useVisibleNames).
  const visibleNames = useVisibleNames(spatialIndex, viewportRect, ready);

  // EdgeLayer routes ALL refs once (route-all-then-cull, spec 05 §8) and filters routes by this set.
  const visibleRefIds = useVisibleEdgeIds(edgeBoxes, viewportRect, ready);

  // Tables in a position conflict (spec 14): render ghosts for these, hide their normal node.
  const mergeTableKeys = new Set<QualifiedName>();
  if (mergeConflicts) for (const c of mergeConflicts) if (c.section === 'tables') mergeTableKeys.add(c.key);

  // Diff overlay (spec 16): translate added/changed refs' stable ids to the edge layer's composite
  // keys so the matching edges can be tinted. Removed refs are drawn by DiffGhosts, not here.
  const edgeRefDiff = useMemo(() => {
    if (!refDiff) return null;
    const m = new Map<string, RefDiffStatus>();
    for (const [stableId, status] of refDiff) {
      if (status === 'removed') continue;
      const key = derived.refKeyByStableId.get(stableId);
      if (key) m.set(key, status);
    }
    return m;
  }, [refDiff, derived.refKeyByStableId]);

  // Diff change targets (changed live tables + removed ghosts) for the banner's prev/next camera
  // navigation, resolved through the view filters so a step never lands on a hidden/collapsed table.
  const diffTargets = useMemo(
    () => (diffActive ? buildDiffTargets(diffByTable, diffGhosts, positions, tablesByName, derived) : []),
    [diffActive, diffByTable, diffGhosts, positions, tablesByName, derived],
  );

  const { hiddenTables, collapsedTables } = derived;
  const renderedTables = useMemo(
    () => schema.tables.filter((t) => !hiddenTables.has(t.name) && !collapsedTables.has(t.name)),
    [schema, hiddenTables, collapsedTables],
  );

  const visibleTableCount = renderedTables.length + derived.collapsedNodes.length;
  const visibleCount = useMemo(() => {
    if (!visibleNames) return visibleTableCount;
    let n = 0;
    for (const name of visibleNames) if (!name.startsWith(CONTAINER_PREFIX)) n++;
    return n;
  }, [visibleNames, visibleTableCount]);
  // Counted over live tables: `hiddenTables` also holds orphan entries kept for tables that are
  // temporarily absent from the DBML (parse error, rename + undo).
  const totalTableCount = schema.tables.reduce((n, t) => n + (derived.hiddenTables.has(t.name) ? 0 : 1), 0);

  return (
    <>
      <div class={panActive ? 'ddd-viewport is-pan-mode' : 'ddd-viewport'} ref={viewportRef} tabIndex={0}>
        {worldMounted ? (
          <ErrorBoundary scope="canvas">
          <div ref={attachWorld} class={readOnly ? 'ddd-world is-merge-locked' : 'ddd-world'}>
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
            {derived.containers.map((c) => {
              if (visibleNames && !visibleNames.has(containerId(c.name))) return null;
              return <GroupContainer key={`container:${c.name}`} name={c.name} x={c.x} y={c.y} w={c.w} h={c.h} color={c.color} />;
            })}
            <EdgeLayer
              refs={derived.effectiveRefs}
              visibleRefIds={visibleRefIds}
              lod={lod}
              positions={positions}
              rows={rowGeometry}
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
            {mergeConflicts ? <MergeGhosts tablesByName={tablesByName} viewportRect={viewportRect} lod={lod} /> : null}
            {diffActive ? (
              <DiffGhosts
                ghosts={diffGhosts ?? []}
                removedRefs={diffRemovedRefs ?? []}
                positions={positions}
                tablesByName={tablesByName}
                filters={derived}
              />
            ) : null}
          </div>
          </ErrorBoundary>
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
        <ErrorBoundary scope="toolbars">
          {ready ? <AppMenu /> : null}
          {ready ? <GroupPanel /> : null}
          {ready ? <ZoomButtons /> : null}
          {ready && !readOnly ? <ActionsPanel /> : null}
          {ready && mergeConflicts ? <MergePanel /> : null}
          {ready && gitView ? <GitBanner diffTargets={diffTargets} /> : null}
        </ErrorBoundary>
      </div>
      {parseError ? (
        <div class="ddd-banner" title={parseError.message}>
          Parse error
          {parseError.line != null ? ` (line ${parseError.line})` : ''}: {parseError.message}
        </div>
      ) : null}
      {ready ? (
        <div class="ddd-statusbar">
          {visibleCount}/{totalTableCount} visible · {derived.effectiveRefs.length} refs · zoom <ZoomPct />% · LOD {lod}
          {selection.size > 0 ? ` · ${selection.size} selected` : ''}
        </div>
      ) : null}
      <ErrorBoundary scope="overlays">
        <Tooltip />
        <ExportModal />
        <ExportImageModal derived={exportDerived} />
        <SettingsPanel />
        <GitPanel />
        <EdgeOrderProgress />
      </ErrorBoundary>
    </>
  );
}

/** Statusbar zoom readout — the only piece of `App` that follows the camera, kept in its own leaf. */
function ZoomPct() {
  const pct = useAppStore((s) => Math.round(s.viewport.zoom * 100));
  return <>{pct}</>;
}
