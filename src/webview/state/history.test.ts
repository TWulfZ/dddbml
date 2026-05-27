import { describe, expect, it } from 'vitest';
import { buildMoveCommand } from './history';

const pos = (x: number, y: number) => ({ x, y });

describe('buildMoveCommand', () => {
  it('returns null for empty origins', () => {
    expect(buildMoveCommand(new Map(), new Map())).toBeNull();
  });

  it('returns null when all deltas are zero (no-op drag)', () => {
    const origins = new Map([['public.users', pos(100, 200)]]);
    const current = new Map([['public.users', pos(100, 200)]]);
    expect(buildMoveCommand(origins, current)).toBeNull();
  });

  it('builds a single-table move command', () => {
    const origins = new Map([['public.users', pos(100, 200)]]);
    const current = new Map([['public.users', pos(300, 400)]]);
    const cmd = buildMoveCommand(origins, current);
    expect(cmd).not.toBeNull();
    expect(cmd!.kind).toBe('move');
    expect(cmd!.from).toEqual([['public.users', { x: 100, y: 200 }]]);
    expect(cmd!.to).toEqual([['public.users', { x: 300, y: 400 }]]);
    expect(cmd!.label).toBe('Move public.users');
    expect(typeof cmd!.timestamp).toBe('number');
  });

  it('builds a batch move command', () => {
    const origins = new Map([
      ['public.users', pos(0, 0)],
      ['public.orders', pos(10, 10)],
      ['public.items', pos(20, 20)],
    ]);
    const current = new Map([
      ['public.users', pos(100, 100)],
      ['public.orders', pos(110, 110)],
      ['public.items', pos(120, 120)],
    ]);
    const cmd = buildMoveCommand(origins, current);
    expect(cmd).not.toBeNull();
    expect(cmd!.from).toHaveLength(3);
    expect(cmd!.to).toHaveLength(3);
    expect(cmd!.label).toBe('Move 3 tables');
  });

  it('skips tables that no longer exist in current positions', () => {
    const origins = new Map([
      ['public.users', pos(0, 0)],
      ['public.ghost', pos(0, 0)],
    ]);
    const current = new Map([
      ['public.users', pos(100, 100)],
    ]);
    const cmd = buildMoveCommand(origins, current);
    expect(cmd).not.toBeNull();
    expect(cmd!.from).toEqual([['public.users', { x: 0, y: 0 }]]);
    expect(cmd!.to).toEqual([['public.users', { x: 100, y: 100 }]]);
  });

  it('returns null when every origin is missing from current', () => {
    const origins = new Map([['public.ghost', pos(0, 0)]]);
    const current = new Map();
    expect(buildMoveCommand(origins, current)).toBeNull();
  });

  it('treats a batch with one moved + others static as moved', () => {
    const origins = new Map([
      ['a', pos(0, 0)],
      ['b', pos(50, 50)],
    ]);
    const current = new Map([
      ['a', pos(0, 0)],
      ['b', pos(60, 50)],
    ]);
    const cmd = buildMoveCommand(origins, current);
    expect(cmd).not.toBeNull();
    expect(cmd!.from).toHaveLength(2);
  });
});
