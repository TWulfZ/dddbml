import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { schedulePersist } from '../persistence';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { runSmartLayout } from '../layout/smartLayout';
import { IconAutoArrange, IconChevronDown, IconChevronUp, IconFilter, IconGoToFile, IconMagnet, IconRedo, IconSettings, IconUndo } from '../icons';

/**
 * Floating bottom-center actions panel. Footer row (undo/redo + chevron) is always visible.
 * Remaining actions (filter, export, settings) expand above when open.
 */
export function ActionsPanel() {
  const [open, setOpen] = useState(false);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const showOnlyPkFk = useAppStore((s) => s.showOnlyPkFk);
  const snapToGrid = useAppStore((s) => s.settings.ui.snapToGrid);
  const pastLen = useAppStore((s) => s.past.length);
  const futureLen = useAppStore((s) => s.future.length);
  const selCount = useAppStore((s) => s.selection.size);

  const arrange = (mode: 'all' | 'new' | 'selection') => {
    void runSmartLayout(mode);
    setArrangeOpen(false);
  };

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
        <Button
          variant="history"
          disabled={pastLen === 0}
          onClick={undo}
          title="Undo (Ctrl+Z)"
        >
          <IconUndo size={13} />
        </Button>
        <Button
          variant="history"
          disabled={futureLen === 0}
          onClick={redo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <IconRedo size={13} />
        </Button>
        <Button
          variant="history"
          active={snapToGrid}
          onClick={() => postToHost({ type: 'settings:update', payload: { 'ui.snapToGrid': !snapToGrid } })}
          title={snapToGrid ? 'Magnet on — snap to grid' : 'Magnet off — free move'}
        >
          <IconMagnet size={13} />
        </Button>
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
          <Button
            variant="action"
            active={arrangeOpen}
            onClick={() => setArrangeOpen(!arrangeOpen)}
            title="Smart auto-layout — order tables by their relationships and groups"
          >
            <IconAutoArrange size={12} />
            <span>Auto-arrange</span>
          </Button>
          {arrangeOpen ? (
            <>
              <Button variant="action" onClick={() => arrange('all')} title="Re-arrange every table">
                <span>Re-arrange all</span>
              </Button>
              <Button variant="action" onClick={() => arrange('new')} title="Place only tables without a saved position">
                <span>Place new tables</span>
              </Button>
              <Button
                variant="action"
                disabled={selCount === 0}
                onClick={() => arrange('selection')}
                title="Re-arrange only the selected tables"
              >
                <span>Re-arrange selection ({selCount})</span>
              </Button>
            </>
          ) : null}
          <Button
            variant="action"
            active={showOnlyPkFk}
            onClick={() => store.getState().toggleShowOnlyPkFk()}
            title="Toggle PK/FK-only column view"
          >
            <IconFilter size={12} />
            <span>{showOnlyPkFk ? 'Show all columns' : 'PK/FK only'}</span>
          </Button>
          <Button
            variant="action"
            onClick={() => store.getState().setExportPromptOpen(true)}
            title="Export schema to TypeORM (or other formats)"
          >
            <IconGoToFile size={12} />
            <span>Export…</span>
          </Button>
          <Button
            variant="action"
            onClick={() => store.getState().setSettingsPanelOpen(true)}
            title="Open settings"
          >
            <IconSettings size={12} />
            <span>Settings</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
