export interface ArchitectureItem {
  id: string;
  name: string;
  note?: string;
  color?: string;
  dashed?: boolean;
}

export interface ArchitectureNode extends ArchitectureItem {
  role: string;
  type?: string;
  icon?: string;
}

export interface ArchitectureGroup extends ArchitectureItem {
  children: string[];
  labelBottom?: boolean;
  stacked?: boolean;
}

export interface ArchitectureLink {
  id: string;
  from: string;
  to: string;
  operator: '>' | '<' | '<>' | '-';
  protocol?: string;
  host?: string;
  color?: string;
  dashed?: boolean;
}

export interface Architecture {
  title?: string;
  nodes: ArchitectureNode[];
  groups: ArchitectureGroup[];
  links: ArchitectureLink[];
}

export function architectureKeys(architecture?: Architecture): string[] {
  return architecture ? [
    ...architecture.nodes.map((node) => node.id),
    ...architecture.groups.filter((group) => !group.children.length).map((group) => group.id),
  ] : [];
}
