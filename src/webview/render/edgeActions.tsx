import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { commitEdgeStyle, flipLoopSide, readEdgeStyle, resetEdgeWaypoints } from '../drag/dragController';
import { IconReset, IconSettings, IconSwap, IconTrash } from '../icons';
import { isCanvasReadOnly, store, useAppStore } from '../state/store';
import type { EdgeStyle } from '../state/history';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { ColorPopup, popupAnchorFor } from './colorPopup';
import { clampMenuAnchor, ContextMenu } from './contextMenu';

export function useEdgeActions() {
  const [anchor, setAnchor] = useState<{ id: string; x: number; y: number; menu: boolean } | null>(null);
  const select = useCallback((id: string, x: number, y: number, menu = false) => {
    const state = store.getState();
    if (state.panMode || state.spacePan || isCanvasReadOnly(state)) return;
    state.setSelectedEdge(id);
    setAnchor({ id, x, y, menu });
  }, []);
  const closeMenu = useCallback(() => setAnchor((value) => value && { ...value, menu: false }), []);
  const contextMenu = useCallback((event: MouseEvent) => {
    const id = (event.target as Element).closest('[data-edge]')?.getAttribute('data-edge');
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    select(id, event.clientX, event.clientY, true);
  }, [select]);
  return { anchor, closeMenu, contextMenu, select };
}

export function EdgeActions({ id, anchor, closeMenu, color, canFlip, deletion }: {
  id: string | undefined;
  anchor: ReturnType<typeof useEdgeActions>['anchor'];
  closeMenu: () => void;
  color: (id: string) => string | undefined;
  canFlip?: boolean;
  deletion?: { run: () => void; disabled: boolean };
}) {
  const readOnly = useAppStore(isCanvasReadOnly);
  const [popup, setPopup] = useState<{ id: string; x: number; y: number; before: EdgeStyle } | null>(null);
  useEffect(() => { if (readOnly) setPopup(null); }, [readOnly]);
  if (readOnly) return null;

  const openColor = (edge: string, position: { x: number; y: number }) =>
    setPopup({ id: edge, ...position, before: readEdgeStyle(edge) });

  return <>
    {id && anchor?.id === id && createPortal(
      <div class="ddd-edge-toolbar" style={{ left: anchor.x + 10, top: anchor.y - 40 }} onPointerDown={(e) => e.stopPropagation()}>
        <Tooltip label="Reset line">
          <Button variant="toolbar" size="tool" aria-label="Reset line" onClick={() => resetEdgeWaypoints(id)}><IconReset size={13} /></Button>
        </Tooltip>
        {canFlip && <Tooltip label="Flip side">
          <Button variant="toolbar" size="tool" aria-label="Flip side" onClick={() => flipLoopSide(id)}><IconSwap size={13} /></Button>
        </Tooltip>}
        <Tooltip label="Edge color">
          <Button variant="toolbar" size="tool" aria-label="Edge color" onClick={(e) => openColor(id, popupAnchorFor(e.currentTarget.getBoundingClientRect()))}>
            <IconSettings size={13} />
          </Button>
        </Tooltip>
        {deletion && <Tooltip label="Delete relation">
          <Button variant="toolbar" size="tool" aria-label="Delete relation" disabled={deletion.disabled} onClick={deletion.run}><IconTrash size={13} /></Button>
        </Tooltip>}
      </div>, document.body)}
    {id && anchor?.id === id && anchor.menu && <ContextMenu {...clampMenuAnchor(anchor.x, anchor.y, 200, 100)}
      items={[
        { label: 'Reset line', onClick: () => resetEdgeWaypoints(id) },
        { label: 'Edge color', onClick: () => openColor(id, clampMenuAnchor(anchor.x, anchor.y, 240, 240)) },
        ...(canFlip ? [{ label: 'Flip side', onClick: () => flipLoopSide(id) }] : []),
        ...(deletion ? [{ label: 'Delete relation', danger: true, disabled: deletion.disabled, onClick: deletion.run }] : []),
      ]} onClose={closeMenu} />}
    {popup && <ColorPopup current={color(popup.id) ?? '#888888'} x={popup.x} y={popup.y}
      onPick={(value) => store.getState().setEdgeColor(popup.id, value)}
      onReset={() => store.getState().setEdgeColor(popup.id, null)}
      onClose={() => {
        commitEdgeStyle(popup.id, popup.before, 'Edge color');
        setPopup(null);
      }} />}
  </>;
}
