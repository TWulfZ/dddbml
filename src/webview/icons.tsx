/**
 * Codicon-backed icon set. Renders VS Code's codicon font glyphs via CSS classes,
 * so icons match the host UI exactly. The font + stylesheet are loaded by the panel
 * (see panel.ts `renderHtml`); here we only emit `<i class="codicon codicon-NAME">`.
 *
 * Use the generic `<Icon name="..." />` for new code; the named `Icon*` exports are
 * thin aliases kept so existing call-sites need no change.
 */

export type IconName =
  | 'key'
  | 'note'
  | 'eye'
  | 'eye-closed'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'add'
  | 'remove'
  | 'screen-full'
  | 'collapse-all'
  | 'expand-all'
  | 'group-by-ref-type'
  | 'go-to-file'
  | 'gear'
  | 'close'
  | 'search'
  | 'filter'
  | 'redo'
  | 'discard'
  | 'magnet'
  | 'wand';

interface IconProps {
  size?: number;
  title?: string;
  /** Mirror horizontally — used to derive an "undo" glyph from "redo". */
  flipX?: boolean;
}

export function Icon({ name, size = 14, title, flipX }: IconProps & { name: IconName }) {
  return (
    <i
      class={`codicon codicon-${name} ddd-icon`}
      style={{
        fontSize: `${size}px`,
        ...(flipX ? { transform: 'scaleX(-1)' } : null),
      }}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      title={title}
    />
  );
}

const make = (name: IconName, flipX?: boolean) => (p?: IconProps) =>
  <Icon name={name} flipX={flipX} {...p} />;

export const IconKey = make('key');
export const IconNote = make('note');
export const IconEye = make('eye');
export const IconEyeClosed = make('eye-closed');
export const IconChevronRight = make('chevron-right');
export const IconChevronDown = make('chevron-down');
export const IconChevronUp = make('chevron-up');
export const IconPlus = make('add');
export const IconMinus = make('remove');
export const IconFitScreen = make('screen-full');
export const IconCollapseAll = make('collapse-all');
export const IconExpandAll = make('expand-all');
export const IconGroup = make('group-by-ref-type');
export const IconGoToFile = make('go-to-file');
export const IconSettings = make('gear');
export const IconClose = make('close');
export const IconSearch = make('search');
export const IconFilter = make('filter');
// codicon ships no `undo` glyph — mirror `redo` for a symmetric pair.
export const IconUndo = make('redo', true);
export const IconRedo = make('redo');
export const IconReset = make('discard');
export const IconMagnet = make('magnet');
export const IconAutoArrange = make('wand');
