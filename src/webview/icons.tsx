/**
 * Minimal SVG icon set, hand-tuned to match VSCode codicon style (16x16 grid).
 * Paths are stroked via `currentColor` so they inherit the surrounding CSS color.
 */

interface IconProps {
  size?: number;
  title?: string;
}

function wrap(d: string, { size = 14, title }: IconProps = {}) {
  return (
    <svg
      class="ddd-icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} fill="currentColor" />
    </svg>
  );
}

export const IconKey = (p?: IconProps) => wrap(
  'M10.5 2a3.5 3.5 0 0 0-3.37 4.48L2 11.61V14h2v-1h1v-1h1v-1h1v-1.12l1.02-1.02A3.5 3.5 0 1 0 10.5 2zm0 1a2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 1-.8-.13L8.5 9.06V10H7.5v1H6.5v1H5.5v1H3v-.97l5.26-5.26A2.5 2.5 0 0 1 10.5 3zM11 4.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z',
  p,
);

export const IconNote = (p?: IconProps) => wrap(
  'M3 2h8l3 3v9H3V2zm1 1v10h9V6h-3V3H4zm6 0v2h2l-2-2z',
  p,
);

export const IconEye = (p?: IconProps) => wrap(
  'M8 3.5c-3 0-5.5 2-7 4.5 1.5 2.5 4 4.5 7 4.5s5.5-2 7-4.5c-1.5-2.5-4-4.5-7-4.5zm0 1c2.4 0 4.5 1.5 5.9 3.5C12.5 10 10.4 11.5 8 11.5S3.5 10 2.1 8C3.5 6 5.6 4.5 8 4.5zm0 1.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  p,
);

export const IconEyeClosed = (p?: IconProps) => wrap(
  'M2.22 2.22 3 1.45l11.56 11.56-.78.78L11.3 11.3A8.3 8.3 0 0 1 8 12c-3 0-5.5-2-7-4.5A12 12 0 0 1 3.3 4.08L2.22 2.22zM4.06 4.84C3 5.6 2.07 6.7 1.41 8c1.4 2 3.5 3.5 5.9 3.5.9 0 1.73-.21 2.46-.56L8.18 9.25a2 2 0 0 1-2.43-2.43L4.06 4.84zM8 4.5c-.44 0-.87.06-1.28.16l.9.9A2 2 0 0 1 10.44 8.4l.9.9A7.5 7.5 0 0 0 15 8c-1.5-2.5-4-4.5-7-4.5z',
  p,
);

export const IconChevronRight = (p?: IconProps) => wrap(
  'M6 3l5 5-5 5-.7-.7L9.58 8 5.3 3.7 6 3z',
  p,
);

export const IconChevronDown = (p?: IconProps) => wrap(
  'M3 6l5 5 5-5-.7-.7L8 9.58 3.7 5.3 3 6z',
  p,
);

export const IconPlus = (p?: IconProps) => wrap(
  'M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5V2z',
  p,
);

export const IconMinus = (p?: IconProps) => wrap(
  'M2 7.5h12v1H2v-1z',
  p,
);

export const IconFitScreen = (p?: IconProps) => wrap(
  'M2 2h5v1H3v4H2V2zm9 0h5v5h-1V3h-4V2zM2 14v-5h1v4h4v1H2zm9 0v-1h4V9h1v5h-5z',
  p,
);

export const IconCollapseAll = (p?: IconProps) => wrap(
  'M2 5h12v1H2V5zm0 3h12v1H2V8zm0 3h12v1H2v-1z',
  p,
);

export const IconExpandAll = (p?: IconProps) => wrap(
  'M2 3h12v1H2V3zm2 3h8v1H4V6zm-2 3h12v1H2V9zm2 3h8v1H4v-1z',
  p,
);

export const IconGroup = (p?: IconProps) => wrap(
  'M2 2h5v5H2V2zm1 1v3h3V3H3zm6-1h5v5H9V2zm1 1v3h3V3h-3zM2 9h5v5H2V9zm1 1v3h3v-3H3zm6-1h5v5H9V9zm1 1v3h3v-3h-3z',
  p,
);

export const IconGoToFile = (p?: IconProps) => wrap(
  'M4 2v12h3v-1H5V3h5v3h3v2h1V5l-3-3H4zm7 1.5L12.5 5H11V3.5zM9 10l-1 1 2 2-2 2 1 1 3-3-3-3z',
  p,
);

export const IconSettings = (p?: IconProps) => wrap(
  'M9.1 1h-2.2l-.4 2.2-1.1.47-1.86-1.3-1.57 1.56 1.3 1.87-.46 1.1L0.5 7.2v2.2l2.21.4.46 1.1-1.3 1.87 1.57 1.57 1.86-1.3 1.1.46.4 2.2h2.22l.4-2.2 1.1-.46 1.87 1.3 1.56-1.57-1.3-1.86.47-1.1 2.2-.4V7.2l-2.2-.4-.47-1.1 1.3-1.87-1.57-1.57-1.86 1.3-1.1-.46L9.1 1zM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
  p,
);

export const IconClose = (p?: IconProps) => wrap(
  'M8 7.29 3.35 2.65l-.7.7L7.29 8l-4.64 4.65.7.7L8 8.71l4.65 4.64.7-.7L8.71 8l4.64-4.65-.7-.7L8 7.29z',
  p,
);

export const IconSearch = (p?: IconProps) => wrap(
  'M11.5 6.5a5 5 0 1 1-10 0 5 5 0 0 1 10 0zm-1.42 3.94a5 5 0 1 1 .7-.7l3.54 3.54-.71.7-3.53-3.54z',
  p,
);

export const IconChevronUp = (p?: IconProps) => wrap(
  'M13 10l-5-5-5 5 .7.7L8 6.42l4.3 4.28L13 10z',
  p,
);

export const IconFilter = (p?: IconProps) => wrap(
  'M2 3h12v1.5L9.5 9v4L6.5 11V9L2 4.5V3zm1.2 1 4.3 4.3v2.3l1 .7V8.3L12.8 4H3.2z',
  p,
);
