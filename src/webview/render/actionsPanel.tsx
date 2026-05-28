import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../persistence';
import { postToHost } from '../vscode';
import { IconChevronDown, IconChevronUp, IconFilter, IconGoToFile, IconMagnet, IconRedo, IconSettings, IconUndo } from '../icons';

/**
 * Floating bottom-center actions panel. Footer row (undo/redo + chevron) is always visible.
 * Remaining actions (filter, export, settings) expand above when open.
 */
export function ActionsPanel() {
  const [open, setOpen] = useState(false);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
  const snapToGrid = useAppStore((s) => s.settings.ui.snapToGrid);
  const pastLen = useAppStore((s) => s.past.length);
  const futureLen = useAppStore((s) => s.future.length);

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
    <div class={`ddd-actions-panel ${open ? 'is-open' : 'is-closed'}`}>
      <div class="ddd-actions-panel__footer">
        <button
          class="ddd-hist-btn"
          disabled={pastLen === 0}
          onClick={undo}
          title="Undo (Ctrl+Z)"
        >
          <IconUndo size={13} />
        </button>
        <button
          class="ddd-hist-btn"
          disabled={futureLen === 0}
          onClick={redo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <IconRedo size={13} />
        </button>
        <button
          class={`ddd-hist-btn ${snapToGrid ? 'is-active' : ''}`}
          onClick={() => postToHost({ type: 'settings:update', payload: { 'ui.snapToGrid': !snapToGrid } })}
          title={snapToGrid ? 'Magnet on — snap to grid' : 'Magnet off — free move'}
        >
          <IconMagnet size={13} />
        </button>
        <button
          class="ddd-actions-panel__handle"
          onClick={() => setOpen(!open)}
          title={open ? 'Hide actions' : 'Show actions'}
        >
          {open ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
        </button>
      </div>
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
          <button
            class="ddd-actions-btn"
            onClick={() => store.getState().setExportPromptOpen(true)}
            title="Export schema to TypeORM (or other formats)"
          >
            <IconGoToFile size={12} />
            <span>Export…</span>
          </button>
          <button
            class="ddd-actions-btn"
            onClick={() => store.getState().setSettingsPanelOpen(true)}
            title="Open settings"
          >
            <IconSettings size={12} />
            <span>Settings</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
