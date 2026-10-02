import { memo } from 'preact/compat';
import { store, useAppStore } from '../state/store';
import { commitRefDraft } from '../drag/fkDrag';
import { ContextMenu, clampMenuAnchor, type ContextMenuItem } from './contextMenu';
import type { ColumnRef, RefOp } from '../../shared/types';

const CARDINALITIES: Array<[RefOp, string]> = [
  ['>', 'Many-to-one (>)'],
  ['<', 'One-to-many (<)'],
  ['-', 'One-to-one (-)'],
  ['<>', 'Many-to-many (<>)'],
];

const columnLabel = (c: ColumnRef) => `${c.table.startsWith('public.') ? c.table.slice('public.'.length) : c.table}.${c.column}`;

/** Cardinality pick after an FK drop (spec 19 §Crear FK); Escape or an outside click cancels. */
function FkPromptImpl() {
  const draft = useAppStore((s) => s.refDraft);
  if (!draft) return null;
  const items: ContextMenuItem[] = [
    { label: `${columnLabel(draft.from)} → ${columnLabel(draft.to)}`, disabled: true, onClick: () => {} },
    { label: '', separator: true, onClick: () => {} },
    ...CARDINALITIES.map(([op, label]): ContextMenuItem => ({ label, onClick: () => commitRefDraft(op) })),
  ];
  const { x, y } = clampMenuAnchor(draft.x, draft.y, 220, 170);
  return <ContextMenu x={x} y={y} items={items} onClose={() => store.getState().setRefDraft(null)} />;
}

export const FkPrompt = memo(FkPromptImpl);
