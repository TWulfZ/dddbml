import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { IconChevronDown, IconChevronUp, IconFilter } from '../icons';

/**
 * Floating bottom-center actions panel. Collapses to a single chevron handle.
 * Hosts view-toggles that are ephemeral (not persisted), e.g. show-only-PK/FK.
 */
export function ActionsPanel() {
  const [open, setOpen] = useState(false);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);

  return (
    <div class={`ddd-actions-panel ${open ? 'is-open' : 'is-closed'}`}>
      <button
        class="ddd-actions-panel__handle"
        onClick={() => setOpen(!open)}
        title={open ? 'Hide actions' : 'Show actions'}
      >
        {open ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
      </button>
      {open ? (
        <div class="ddd-actions-panel__body">
          <button
            class={`ddd-actions-btn ${showOnlyPkFk ? 'is-active' : ''}`}
            onClick={() => store.getState().toggleShowOnlyPkFk()}
            title="Toggle PK/FK-only column view"
          >
            <IconFilter size={12} />
            <span>{showOnlyPkFk ? 'Show all columns' : 'PK/FK only'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
