export interface LabelFields {
  text: string;
  font: string;
  fontSize: number;
  x: number;
  y: number;
}

export interface DiagramLabel extends Omit<LabelFields, 'x' | 'y'> {
  name: string;
  x?: number;
  y?: number;
  color?: string;
}

export type ProjectTemplate = 'captions' | 'title-block';
export type LabelLayout = Partial<Omit<LabelFields, 'text'>> & { template?: ProjectTemplate };

export const PROJECT_TITLE_KEY = 'project:title';
export const PROJECT_NOTE_KEY = 'project:note';
export const PROJECT_BLOCK_KEY = 'project:title-block';

export function noteLayoutKey(name: string): string {
  return `note:${name}`;
}

export function isLabelLayoutKey(key: string): boolean {
  return key.startsWith('note:') || key === PROJECT_TITLE_KEY || key === PROJECT_NOTE_KEY || key === PROJECT_BLOCK_KEY;
}

export type LabelEdit =
  | { kind: 'add'; label: LabelFields }
  | { kind: 'update'; name: string; changes: Pick<LabelFields, 'text'> }
  | { kind: 'delete'; name: string };

export const DEFAULT_LABEL_FONT = 'Arial, sans-serif';
export const DEFAULT_LABEL_SIZE = 24;
export const MIN_LABEL_SIZE = 8;
export const MAX_LABEL_SIZE = 144;

/** Accept installed font family names and CSS generic fallbacks. */
export function isLabelFont(font: unknown): font is string {
  return typeof font === 'string' && font.length <= 120
    && /^[\p{L}\p{N}_-]+(?: +[\p{L}\p{N}_-]+)*(?: *, *[\p{L}\p{N}_-]+(?: +[\p{L}\p{N}_-]+)*)*$/u.test(font);
}

export function isLabelSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isFinite(size)
    && size >= MIN_LABEL_SIZE && size <= MAX_LABEL_SIZE;
}

export function isLabelCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
