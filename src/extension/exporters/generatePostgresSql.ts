import { isEndpointOneSide, ModelExporter, Parser, type NormalizedModel } from '@dbml/core';

export function generatePostgresSql(source: string): string {
  const model = Parser.parse(source, 'dbmlv2').normalize();
  // Records describe data. This export contains only the schema.
  model.records = {};
  for (const field of Object.values(model.fields)) {
    if (field.dbdefault?.type === 'string') {
      field.dbdefault.value = escapeLiteral(String(field.dbdefault.value));
    }
  }
  for (const value of Object.values(model.enumValues)) {
    value.name = escapeLiteral(value.name);
  }
  prepareRefs(model);

  const ddl = ModelExporter.export(model, 'postgres')
    .replace(/^CREATE SCHEMA "public";$/m, 'CREATE SCHEMA IF NOT EXISTS "public";')
    .trimEnd();
  return [
    'BEGIN;',
    'SET LOCAL search_path TO public;',
    'SET LOCAL standard_conforming_strings TO on;',
    '',
    ddl,
    '',
    'COMMIT;',
    '',
  ].join('\n');
}

function escapeLiteral(value: string): string {
  // The upstream PostgreSQL exporter inserts default strings and enum labels verbatim.
  return value.replaceAll("'", "''");
}

function prepareRefs(model: NormalizedModel): void {
  let nextIndexId = -1;
  let nextColumnId = -1;
  for (const schema of Object.values(model.schemas)) {
    const activeRefIds = (schema.refIds as number[]).filter((id) => !model.refs[id]!.inactive);
    schema.refIds = activeRefIds;
    for (const id of activeRefIds) {
      const [target, foreign] = model.refs[id]!.endpointIds.map((endpointId) => model.endpoints[endpointId]);
      if (!target || !foreign || !isEndpointOneSide(target.relation) || !isEndpointOneSide(foreign.relation)) continue;

      // The parser puts the FK endpoint second for one-to-one refs, including inline refs.
      // Add uniqueness to that side so PostgreSQL enforces the declared cardinality.
      const fields = foreign.fieldIds.map((fieldId) => model.fields[fieldId]!);
      if (fields.some((field) => field.unique || field.pk)) continue;
      const table = model.tables[fields[0]!.tableId]!;
      const names = new Set(fields.map((field) => field.name));
      const hasUniqueKey = table.indexIds.some((indexId) => {
        const index = model.indexes[indexId]!;
        return (index.unique || index.pk) && index.columnIds.every((columnId) => {
          const column = model.indexColumns[columnId]!;
          return column.type !== 'expression' && names.has(column.value);
        });
      });
      if (hasUniqueKey) continue;

      const indexId = nextIndexId--;
      const columnIds = fields.map((field) => {
        const columnId = nextColumnId--;
        model.indexColumns[columnId] = { id: columnId, indexId, type: 'column', value: field.name };
        return columnId;
      });
      model.indexes[indexId] = {
        id: indexId, tableId: table.id, columnIds, unique: true, pk: '', name: null, note: null, type: null,
      };
      table.indexIds.push(indexId);
    }
  }
}
