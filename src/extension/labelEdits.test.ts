import { describe, expect, it } from 'vitest';
import { DEFAULT_LABEL_FONT, DEFAULT_LABEL_SIZE, type LabelEdit } from '../shared/diagramLabels';
import { parseDbml } from './parser';
import { computeSchemaEdit } from './schemaEdits';
import { applyEdits } from './textEdits';

function change(source: string, edit: LabelEdit): string {
  const result = computeSchemaEdit(source, { kind: 'label', edit });
  if (!result.ok) throw new Error(result.reason);
  const edited = applyEdits(source, result.edits);
  expect(applyEdits(edited, result.inverse)).toBe(source);
  return edited;
}

describe('diagram labels in DBML', () => {
  it('adds a floating label with escaped multiline text and keeps layout out of the DBML', () => {
    const before = 'Table example {\r\n  id int [pk]\r\n}\r\n';
    const label = { text: "O'Neill's diagram\nPath \\ example", font: 'Georgia, serif', fontSize: 32, x: -48, y: 20 };
    const edited = change(before, { kind: 'add', label });
    expect(edited.startsWith(before)).toBe(true);
    expect(edited).toContain('color: none');
    expect(edited).not.toContain('font_size');
    expect(edited).not.toMatch(/\b[xy]:/);
    expect(parseDbml(edited).schema?.labels).toEqual([{
      name: 'diagram_label_1', text: label.text, font: DEFAULT_LABEL_FONT, fontSize: DEFAULT_LABEL_SIZE,
    }]);
  });

  it('updates an existing note without replacing unrelated settings or comments', () => {
    const before = `// Keep this\nNote title [author: "docs", color: #abc, font: 'Arial'] {\n  // Keep this too\n  'Old'\n}\n`;
    const edited = change(before, {
      kind: 'update', name: 'title', changes: { text: 'Schema name' },
    });
    expect(edited).toContain('author: "docs", color: #abc');
    expect(edited).toContain('// Keep this too');
    expect(parseDbml(edited).schema?.labels?.[0]).toMatchObject({
      name: 'title', text: 'Schema name', font: 'Arial', color: '#abc',
    });
    expect(change(edited, { kind: 'delete', name: 'title' })).toBe('// Keep this\n');
  });

  it('leaves legacy layout metadata intact when changing note text', () => {
    const before = "Note title [x: 10, y: 30] { 'Original text' }\n";
    const edited = change(before, { kind: 'update', name: 'title', changes: { text: 'New text' } });
    expect(edited).toBe("Note title [x: 10, y: 30] { 'New text' }\n");
  });
});
