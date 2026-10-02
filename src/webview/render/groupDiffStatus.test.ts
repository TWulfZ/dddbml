import { describe, expect, it } from 'vitest';
import { groupDiffStatuses } from './groupDiffStatus';
import type { QualifiedName, Table, TableDiffStatus, TableGroup } from '../../shared/types';
import type { DiffGhost } from '../state/store';

const groups: TableGroup[] = [
  { name: 'adds', tables: ['a1', 'a2', 'same'] },
  { name: 'mods', tables: ['m1'] },
  { name: 'mixed', tables: ['x1', 'x2'] },
  { name: 'gone', tables: ['keep'] },
  { name: 'clean', tables: ['c1'] },
  { name: 'hiddenOnly', tables: ['h1'] },
];
const ghost = (name: QualifiedName, groupName: string | null): DiffGhost => ({
  table: { name, schemaName: 'public', tableName: name, columns: [], groupName } satisfies Table,
  pos: { x: 0, y: 0 },
});
const diff = new Map<QualifiedName, TableDiffStatus>([
  ['a1', 'added'], ['a2', 'added'], ['m1', 'modified'], ['x1', 'added'], ['h1', 'modified'], ['loose', 'added'],
]);

describe('groupDiffStatuses (spec 16)', () => {
  const out = groupDiffStatuses(groups, diff, [ghost('r1', 'gone'), ghost('r2', 'mixed'), ghost('r3', null)], new Set(['h1']));

  it('a group whose changed members agree takes their status', () => {
    expect(out.get('adds')).toBe('added');
    expect(out.get('mods')).toBe('modified');
  });

  it('removed members come from the diff ghosts by their base group', () => {
    expect(out.get('gone')).toBe('removed');
  });

  it('mixed statuses collapse to modified', () => {
    expect(out.get('mixed')).toBe('modified');
  });

  it('groups with no visible change get no status', () => {
    expect(out.has('clean')).toBe(false);
    expect(out.has('hiddenOnly')).toBe(false);
  });

  it('no diff, no statuses', () => {
    expect(groupDiffStatuses(groups, null, null, new Set()).size).toBe(0);
  });
});
