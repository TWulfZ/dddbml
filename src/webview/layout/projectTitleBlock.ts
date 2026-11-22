import type { ProjectInfo } from '../../shared/types';
import type { MeasureText } from './printTable';

const COLUMN_WIDTH = 244;
const WIDTH = COLUMN_WIDTH * 3;
const PAD = 12;
const IMAGE_WIDTH = 142;

interface BlockText {
  x: number;
  y: number;
  text: string;
  size: number;
  label?: boolean;
  bold?: boolean;
}
interface BlockCell {
  x: number;
  y: number;
  w: number;
  h: number;
  header?: boolean;
  text: BlockText[];
  image?: string;
}

export interface ProjectTitleBlock {
  w: number;
  h: number;
  font: string;
  cells: BlockCell[];
}

function wrap(value: string, width: number, size: number, font: string, measure: MeasureText, weight = 400): string[] {
  const fits = (line: string) => measure(line, size, font, weight) <= width;
  const lines: string[] = [];
  for (const paragraph of value.split(/\r\n?|\n/)) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      if (fits(word)) {
        line = word;
        continue;
      }
      for (const char of word) {
        if (line && !fits(line + char)) {
          lines.push(line);
          line = '';
        }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function makeProjectTitleBlock(
  project: ProjectInfo, font: string, titleSize: number, includeNote: boolean, measure: MeasureText,
): ProjectTitleBlock {
  const cells: BlockCell[] = [];
  const images = project.images ?? [];
  const titleWidth = WIDTH - IMAGE_WIDTH * images.length;
  const cellText = (key: string, value: string, width: number, valueSize: number, bold = false) => {
    const labels = wrap(key, width - PAD * 2, 11, font, measure);
    const values = wrap(value, width - PAD * 2, valueSize, font, measure, bold ? 700 : 400);
    const text: BlockText[] = [];
    let y = PAD;
    for (const line of labels) {
      text.push({ x: PAD, y: y + 11 / 2, text: line, size: 11, label: true });
      y += 15;
    }
    const lineHeight = Math.ceil(valueSize * 1.25);
    for (const line of values) {
      text.push({ x: PAD, y: y + lineHeight / 2, text: line, size: valueSize, bold });
      y += lineHeight;
    }
    return { h: y + PAD, text };
  };

  const title = cellText('Project', project.name, titleWidth, titleSize, true);
  const media = images.map((image) => ({
    ...image,
    fallback: image.dataUri ? undefined : cellText(image.key === 'logo' ? 'Logo unavailable' : 'Image unavailable', image.filename, IMAGE_WIDTH, 12),
  }));
  let y = Math.max(title.h, ...media.map((image) => image.fallback?.h ?? 86));
  cells.push({ x: 0, y: 0, w: titleWidth, h: y, header: true, text: title.text });
  media.forEach((image, i) => cells.push({
    x: titleWidth + IMAGE_WIDTH * i, y: 0, w: IMAGE_WIDTH, h: y, text: image.fallback?.text ?? [], image: image.dataUri,
  }));

  const fields = project.fields ?? (project.databaseType ? [{ key: 'database_type', value: project.databaseType }] : []);
  for (let i = 0; i < fields.length; i += 3) {
    const row = fields.slice(i, i + 3).map(({ key, value }) => {
      const label = key.replace(/_/g, ' ');
      return cellText(label.charAt(0).toUpperCase() + label.slice(1), value, COLUMN_WIDTH, 14);
    });
    const h = Math.max(...row.map((cell) => cell.h));
    row.forEach((cell, col) => cells.push({ ...cell, x: col * COLUMN_WIDTH, y, w: COLUMN_WIDTH, h }));
    if (row.length < 3) cells.push({ x: row.length * COLUMN_WIDTH, y, w: (3 - row.length) * COLUMN_WIDTH, h, text: [] });
    y += h;
  }
  if (includeNote && project.note) {
    const note = cellText('Note', project.note, WIDTH, 14);
    cells.push({ ...note, x: 0, y, w: WIDTH });
    y += note.h;
  }
  return { w: WIDTH, h: y, font, cells };
}

export const CANVAS_TITLE_PALETTE = {
  surface: 'var(--ddd-surface-raised)',
  headerBg: 'var(--ddd-print-header, var(--ddd-surface-raised))',
  border: 'var(--ddd-border)',
  fg: 'var(--ddd-fg)',
  fgMuted: 'var(--ddd-fg-muted)',
};

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderProjectTitleBlock(block: ProjectTitleBlock, palette: typeof CANVAS_TITLE_PALETTE): string {
  const out: string[] = [];
  out.push(`<g font-family="${escapeXml(block.font)}">`);
  for (const cell of block.cells) {
    const { x, y, w, h, header, image } = cell;
    out.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" fill="${header ? palette.headerBg : palette.surface}"/>`);
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${palette.border}"/>`);
    if (image && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(image)) {
      out.push(`<image x="${x + PAD}" y="${y + PAD}" width="${w - PAD * 2}" height="${h - PAD * 2}" href="${image}" preserveAspectRatio="xMidYMid meet"/>`);
    }
    for (const t of cell.text) {
      out.push(`<text x="${x + t.x}" y="${y + t.y}" font-size="${t.size}" font-weight="${t.bold ? 700 : 400}" dominant-baseline="central" fill="${t.label ? palette.fgMuted : palette.fg}">${escapeXml(t.text)}</text>`);
    }
  }
  out.push('</g>');
  return out.join('');
}
