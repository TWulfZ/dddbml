import type { Dialect, TsTypeMapping } from '../dialect';

interface Parsed {
  base: string;
  args: number[];
}

function parseDbmlType(raw: string): Parsed {
  const trimmed = raw.trim().toLowerCase();
  const open = trimmed.indexOf('(');
  if (open < 0) return { base: trimmed, args: [] };
  const close = trimmed.lastIndexOf(')');
  const base = trimmed.slice(0, open).trim();
  const argStr = close > open ? trimmed.slice(open + 1, close) : '';
  const args = argStr
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return { base, args };
}

export const postgresDialect: Dialect = {
  id: 'postgres',
  label: 'PostgreSQL',
  mapType(raw: string): TsTypeMapping {
    const { base, args } = parseDbmlType(raw);

    switch (base) {
      case 'int':
      case 'integer':
      case 'int4':
      case 'serial':
      case 'serial4':
        return { tsType: 'number', columnOptions: { type: 'int' } };

      case 'smallint':
      case 'int2':
      case 'smallserial':
      case 'serial2':
        return { tsType: 'number', columnOptions: { type: 'smallint' } };

      case 'bigint':
      case 'int8':
      case 'bigserial':
      case 'serial8':
        return { tsType: 'string', columnOptions: { type: 'bigint' } };

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
        return { tsType: 'Date', columnOptions: { type: 'timestamp' } };

      case 'timestamptz':
      case 'timestamp with time zone':
        return { tsType: 'Date', columnOptions: { type: 'timestamptz' } };

      case 'date':
        return { tsType: 'Date', columnOptions: { type: 'date' } };

      case 'time':
      case 'time without time zone':
        return { tsType: 'string', columnOptions: { type: 'time' } };

      case 'timetz':
      case 'time with time zone':
        return { tsType: 'string', columnOptions: { type: 'timetz' } };

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
  },
};
