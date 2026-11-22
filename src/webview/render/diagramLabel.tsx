import { useRef, useState } from 'preact/hooks';
import type { LabelFields, LabelLayout } from '../../shared/diagramLabels';
import {
  DEFAULT_LABEL_FONT, DEFAULT_LABEL_SIZE, MAX_LABEL_SIZE, MIN_LABEL_SIZE, isLabelFont,
} from '../../shared/diagramLabels';
import { gridSnapper } from '../layout/grid';
import type { PlacedLabel } from '../layout/diagramLabels';
import { CANVAS_TITLE_PALETTE, renderProjectTitleBlock } from '../layout/projectTitleBlock';
import { schedulePersist } from '../persistence';
import { isCanvasReadOnly, store } from '../state/store';
import { Button } from '../ui/Button';
import { Field, NumberField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { postToHost } from '../vscode';

type Point = { x: number; y: number };

export function LabelNode({ label, onEdit }: { label: PlacedLabel; onEdit: () => void }) {
  const [offset, setOffset] = useState<Point | null>(null);
  const drag = useRef<{ id: number; start: Point; zoom: number } | null>(null);
  const canEdit = () => !isCanvasReadOnly(store.getState());
  const delta = (e: PointerEvent) => {
    const active = drag.current!;
    return { x: (e.clientX - active.start.x) / active.zoom, y: (e.clientY - active.start.y) / active.zoom };
  };

  return (
    <button
      type="button"
      class={label.titleBlock ? 'ddd-diagram-label ddd-project-title-block' : 'ddd-diagram-label'}
      title={label.text}
      aria-label={`Diagram label: ${label.text}`}
      style={{
        left: label.x + (offset?.x ?? 0),
        top: label.y + (offset?.y ?? 0),
        width: label.w,
        height: label.h,
        fontFamily: label.font,
        fontSize: label.fontSize,
        lineHeight: `${label.lineHeight}px`,
        background: label.color,
        color: label.color ? '#111' : undefined,
      }}
      onPointerDown={(e) => {
        const state = store.getState();
        if (e.button !== 0 || state.panMode || state.spacePan || !canEdit()) return;
        e.stopPropagation();
        drag.current = { id: e.pointerId, start: { x: e.clientX, y: e.clientY }, zoom: state.viewport.zoom };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current?.id === e.pointerId) setOffset(delta(e));
      }}
      onPointerUp={(e) => {
        if (drag.current?.id !== e.pointerId) return;
        const move = delta(e);
        drag.current = null;
        setOffset(null);
        if (!canEdit() || Math.hypot(move.x, move.y) < 3) return;
        const snap = gridSnapper();
        const x = Math.round(snap(label.x + move.x));
        const y = Math.round(snap(label.y + move.y));
        if (x !== label.x || y !== label.y) {
          store.getState().setLabelLayout(label.layoutKey, { x, y });
          schedulePersist();
        }
      }}
      onLostPointerCapture={() => { drag.current = null; setOffset(null); }}
      onDblClick={(e) => { e.stopPropagation(); if (canEdit()) onEdit(); }}
      onClick={(e) => { if (e.detail === 0 && canEdit()) onEdit(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (canEdit()) onEdit(); }}
    >{label.titleBlock ? (
      <svg width={label.w} height={label.h} viewBox={`0 0 ${label.w} ${label.h}`} focusable="false" aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: renderProjectTitleBlock(label.titleBlock, CANVAS_TITLE_PALETTE) }} />
    ) : label.lines.map((line, i) => <span key={i}>{line}</span>)}</button>
  );
}

export type LabelDraft = { position: Point; label?: PlacedLabel };

export function LabelModal({ draft, onClose }: { draft: LabelDraft; onClose: () => void }) {
  const original = draft.label;
  const isProjectCaption = original?.layoutKey.startsWith('project:') ?? false;
  const name = isProjectCaption ? undefined : original?.name;
  const [fields, setFields] = useState<LabelFields>(() => ({
    text: draft.label?.text ?? '',
    font: draft.label?.font ?? DEFAULT_LABEL_FONT,
    fontSize: draft.label?.fontSize ?? DEFAULT_LABEL_SIZE,
    ...draft.position,
  }));
  const update = (patch: Partial<LabelFields>) => setFields((current) => ({ ...current, ...patch }));
  const commit = () => {
    if (isCanvasReadOnly(store.getState()) || (!isProjectCaption && !fields.text.trim()) || !isLabelFont(fields.font.trim())) return;
    const next = { ...fields, font: fields.font.trim() };
    if (original) {
      const layout: LabelLayout = {};
      if (next.x !== original.x) layout.x = next.x;
      if (next.y !== original.y) layout.y = next.y;
      if (next.font !== original.font) layout.font = next.font;
      if (next.fontSize !== original.fontSize) layout.fontSize = next.fontSize;
      if (Object.keys(layout).length) {
        store.getState().setLabelLayout(original.layoutKey, layout);
        schedulePersist();
      }
      if (name && next.text !== original.text) {
        postToHost({ type: 'schema:editLabel', payload: { kind: 'update', name, changes: { text: next.text } } });
      }
    } else {
      postToHost({ type: 'schema:editLabel', payload: { kind: 'add', label: next } });
    }
    onClose();
  };
  const remove = () => {
    if (!name || isCanvasReadOnly(store.getState())) return;
    postToHost({ type: 'schema:editLabel', payload: { kind: 'delete', name } });
    onClose();
  };

  return (
    <Modal open title={original?.titleBlock ? 'Project title block layout' : isProjectCaption ? 'Project caption layout' : name ? 'Edit diagram label' : 'Add diagram label'} onClose={onClose}
      footer={<>
        {name ? <Button variant="secondary" onClick={remove}>Delete</Button> : null}
        <Button variant="primary" disabled={(!isProjectCaption && !fields.text.trim()) || !isLabelFont(fields.font.trim())} onClick={commit}>
          {original ? 'Save changes' : 'Add label'}
        </Button>
      </>}>
      {!isProjectCaption ? <Field label="Text">
        <textarea class="ddd-field__control" rows={3} value={fields.text}
          onInput={(e) => update({ text: e.currentTarget.value })} />
      </Field> : null}
      <Field label="Font family" hint="Use an installed font or a fallback list, such as Georgia, serif.">
        <input class="ddd-field__control" type="text" value={fields.font}
          onInput={(e) => update({ font: e.currentTarget.value })} />
      </Field>
      <NumberField label={original?.titleBlock ? 'Project name font size (px)' : 'Font size (px)'} value={fields.fontSize} min={MIN_LABEL_SIZE} max={MAX_LABEL_SIZE}
        onCommit={(fontSize) => update({ fontSize })} />
      <div class="ddd-label-coordinates">
        <NumberField label="X" value={fields.x} onCommit={(x) => update({ x })} />
        <NumberField label="Y" value={fields.y} onCommit={(y) => update({ y })} />
      </div>
    </Modal>
  );
}
