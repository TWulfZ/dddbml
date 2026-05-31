import { store } from '../state/store';

export interface DiffTarget {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Transparent hover targets over each diff table/ghost (spec 16). Lives in its own layer that is
 * EXEMPT from the read-only `pointer-events:none` belt (see `.ddd-diff-hit-layer` in style.css), so
 * the diagram stays non-editable while diff tables remain hoverable for the Previous|Current card.
 * Sits inside the transformed `.ddd-world`, so target coords are world coords.
 */
export function DiffHitLayer({ targets }: { targets: DiffTarget[] }) {
  return (
    <div class="ddd-diff-hit-layer">
      {targets.map((t) => (
        <div
          key={t.name}
          class="ddd-diff-hit"
          style={{
            position: 'absolute',
            transform: `translate3d(${t.x}px, ${t.y}px, 0)`,
            width: `${t.w}px`,
            height: `${t.h}px`,
          }}
          onMouseEnter={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            store.getState().setDiffHover({ name: t.name, anchor: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } });
          }}
          onMouseLeave={() => {
            if (store.getState().diffHover?.name === t.name) store.getState().setDiffHover(null);
          }}
        />
      ))}
    </div>
  );
}
