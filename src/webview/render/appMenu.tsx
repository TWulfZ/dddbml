import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { store, useAppStore } from '../state/store';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { IconMenu, IconSettings, IconExport, IconImage, IconGit, IconChevronRight } from '../icons';
import { clampMenuAnchor } from './contextMenu';

/**
 * Top-left application menu (Excalidraw-style). Closed by default; a single icon
 * trigger opens a click popover anchored beneath it with app/document actions —
 * Settings, Export, and a disabled Git placeholder (the future VCS panel; spec 15).
 *
 * Distinct from `ui/HoverCard` (hover/focus, non-interactive). This is click-opened
 * and interactive, so it follows the `render/contextMenu.tsx` idiom instead: deferred
 * outside-click + Escape dismiss, `createPortal` to <body> so it escapes any overflow,
 * positioned from the trigger's bounding rect and clamped to the viewport. The rows
 * just re-trigger the existing Settings/Export modals — no duplicated logic.
 */

const MENU_WIDTH = 200;
const MENU_HEIGHT_EST = 176;
const ANCHOR_GAP = 4;

export function AppMenu() {
  const open = useAppStore((s) => s.appMenuOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  // Anchor the popover under the trigger surface whenever it opens.
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(clampMenuAnchor(r.left, r.bottom + ANCHOR_GAP, MENU_WIDTH, MENU_HEIGHT_EST));
  }, [open]);

  // Dismiss on outside click / Escape. Defer attachment one tick (mirrors ContextMenu)
  // so the opening click doesn't immediately close it; return focus to the trigger on Esc.
  useEffect(() => {
    if (!open) return;
    const close = () => store.getState().setAppMenuOpen(false);
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (wrapRef.current?.contains(t)) return;
      close();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      wrapRef.current?.querySelector('button')?.focus();
    };
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocDown);
      document.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // Close the menu, then run the row's action (opens the relevant modal).
  const pick = (fn: () => void) => () => {
    store.getState().setAppMenuOpen(false);
    fn();
  };

  return (
    <div class="ddd-app-menu" ref={wrapRef}>
      <Tooltip label="Menu">
        <Button
          variant="toolbar"
          size="tool"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => store.getState().setAppMenuOpen(!open)}
        >
          <IconMenu size={16} />
        </Button>
      </Tooltip>
      {open && pos
        ? createPortal(
            <div
              ref={popoverRef}
              class="ddd-app-menu__popover"
              role="menu"
              aria-label="Application menu"
              style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                class="ddd-app-menu__item"
                role="menuitem"
                onClick={pick(() => store.getState().setSettingsPanelOpen(true))}
              >
                <IconSettings size={14} />
                <span class="ddd-app-menu__label">Settings</span>
              </button>
              <button
                class="ddd-app-menu__item"
                role="menuitem"
                onClick={pick(() => store.getState().setExportPromptOpen(true))}
              >
                <IconExport size={14} />
                <span class="ddd-app-menu__label">Export…</span>
              </button>
              <button
                class="ddd-app-menu__item"
                role="menuitem"
                onClick={pick(() => store.getState().setExportImagePromptOpen(true))}
              >
                <IconImage size={14} />
                <span class="ddd-app-menu__label">Export image…</span>
              </button>
              <hr class="ddd-app-menu__separator" />
              <button
                class="ddd-app-menu__item"
                role="menuitem"
                onClick={pick(() => store.getState().setGitPanelOpen(true))}
              >
                <IconGit size={14} />
                <span class="ddd-app-menu__label">Git</span>
                <span class="ddd-app-menu__chevron">
                  <IconChevronRight size={12} />
                </span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
