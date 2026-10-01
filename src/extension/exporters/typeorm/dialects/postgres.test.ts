import { describe, expect, it } from 'vitest';
import { postgresDialect } from './postgres';

describe('postgresDialect.mapType — text after the type arguments', () => {
  it.each([
    ['varchar(50)[]', { tsType: 'string[]', columnOptions: { type: 'varchar', length: 50, array: true } }],
    ['numeric(10,2)[]', { tsType: 'string[]', columnOptions: { type: 'numeric', precision: 10, scale: 2, array: true } }],
    ['int[]', { tsType: 'number[]', columnOptions: { type: 'int', array: true } }],
    ['timestamp(3) with time zone', { tsType: 'Date', columnOptions: { type: 'timestamptz', precision: 3 } }],
    ['time(6) with time zone', { tsType: 'string', columnOptions: { type: 'timetz', precision: 6 } }],
    ['timestamp(3)', { tsType: 'Date', columnOptions: { type: 'timestamp', precision: 3 } }],
  ])('%s', (raw, expected) => {
    expect(postgresDialect.mapType(raw)).toEqual(expected);
  });

  it('flags an unrecognised suffix instead of dropping it', () => {
    expect(postgresDialect.mapType('varchar(10) collate "C"').unknown).toBe(true);
  });
});
