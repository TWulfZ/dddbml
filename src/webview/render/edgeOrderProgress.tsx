import { useAppStore } from '../state/store';
import { memo } from 'preact/compat';
import { cancelEdgeOrdering } from '../layout/smartLayout';

/**
 * Cancelable progress overlay for the on-demand A* edge-ordering run (spec 05 §9, E4). Self-hides
 * when idle. Subscribes to `edgeOrderProgress` via a granular selector — a separate store slice the
 * edge-route memo does NOT read, so pumping progress never re-routes edges. Tokens only; the bar
 * transition is gated on `prefers-reduced-motion` in style.css.
 */
function EdgeOrderProgressImpl() {
  const prog = useAppStore((s) => s.edgeOrderProgress);
  if (!prog) return null;
  return (
    <div class="ddd-edge-order-overlay" role="status" aria-live="polite">
      <div class="ddd-edge-order-overlay__card">
        <div class="ddd-edge-order-overlay__label">Ordering edges… {prog.pct}%</div>
        <div class="ddd-edge-order-overlay__bar">
          <div class="ddd-edge-order-overlay__fill" style={{ width: `${prog.pct}%` }} />
        </div>
        <button
          class="ddd-edge-order-overlay__cancel"
          type="button"
          onClick={() => cancelEdgeOrdering()}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// memo: App re-renders on many store slices; this only re-renders via its own subscriptions.
export const EdgeOrderProgress = memo(EdgeOrderProgressImpl);
