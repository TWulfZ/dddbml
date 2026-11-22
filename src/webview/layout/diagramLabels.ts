import type { Schema } from '../../shared/types';
import {
  DEFAULT_LABEL_FONT, noteLayoutKey, PROJECT_BLOCK_KEY, PROJECT_NOTE_KEY, PROJECT_TITLE_KEY, type DiagramLabel, type LabelLayout,
} from '../../shared/diagramLabels';
import { makeProjectTitleBlock, type ProjectTitleBlock } from './projectTitleBlock';
import { measurePrintText, type MeasureText } from './printTable';

export interface PlacedLabel extends DiagramLabel {
  layoutKey: string;
  authoredPosition?: { x?: number; y?: number };
  x: number;
  y: number;
  w: number;
  h: number;
  lineHeight: number;
  lines: string[];
  titleBlock?: ProjectTitleBlock;
}

export const LABEL_PADDING = 8;

function measureLabel(label: DiagramLabel, layoutKey: string, measure: MeasureText) {
  const lines = label.text.replace(/\r\n?/g, '\n').split('\n');
  const lineHeight = Math.ceil(label.fontSize * 1.25);
  const w = Math.ceil(lines.reduce((width, line) => Math.max(width, measure(line, label.fontSize, label.font)), 0)) + 2 * LABEL_PADDING;
  const h = lineHeight * lines.length + 2 * LABEL_PADDING;
  return { ...label, layoutKey, w, h, lineHeight, lines };
}

export function diagramAnnotations(
  schema: Pick<Schema, 'labels' | 'project' | 'architecture'>,
  layouts: Readonly<Record<string, LabelLayout>> = {},
  showTitle = false, showNote = false, measure: MeasureText = measurePrintText,
): { notes: PlacedLabel[]; captions: PlacedLabel[] } {
  let y = -32;
  const place = (label: DiagramLabel, key: string): PlacedLabel => {
    const measured = measureLabel({ ...label, ...layouts[key] }, key, measure);
    const top = measured.y ?? y - measured.h - LABEL_PADDING;
    y = Math.min(y, top);
    return { ...measured, x: measured.x ?? 0, y: top, authoredPosition: { x: measured.x, y: measured.y } };
  };
  const notes = (schema.labels ?? []).map((label) => place(label, noteLayoutKey(label.name)));
  const captions: PlacedLabel[] = [];
  const caption = (label: DiagramLabel, key: string): PlacedLabel => {
    const measured = measureLabel({ ...label, ...layouts[key] }, key, measure);
    y -= measured.h + LABEL_PADDING;
    return { ...measured, x: measured.x ?? 0, y: measured.y ?? y, authoredPosition: { x: measured.x, y: measured.y } };
  };
  const project = schema.project ?? (schema.architecture?.title ? { name: schema.architecture.title } : undefined);
  const blockLayout = layouts[PROJECT_BLOCK_KEY];
  if (project && blockLayout?.template === 'title-block') {
    if (!showTitle) return { notes, captions };
    const font = blockLayout.font ?? DEFAULT_LABEL_FONT;
    const fontSize = blockLayout.fontSize ?? project.fontSize ?? 32;
    const titleBlock = makeProjectTitleBlock(project, font, fontSize, showNote, measure);
    captions.push({
      layoutKey: PROJECT_BLOCK_KEY, name: project.name, text: project.name, font, fontSize,
      x: blockLayout.x ?? 0, y: blockLayout.y ?? y - titleBlock.h - LABEL_PADDING,
      w: titleBlock.w, h: titleBlock.h, lineHeight: 0, lines: [], titleBlock, authoredPosition: { x: blockLayout.x, y: blockLayout.y },
    });
    return { notes, captions };
  }
  if (project?.note && showNote) {
    captions.push(caption({ name: project.name, text: project.note, font: DEFAULT_LABEL_FONT, fontSize: 16 }, PROJECT_NOTE_KEY));
  }
  if (project && showTitle) {
    captions.push(caption({ name: project.name, text: project.name, font: DEFAULT_LABEL_FONT, fontSize: project.fontSize ?? 32 }, PROJECT_TITLE_KEY));
  }
  return { notes, captions: captions.reverse() };
}
