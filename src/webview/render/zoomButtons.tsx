import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../persistence';
import { fitToContent, zoomAtCenter } from './viewport';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { IconFitScreen, IconMinus, IconPlus, IconRedo, IconUndo } from '../icons';

export function ZoomButtons() {
  const viewport = useAppStore((s) => s.viewport);
  const zoomStep = useAppStore((s) => s.settings.zoomStep);
  const pastLen = useAppStore((s) => s.past.length);
  const futureLen = useAppStore((s) => s.future.length);
  const getEl = () => document.querySelector<HTMLElement>('.ddd-viewport');

  const undo = () => {
    if (store.getState().past.length === 0) return;
    store.getState().undo();
    schedulePersist();
  };
  const redo = () => {
    if (store.getState().future.length === 0) return;
    store.getState().redo();
    schedulePersist();
  };

  return (
    <div class="ddd-zoom">
      <Tooltip label="Undo" shortcut="Ctrl+Z">
        <Button variant="history" size="tool" disabled={pastLen === 0} onClick={undo}>
          <IconUndo size={14} />
        </Button>
      </Tooltip>
      <Tooltip label="Redo" shortcut="Ctrl+Shift+Z">
        <Button variant="history" size="tool" disabled={futureLen === 0} onClick={redo}>
          <IconRedo size={14} />
        </Button>
      </Tooltip>
      <span class="ddd-zoom__divider" aria-hidden="true" />
      <Tooltip label="Zoom out" shortcut="Ctrl+-">
        <Button variant="zoom" size="tool" onClick={() => { const el = getEl(); if (el) zoomAtCenter(1 / zoomStep, el); }}>
          <IconMinus size={14} />
        </Button>
      </Tooltip>
      <ZoomInput zoom={viewport.zoom} />
      <Tooltip label="Zoom in" shortcut="Ctrl+=">
        <Button variant="zoom" size="tool" onClick={() => { const el = getEl(); if (el) zoomAtCenter(zoomStep, el); }}>
          <IconPlus size={14} />
        </Button>
      </Tooltip>
      <Tooltip label="Fit to content" shortcut="Ctrl+1">
        <Button variant="zoom" size="tool" onClick={() => { const el = getEl(); if (el) fitToContent(el); }}>
          <IconFitScreen size={14} />
        </Button>
      </Tooltip>
    </div>
  );
}

function ZoomInput({ zoom }: { zoom: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const { zoomMin, zoomMax } = useAppStore((s) => ({ zoomMin: s.settings.zoomMin, zoomMax: s.settings.zoomMax }));
  const displayed = draft ?? String(Math.round(zoom * 100));

  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft.replace('%', '').trim());
    if (Number.isFinite(n) && n > 0) {
      const nextZoom = Math.max(zoomMin, Math.min(zoomMax, n / 100));
      store.getState().setViewport({ zoom: nextZoom });
    }
    setDraft(null);
  };

  return (
    <label class="ddd-zoom__pct" title="Set zoom (Enter to apply, Ctrl+0 to reset)">
      <input
        class="ddd-zoom__input"
        type="text"
        value={displayed}
        onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(null);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={commit}
      />
      <span class="ddd-zoom__pct-symbol" aria-hidden="true">%</span>
    </label>
  );
}
