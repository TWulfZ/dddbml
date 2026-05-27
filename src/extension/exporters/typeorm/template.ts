import type { Column, QualifiedName, Table } from '../../../shared/types';
import type { Dialect } from './dialect';
import { toClassName } from './naming';
import type { RelationSide } from './relations';

interface EmitOptions {
  dialect: Dialect;
  singularize: boolean;
  emitNullableExplicit: boolean;
}

interface EmittedEntity {
  className: string;
  source: string;
  decoratorsUsed: Set<string>;
  warnings: string[];
}

export function emitEntity(
  table: Table,
  relations: ReadonlyArray<RelationSide>,
  opts: EmitOptions,
): EmittedEntity {
  const className = toClassName(table.name, { singularize: opts.singularize });
  const warnings: string[] = [];
  const decoratorsUsed = new Set<string>(['Entity']);

  const lines: string[] = [];

  const entityArgs = entityDecoratorArgs(table);
  lines.push(`@Entity(${entityArgs})`);
  lines.push(`export class ${className} {`);

  const fkColumnsByCol = new Map<string, RelationSide>();
  for (const rel of relations) {
    for (const col of rel.fkColumns) {
      if (rel.isOwning) fkColumnsByCol.set(col, rel);
    }
  }

  const columnBlocks: string[] = [];
  const seenPk = new Set<string>();
  for (const col of table.columns) {
    const block = emitColumn(col, opts, decoratorsUsed, warnings, table.name);
    columnBlocks.push(block);
    if (col.pk) seenPk.add(col.name);
  }

  const relationBlocks: string[] = [];
  for (const rel of relations) {
    relationBlocks.push(emitRelation(rel, opts, decoratorsUsed));
  }

  const allBlocks = [...columnBlocks, ...relationBlocks];
  lines.push(allBlocks.map((b) => indent(b, 2)).join('\n\n'));
  lines.push('}');

  return {
    className,
    source: lines.join('\n'),
    decoratorsUsed,
    warnings,
  };
}

function entityDecoratorArgs(table: Table): string {
  const isPublic = !table.schemaName || table.schemaName === 'public';
  const parts: string[] = [`name: ${JSON.stringify(table.tableName)}`];
  if (!isPublic) parts.push(`schema: ${JSON.stringify(table.schemaName)}`);
  return `{ ${parts.join(', ')} }`;
}

function emitColumn(
  col: Column,
  opts: EmitOptions,
  decoratorsUsed: Set<string>,
  warnings: string[],
  tableName: QualifiedName,
): string {
  const mapping = opts.dialect.mapType(col.type);
  if (mapping.unknown) {
    warnings.push(`${tableName}.${col.name}: unknown type "${col.type}" — emitted as string with raw column type.`);
  }

  const colOpts: Record<string, unknown> = { ...mapping.columnOptions };

  // Primary keys
  if (col.pk && col.increment) {
    const isUuid = mapping.columnOptions.type === 'uuid';
    decoratorsUsed.add('PrimaryGeneratedColumn');
    const arg = isUuid ? `'uuid'` : '';
    const lines: string[] = [];
    if (col.note) lines.push(`/** ${escapeBlockComment(col.note)} */`);
    lines.push(`@PrimaryGeneratedColumn(${arg})`);
    lines.push(`${col.name}!: ${mapping.tsType};`);
    return lines.join('\n');
  }

  if (col.pk) {
    decoratorsUsed.add('PrimaryColumn');
    const lines: string[] = [];
    if (col.note) lines.push(`/** ${escapeBlockComment(col.note)} */`);
    lines.push(`@PrimaryColumn(${formatOptions(colOpts)})`);
    lines.push(`${col.name}!: ${mapping.tsType};`);
    return lines.join('\n');
  }

  // Regular column
  if (col.unique) colOpts.unique = true;
  const nullable = !col.notNull;
  if (opts.emitNullableExplicit) colOpts.nullable = nullable;
  const defaultExpr = emitDefault(col.default);
  if (defaultExpr !== undefined) colOpts.default = defaultExpr;

  decoratorsUsed.add('Column');
  const lines: string[] = [];
  if (col.note) lines.push(`/** ${escapeBlockComment(col.note)} */`);
  lines.push(`@Column(${formatOptions(colOpts)})`);
  const optMark = nullable ? '?' : '!';
  const tsType = nullable ? `${mapping.tsType} | null` : mapping.tsType;
  lines.push(`${col.name}${optMark}: ${tsType};`);
  return lines.join('\n');
}

interface DefaultMarker {
  __sql?: true;
  raw: string;
}

function emitDefault(value: string | null | undefined): unknown {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (/^[a-z_][\w]*\s*\(/i.test(trimmed) || trimmed.startsWith('(')) {
    const marker: DefaultMarker = { __sql: true, raw: trimmed };
    return marker;
  }
  return trimmed;
}

function emitRelation(
  rel: RelationSide,
  opts: EmitOptions,
  decoratorsUsed: Set<string>,
): string {
  decoratorsUsed.add(rel.decorator);
  const targetClass = toClassName(rel.targetTable, { singularize: opts.singularize });

  const inverseFn = `(${shortVar(targetClass)}) => ${shortVar(targetClass)}.${rel.inversePropertyName}`;
  const decoratorArgs = `() => ${targetClass}, ${inverseFn}`;

  const lines: string[] = [];
  lines.push(`@${rel.decorator}(${decoratorArgs})`);

  if (rel.isOwning) {
    if (rel.decorator === 'ManyToMany') {
      decoratorsUsed.add('JoinTable');
      lines.push('@JoinTable()');
    } else {
      decoratorsUsed.add('JoinColumn');
      if (rel.fkColumns.length === 1) {
        lines.push(`@JoinColumn({ name: ${JSON.stringify(rel.fkColumns[0])} })`);
      } else if (rel.fkColumns.length > 1) {
        const joins = rel.fkColumns.map((c) => `{ name: ${JSON.stringify(c)} }`).join(', ');
        lines.push(`@JoinColumn([${joins}])`);
      }
    }
  }

  const isArray = rel.tsType.endsWith('[]');
  const marker = isArray ? '!' : '?';
  lines.push(`${rel.propertyName}${marker}: ${rel.tsType};`);
  return lines.join('\n');
}

function shortVar(className: string): string {
  if (className.length === 0) return 'x';
  return className.charAt(0).toLowerCase() + className.slice(1);
}

function escapeBlockComment(s: string): string {
  return s.replace(/\*\//g, '* /');
}

function formatOptions(opts: Record<string, unknown>): string {
  const keys = Object.keys(opts);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const k of keys) {
    const v = opts[k];
    parts.push(`${k}: ${formatValue(v)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && v && (v as DefaultMarker).__sql === true) {
    return `() => ${JSON.stringify((v as DefaultMarker).raw)}`;
  }
  return JSON.stringify(v);
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

export function emitImports(decoratorsUsed: ReadonlySet<string>): string {
  const ordered = [...decoratorsUsed].sort();
  return `import { ${ordered.join(', ')} } from 'typeorm';`;
}
