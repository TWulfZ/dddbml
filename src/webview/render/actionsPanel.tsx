import { useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { ContextMenu, clampMenuAnchor, type ContextMenuItem } from './contextMenu';
import { runSmartLayout } from '../layout/smartLayout';
import {
  IconAutoArrange,
  IconChevronDown,
  IconChevronUp,
  IconGoToFile,
  IconMagnet,
  IconSearch,
  IconSettings,
} from '../icons';

/**
 * Floating bottom-center tool bar. Collapses to a single chevron handle and expands to one row of
 * fixed-size icon buttons (each with a styled Tooltip). Auto-arrange opens a popover (reusing the
 * generic ContextMenu) for its scope options. Undo/redo live in the zoom cluster and the PK/FK view
 * filter lives in Diagram Views — see spec 12 / spec 06.
 */
export function ActionsPanel() {
  const [open, setOpen] = useState(false);
  const [arrangeMenu, setArrangeMenu] = useState<{ x: number; y: number } | null>(null);
  const snapToGrid = useAppStore((s) => s.settings.ui.snapToGrid);
  const selCount = useAppStore((s) => s.selection.size);

  const arrange = (mode: 'all' | 'new' | 'selection') => {
    void runSmartLayout(mode);
    setArrangeMenu(null);
  };

  // Anchor the popover just above the auto-arrange button (the bar sits at the bottom).
  const openArrangeMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const estHeight = 104;
    const { x, y } = clampMenuAnchor(r.left, r.top - 8 - estHeight, 200, estHeight);
    setArrangeMenu({ x, y });
  };

  const arrangeItems: ContextMenuItem[] = [
    { label: 'Re-arrange all', onClick: () => arrange('all') },
    { label: 'Place new tables', onClick: () => arrange('new') },
    { label: `Re-arrange selection (${selCount})`, onClick: () => arrange('selection'), disabled: selCount === 0 },
  ];

  if (!open) {
    return (
      <div class="ddd-actions-bar is-collapsed">
        <Tooltip label="Show tools">
          <Button variant="subtle" size="tool" onClick={() => setOpen(true)}>
            <IconChevronUp size={14} />
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div class="ddd-actions-bar is-expanded">
      <div class="ddd-actions-bar__row">
        <Tooltip label="Auto-arrange">
          <Button variant="subtle" size="tool" active={arrangeMenu !== null} onClick={openArrangeMenu}>
            <IconAutoArrange size={14} />
          </Button>
        </Tooltip>
        <Tooltip label={snapToGrid ? 'Snap to grid: on' : 'Snap to grid: off'}>
          <Button
            variant="subtle"
            size="tool"
            active={snapToGrid}
            onClick={() => postToHost({ type: 'settings:update', payload: { 'ui.snapToGrid': !snapToGrid } })}
          >
            <IconMagnet size={14} />
          </Button>
        </Tooltip>
        <Tooltip label="Search tables & groups">
          <Button variant="subtle" size="tool" onClick={() => store.getState().openViewsAndFocusSearch()}>
            <IconSearch size={14} />
          </Button>
        </Tooltip>
        <span class="ddd-actions-bar__divider" aria-hidden="true" />
        <Tooltip label="Export…">
          <Button variant="subtle" size="tool" onClick={() => store.getState().setExportPromptOpen(true)}>
            <IconGoToFile size={14} />
          </Button>
        </Tooltip>
        <Tooltip label="Settings">
          <Button variant="subtle" size="tool" onClick={() => store.getState().setSettingsPanelOpen(true)}>
            <IconSettings size={14} />
          </Button>
        </Tooltip>
        <span class="ddd-actions-bar__divider" aria-hidden="true" />
        <Tooltip label="Hide tools">
          <Button variant="subtle" size="tool" onClick={() => setOpen(false)}>
            <IconChevronDown size={14} />
          </Button>
        </Tooltip>
      </div>
      {arrangeMenu ? (
        <ContextMenu x={arrangeMenu.x} y={arrangeMenu.y} items={arrangeItems} onClose={() => setArrangeMenu(null)} />
      ) : null}
    </div>
  );
}
