import { noteLayoutKey } from '../shared/diagramLabels';
import type { Architecture, ArchitectureItem } from '../shared/architecture';

interface CoreArchItem {
  id: number;
  name: string;
  alias?: string | null;
  note?: string | null;
  settings?: Record<string, unknown>;
}
interface CoreArchNode extends CoreArchItem {
  role: string;
  type?: string | null;
  icon?: string | null;
}
interface CoreArchGroup extends CoreArchItem {
  childIds: number[];
  childTypes: string[];
}
interface CoreArchLink {
  fromId: number;
  fromType: string;
  toId: number;
  toType: string;
  op: Architecture['links'][number]['operator'];
  settings?: Record<string, unknown>;
}
interface CoreArchitecture {
  diagramType?: string | null;
  frontMatter?: Record<string, unknown> | null;
  nodes?: CoreArchNode[];
  groups?: CoreArchGroup[];
  links?: CoreArchLink[];
  notes?: { id: number; name: string }[];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function color(value: unknown): string | undefined {
  return typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : undefined;
}

export function mapArchitecture(database: unknown): Architecture | undefined {
  const core = database as CoreArchitecture;
  if (core.diagramType !== 'arch' && core.diagramType !== 'architecture') return undefined;
  const ids = new Map<string, string>();
  const setupItem = (kind: 'node' | 'group', item: CoreArchItem, role?: string): ArchitectureItem => {
    const identity = item.alias ? `alias:${encodeURIComponent(item.alias)}` : `${role ?? 'name'}:${encodeURIComponent(item.name)}`;
    const id = `arch:${kind}:${identity}`;
    ids.set(`${kind}:${item.id}`, id);
    return { id, name: item.name, note: text(item.note), color: color(item.settings?.color), dashed: item.settings?.style === 'dashed' };
  };
  const nodes = (core.nodes ?? []).map((node) => ({
    ...setupItem('node', node, node.role), role: node.role, type: text(node.type),
    icon: text(node.icon) ?? text(node.settings?.icon),
  }));
  for (const note of core.notes ?? []) ids.set(`note:${note.id}`, noteLayoutKey(note.name));
  const sourceGroups = core.groups ?? [];
  const groups = sourceGroups.map((group) => ({
    ...setupItem('group', group),
    labelBottom: group.settings?.label === 'bottom',
    stacked: group.settings?.stacked === true,
    children: [] as string[],
  }));
  for (const [i, group] of sourceGroups.entries()) {
    groups[i]!.children = group.childIds.flatMap((child, index) => {
      const kind = group.childTypes[index];
      const id = ids.get(`${kind}:${child}`);
      return id ? [id] : [];
    });
  }
  // Malformed group cycles can reach this model. Keep all groups and discard back-edges.
  const byId = new Map(groups.map((group) => [group.id, group]));
  const active = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): void => {
    const group = byId.get(id);
    if (!group || visited.has(id)) return;
    visited.add(id);
    active.add(id);
    group.children = group.children.filter((child) => {
      if (active.has(child)) return false;
      walk(child);
      return true;
    });
    active.delete(id);
  };
  for (const group of groups) walk(group.id);

  const links: Architecture['links'] = [];
  const occurrences = new Map<string, number>();
  for (const link of core.links ?? []) {
    const from = ids.get(`${link.fromType}:${link.fromId}`);
    const to = ids.get(`${link.toType}:${link.toId}`);
    if (!from || !to) continue;
    const key = JSON.stringify([from, to, link.op]);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    links.push({
      id: `arch:link:${key}:${occurrence}`, from, to, operator: link.op, protocol: text(link.settings?.proto), host: text(link.settings?.host),
      color: color(link.settings?.color), dashed: link.settings?.style === 'dashed',
    });
  }
  return { title: text(core.frontMatter?.title), nodes, groups, links };
}
