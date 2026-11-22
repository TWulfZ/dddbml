import { isLabelCoordinate, isLabelFont, isLabelSize, noteLayoutKey, type LabelEdit } from '../shared/diagramLabels';
import type { Model } from './dbmlModel';
import { deletionRange, eolOf, isPunct, lex } from './dbmlScan';
import type { OffsetEdit } from './textEdits';

interface LabelPlan {
  label: string;
  edits: OffsetEdit[];
  cascade: string[];
  labelName?: string;
  verify: (model: Model) => string | null;
}

function quote(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r\n?|\n/g, '\\n') + "'";
}

export function planLabelEdit(src: string, model: Model, edit: LabelEdit, reservedKeys: string[] = []): LabelPlan | string {
  let name: string;
  if (edit.kind === 'add') {
    const occupied = new Set(model.notes.map((note) => note.name));
    const reserved = new Set(reservedKeys);
    let suffix = 1;
    while (occupied.has(`diagram_label_${suffix}`) || reserved.has(noteLayoutKey(`diagram_label_${suffix}`))) suffix++;
    name = `diagram_label_${suffix}`;
  } else {
    name = edit.name;
  }
  const note = model.notes.find((n) => n.name === name);
  if (edit.kind !== 'add' && !note) return 'the label is no longer in the .dbml';
  if (edit.kind === 'delete') {
    const { start, end } = note!.token;
    return {
      label: `Delete label ${name}`,
      edits: [{ ...deletionRange(src, start.offset, end.offset), newText: '' }],
      cascade: [],
      verify: (after) => after.notes.some((n) => n.name === name) ? 'the label would remain in the .dbml' : null,
    };
  }

  const text = edit.kind === 'add' ? edit.label.text : edit.changes.text;
  if (typeof text !== 'string' || !text.trim()) return 'enter label text';
  const verify = (after: Model) => after.notes.find((n) => n.name === name)?.content === text.replace(/\r\n?/g, '\n')
    ? null : 'the label would not read back as entered';

  if (edit.kind === 'add') {
    const { font, fontSize, x, y } = edit.label;
    if (!isLabelFont(font) || !isLabelSize(fontSize) || !isLabelCoordinate(x) || !isLabelCoordinate(y)) return 'invalid label layout';
    const eol = eolOf(src);
    const prefix = src.length === 0 || src.endsWith(eol + eol) ? '' : src.endsWith(eol) ? eol : eol + eol;
    const newText = `${prefix}Note ${name} [color: none] {${eol}  ${quote(text)}${eol}}${eol}`;
    return { label: 'Add diagram label', labelName: name, edits: [{ start: src.length, end: src.length, newText }], cascade: [], verify };
  }

  const { start, end } = note!.token;
  const tokens = lex(src, start.offset, end.offset).filter((token) => token.kind !== 'comment');
  const brace = tokens.findIndex((token) => isPunct(src, token, '{'));
  const content = tokens[brace + 1];
  if (brace < 0 || content?.kind !== 'string') return 'could not locate the label text';
  const edits = text === note!.content ? [] : [{ start: content.start, end: content.end, newText: quote(text) }];
  return { label: 'Edit diagram label', edits, cascade: [], verify };
}
