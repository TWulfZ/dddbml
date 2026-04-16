import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { fitToContent, zoomAtCenter } from './viewport';
import { IconFitScreen, IconMinus, IconPlus } from '../icons';

export function ZoomButtons() {
  const viewport = useAppStore((s) => s.viewport);
  const getEl = () => document.querySelector<HTMLElement>('.ddd-viewport');

  return (
    <div class="ddd-zoom">
      <button class="ddd-zoom__btn" title="Zoom out (Ctrl+-)" onClick={() => { const el = getEl(); if (el) zoomAtCenter(1 / 1.2, el); }}>
        <IconMinus size={13} />
      </button>
      <ZoomInput zoom={viewport.zoom} />
      <button class="ddd-zoom__btn" title="Zoom in (Ctrl+=)" onClick={() => { const el = getEl(); if (el) zoomAtCenter(1.2, el); }}>
        <IconPlus size={13} />
      </button>
      <button class="ddd-zoom__btn" title="Fit to content (Ctrl+1)" onClick={() => { const el = getEl(); if (el) fitToContent(el); }}>
        <IconFitScreen size={13} />
      </button>
    </div>
  );
}

function ZoomInput({ zoom }: { zoom: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const displayed = draft ?? String(Math.round(zoom * 100));

  const commit = () => {
    if (draft === null) return;
    const n = parseFloat(draft.replace('%', '').trim());
    if (Number.isFinite(n) && n > 0) {
      const nextZoom = Math.max(0.08, Math.min(4, n / 100));
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
