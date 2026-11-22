import type { ArchitectureScene, Point } from '../layout/architectureLayout';
import { nodeSubtitle } from '../layout/architectureLayout';

interface Palette {
  surface: string;
  headerBg: string;
  border: string;
  fg: string;
  fgMuted: string;
  edge: string;
  accent: string;
}

export const architectureCanvasPalette: Palette = {
  surface: 'var(--ddd-surface-raised)',
  headerBg: 'var(--ddd-print-header, var(--ddd-surface-hover))',
  border: 'var(--ddd-border)',
  fg: 'var(--ddd-fg)',
  fgMuted: 'var(--ddd-fg-muted)',
  edge: 'var(--ddd-edge)',
  accent: 'var(--ddd-accent)',
};

const glyphs: Record<string, string> = {
  Database: 'M5 7c0-4 14-4 14 0v10c0 4-14 4-14 0z M5 7c0 4 14 4 14 0 M5 12c0 4 14 4 14 0',
  Server: 'M4 4h16v6H4z M4 14h16v6H4z M7 7h1 M7 17h1',
  Container: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9',
  Internet: 'M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  Browser: 'M3 5h18v14H3z M3 9h18 M6 7h2',
  Queue: 'M4 7h4v10H4z M10 7h4v10h-4z M16 7h4v10h-4z',
  User: 'M15 8a3 3 0 1 1-6 0 3 3 0 1 1 6 0 M5 20v-2c0-5 14-5 14 0v2',
  Storage: 'M4 7h16v12H4z M4 7l3-4h10l3 4 M10 13h4',
  Service: 'M5 5h6v6H5z M13 13h6v6h-6z M11 8h5v5 M8 11v5h5',
};
const roleGlyph = (role: string) => glyphs[role] ?? glyphs.Service;

const xml = (value: string) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const isEmbeddedArchitectureImage = (value: string) =>
  /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+=*$/.test(value);

export function renderArchitecture(
  scene: ArchitectureScene, palette: Palette, printing: boolean, selection?: ReadonlySet<string>, resolveColor: (value: string) => string = (value) => value,
): string {
  const color = (custom: string | undefined, fallback: string) =>
    !printing && custom && /^(?:#[0-9a-f]{3}(?:[0-9a-f]{3})?|var\(--ddd-bc-(?:[1-9]|1[0-2])-border\))$/i.test(custom)
      ? xml(resolveColor(custom)) : fallback;
  const dash = (value?: boolean) => value ? ' stroke-dasharray="6 4"' : '';
  const interactive = (id: string) => selection
    ? ` data-arch-id="${xml(id)}" role="button" tabindex="0" aria-pressed="${selection.has(id)}"`
    : '';
  const out = ['<g font-family="Arial, sans-serif">'];
  for (const g of scene.groups) {
    const stroke = selection?.has(g.id) ? palette.accent : color(g.color, palette.border);
    const width = selection?.has(g.id) ? 2.5 : 1.25;
    out.push(`<g><title>${xml(g.note ? `${g.name}\n${g.note}` : g.name)}</title>`);
    for (const offset of g.stacked ? [10, 5] : []) {
      out.push(`<rect x="${g.x + offset}" y="${g.y + offset}" width="${g.w}" height="${g.h}" rx="8" fill="none" stroke="${stroke}"/>`);
    }
    out.push(`<rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="8" fill="${stroke}" fill-opacity=".035" stroke="${stroke}" stroke-width="${width}"${dash(g.dashed)}/>`);
    const top = g.labelBottom ? g.y + g.h - 27 : g.y + 4;
    out.push(`<g${interactive(g.id)} aria-label="${xml(g.name)}"><rect x="${g.x + 7}" y="${top}" width="${g.w - 14}" height="22" rx="4" fill="${palette.headerBg}"/><text x="${g.x + 16}" y="${top + 11}" dominant-baseline="central" font-size="13" font-weight="700" fill="${palette.fg}">${xml(g.name)}</text></g></g>`);
  }

  const endpointNames = new Map([...scene.nodes, ...scene.groups].map((item) => [item.id, item.name]));
  for (const note of scene.notes) endpointNames.set(note.layoutKey, note.name);
  for (const { link, color: lineColor, d, corners, label } of scene.routes) {
    const stroke = color(lineColor, palette.edge);
    const description = `${endpointNames.get(link.from) ?? link.from} ${link.operator} ${endpointNames.get(link.to) ?? link.to}`;
    out.push(`<g><title>${xml(label ? `${description}\n${label.text}` : description)}</title><path class="ddd-architecture-link" d="${d}" fill="none" stroke="${stroke}" stroke-width="1.6"${dash(link.dashed)}/>`);
    if (link.operator === '<' || link.operator === '<>') out.push(arrow(corners, stroke));
    if (link.operator === '>' || link.operator === '<>') out.push(arrow([...corners].reverse(), stroke));
    out.push('</g>');
    if (label) out.push(`<rect x="${label.x - label.w / 2}" y="${label.y - 9}" width="${label.w}" height="18" rx="4" fill="${palette.surface}"/><text x="${label.x}" y="${label.y}" text-anchor="middle" dominant-baseline="central" font-size="11" fill="${palette.fgMuted}">${xml(label.text)}</text>`);
  }

  for (const node of scene.nodes) {
    const stroke = selection?.has(node.id) ? palette.accent : color(node.color, palette.border);
    const width = selection?.has(node.id) ? 2.5 : 1.25;
    const { x, y, w, h } = node;
    const iconColor = color(node.color, palette.fg);
    const subtitle = nodeSubtitle(node);
    out.push(`<g${interactive(node.id)} aria-label="${xml(`${node.name}, ${subtitle}`)}"><title>${xml([node.name, subtitle, node.note].filter(Boolean).join('\n'))}</title>`);
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${palette.surface}" stroke="${stroke}" stroke-width="${width}"${dash(node.dashed)}/>`);
    out.push(`<rect x="${x + 13}" y="${y + 17}" width="42" height="42" rx="7" fill="${palette.headerBg}"/>`);
    if (node.icon && isEmbeddedArchitectureImage(node.icon)) {
      out.push(`<image x="${x + 19}" y="${y + 23}" width="30" height="30" href="${node.icon}" preserveAspectRatio="xMidYMid meet"/>`);
    } else {
      out.push(`<path transform="translate(${x + 22} ${y + 26})" d="${roleGlyph(node.role)}" fill="none" stroke="${iconColor}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    out.push(`<text x="${x + 67}" y="${y + 29}" dominant-baseline="central" font-size="15" font-weight="700" fill="${palette.fg}">${xml(node.name)}</text>`);
    out.push(`<text x="${x + 67}" y="${y + 49}" dominant-baseline="central" font-size="12" fill="${palette.fgMuted}">${xml(subtitle)}</text></g>`);
  }
  out.push('</g>');
  return out.join('');
}

function arrow(points: readonly Point[], color: string): string {
  const tip = points[0];
  const along = points.find((p) => p.x !== tip?.x || p.y !== tip?.y);
  if (!tip || !along) return '';
  const dx = tip.x - along.x, dy = tip.y - along.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length, uy = dy / length;
  const x = tip.x - ux * 10, y = tip.y - uy * 10;
  return `<path class="ddd-architecture-arrow" d="M ${tip.x} ${tip.y} L ${x - uy * 4.5} ${y + ux * 4.5} L ${x + uy * 4.5} ${y - ux * 4.5} Z" fill="${color}"/>`;
}
