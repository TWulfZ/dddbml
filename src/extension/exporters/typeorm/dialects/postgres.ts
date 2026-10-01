import type { Dialect, TsTypeMapping } from '../dialect';

interface Parsed {
  base: string;
  args: number[];
  arrayDepth: number;
}

function parseDbmlType(raw: string): Parsed {
  let trimmed = raw.trim().toLowerCase();
  const arraySuffix = /(\s*\[\d*\])+$/.exec(trimmed);
  const arrayDepth = arraySuffix ? (arraySuffix[0].match(/\[/g) ?? []).length : 0;
  if (arraySuffix) trimmed = trimmed.slice(0, arraySuffix.index).trim();
  const open = trimmed.indexOf('(');
  if (open < 0) return { base: trimmed, args: [], arrayDepth };
  const close = trimmed.lastIndexOf(')');
  // `timestamp(3) with time zone`: the modifier after the arguments is part of the type name.
  const rest = close > open ? trimmed.slice(close + 1).trim() : '';
  const base = [trimmed.slice(0, open).trim(), rest].filter(Boolean).join(' ');
  const argStr = close > open ? trimmed.slice(open + 1, close) : '';
  const args = argStr
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return { base, args, arrayDepth };
}

export const postgresDialect: Dialect = {
  id: 'postgres',
  label: 'PostgreSQL',
  mapType(raw: string): TsTypeMapping {
    const { base, args, arrayDepth } = parseDbmlType(raw);
    const scalar = mapScalar(base, args, raw);
    if (arrayDepth === 0 || scalar.unknown) return scalar;
    return {
      ...scalar,
      tsType: `${scalar.tsType}${'[]'.repeat(arrayDepth)}`,
      columnOptions: { ...scalar.columnOptions, array: true },
    };
  },
};

function withPrecision(type: string, args: number[]): Record<string, unknown> {
  return args[0] !== undefined ? { type, precision: args[0] } : { type };
}

function mapScalar(base: string, args: number[], raw: string): TsTypeMapping {
  switch (base) {
    case 'int':
    case 'integer':
    case 'int4':
      return { tsType: 'number', columnOptions: { type: 'int' } };

    case 'serial':
    case 'serial4':
      return { tsType: 'number', columnOptions: { type: 'int' }, generated: 'increment' };

    case 'smallint':
    case 'int2':
      return { tsType: 'number', columnOptions: { type: 'smallint' } };

    case 'smallserial':
    case 'serial2':
      return { tsType: 'number', columnOptions: { type: 'smallint' }, generated: 'increment' };

    case 'bigint':
    case 'int8':
      return { tsType: 'string', columnOptions: { type: 'bigint' } };

    case 'bigserial':
    case 'serial8':
      return { tsType: 'string', columnOptions: { type: 'bigint' }, generated: 'increment' };

    case 'varchar':
    case 'character varying': {
      const opts: Record<string, unknown> = { type: 'varchar' };
      if (args[0]) opts.length = args[0];
      return { tsType: 'string', columnOptions: opts };
    }

    case 'char':
    case 'character':
    case 'bpchar': {
      const opts: Record<string, unknown> = { type: 'char' };
      if (args[0]) opts.length = args[0];
      return { tsType: 'string', columnOptions: opts };
    }

    case 'text':
      return { tsType: 'string', columnOptions: { type: 'text' } };

    case 'uuid':
      return { tsType: 'string', columnOptions: { type: 'uuid' } };

    case 'boolean':
    case 'bool':
      return { tsType: 'boolean', columnOptions: { type: 'boolean' } };

    case 'timestamp':
    case 'timestamp without time zone':
      return { tsType: 'Date', columnOptions: withPrecision('timestamp', args) };

    case 'timestamptz':
    case 'timestamp with time zone':
      return { tsType: 'Date', columnOptions: withPrecision('timestamptz', args) };

    case 'date':
      return { tsType: 'Date', columnOptions: { type: 'date' } };

    case 'time':
    case 'time without time zone':
      return { tsType: 'string', columnOptions: withPrecision('time', args) };

    case 'timetz':
    case 'time with time zone':
      return { tsType: 'string', columnOptions: withPrecision('timetz', args) };

    case 'numeric':
    case 'decimal': {
      const opts: Record<string, unknown> = { type: 'numeric' };
      if (args[0] !== undefined) opts.precision = args[0];
      if (args[1] !== undefined) opts.scale = args[1];
      return { tsType: 'string', columnOptions: opts };
    }

    case 'real':
    case 'float4':
      return { tsType: 'number', columnOptions: { type: 'real' } };

    case 'double precision':
    case 'float8':
    case 'double':
      return { tsType: 'number', columnOptions: { type: 'double precision' } };

    case 'json':
      return { tsType: 'Record<string, unknown>', columnOptions: { type: 'json' } };

    case 'jsonb':
      return { tsType: 'Record<string, unknown>', columnOptions: { type: 'jsonb' } };

    case 'bytea':
      return { tsType: 'Buffer', columnOptions: { type: 'bytea' } };

    default:
      return { tsType: 'string', columnOptions: { type: raw.trim() }, unknown: true };
  }
}
