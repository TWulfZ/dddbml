export interface TsTypeMapping {
  tsType: string;
  columnOptions: Record<string, unknown>;
  unknown?: boolean;
}

export interface Dialect {
  id: string;
  label: string;
  mapType(dbmlType: string): TsTypeMapping;
}

const dialects = new Map<string, Dialect>();

export function registerDialect(d: Dialect): void {
  dialects.set(d.id, d);
}

export function getDialect(id: string): Dialect | undefined {
  return dialects.get(id);
}

export function listDialects(): Array<{ id: string; label: string }> {
  return [...dialects.values()].map((d) => ({ id: d.id, label: d.label }));
}
