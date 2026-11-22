import type { DiagramView, Schema } from '../../shared/types';

function includes<T extends string>(filter: T[] | '*', value: T): boolean {
  return filter === '*' || filter.includes(value);
}

/** Filter the display without altering the source schema or shared layout. */
export function schemaForView(schema: Schema, view: DiagramView | undefined): Schema {
  if (!view) return schema;
  const groups = schema.groups.filter((g) => includes(view.groups, g.name));
  const groupNames = new Set(groups.map((g) => g.name));
  const groupTables = new Set(groups.flatMap((g) => g.tables));
  const tables = schema.tables
    .filter((t) => groupTables.has(t.name) || includes(view.tables, t.name) || includes(view.schemas, t.schemaName))
    .map((t) => t.groupName && !groupNames.has(t.groupName) ? { ...t, groupName: null } : t);
  return {
    ...schema, tables, groups,
    labels: schema.labels?.filter((label) => includes(view.notes, label.name)),
  };
}

export function activeDiagramView(schema: Schema, name: string | null): DiagramView | undefined {
  return schema.diagramViews?.find((view) => view.name === name);
}
