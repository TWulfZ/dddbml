import { useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../persistence';
import { fitToContent, zoomAtCenter, zoomToAtCenter } from './viewport';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { IconFitScreen, IconMinus, IconPan, IconPlus, IconRedo, IconUndo } from '../icons';

function ZoomButtonsImpl() {
  const zoom = useAppStore((s) => s.viewport.zoom);
  const zoomStep = useAppStore((s) => s.settings.zoomStep);
  const pastLen = useAppStore((s) => s.past.length);
  const futureLen = useAppStore((s) => s.future.length);
  const panMode = useAppStore((s) => s.panMode);
  const spacePan = useAppStore((s) => s.spacePan);
  const panActive = panMode || spacePan;
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
      <Tooltip label="Pan tool" shortcut="Space (hold)">
        <Button
          variant="zoom"
          size="tool"
          active={panActive}
          aria-pressed={panActive}
          onClick={() => store.getState().setPanMode(!store.getState().panMode)}
        >
          <IconPan size={14} />
        </Button>
      </Tooltip>
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
      <ZoomInput zoom={zoom} />
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
  // Escape blurs the field, and blur commits; the flag makes that one blur discard the draft
  // (the `draft` closure still holds the typed value when blur fires synchronously).
  const cancelRef = useRef(false);
  const displayed = draft ?? String(Math.round(zoom * 100));

  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const n = parseFloat(draft.replace('%', '').trim());
    const el = document.querySelector<HTMLElement>('.ddd-viewport');
    if (Number.isFinite(n) && n > 0 && el) zoomToAtCenter(n / 100, el);
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
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            cancelRef.current = true;
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={commit}
      />
      <span class="ddd-zoom__pct-symbol" aria-hidden="true">%</span>
    </label>
  );
}

// memo: App re-renders on many store slices; this only re-renders via its own subscriptions.
export const ZoomButtons = memo(ZoomButtonsImpl);
