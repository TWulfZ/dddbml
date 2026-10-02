import { describe, expect, it } from 'vitest';
import { applyEdits, diffEdit, growOverInsertion, invertEdits, mergeDeletions } from './textEdits';

describe('text edits', () => {
  const src = 'alpha beta gamma';
  const edits = [{ start: 11, end: 16, newText: 'G' }, { start: 0, end: 5, newText: 'ALPHA!' }];

  it('inverts unsorted edits in the edited text offsets', () => {
    const after = applyEdits(src, edits);
    expect(after).toBe('ALPHA! beta G');
    expect(applyEdits(after, invertEdits(src, edits))).toBe(src);
  });

  it('diffs to one minimal edit', () => {
    expect(diffEdit('abcXdef', 'abcYYdef')).toEqual([{ start: 3, end: 4, newText: 'YY' }]);
    expect(diffEdit('aaa', 'aaaa')).toEqual([{ start: 3, end: 3, newText: 'a' }]);
    expect(diffEdit('same', 'same')).toEqual([]);
  });

  it('unions overlapping and touching deletions', () => {
    expect(mergeDeletions([{ start: 5, end: 8 }, { start: 0, end: 2 }, { start: 2, end: 3 }, { start: 6, end: 10 }]))
      .toEqual([{ start: 0, end: 3, newText: '' }, { start: 5, end: 10, newText: '' }]);
  });

  it('grows the inverse of an insertion over text typed inside it', () => {
    const before = 'head\ntail\n';
    const insert = [{ start: 5, end: 5, newText: 'T {\n}\n' }, { start: 0, end: 0, newText: '>' }];
    const after = applyEdits(before, insert);
    const inverse = invertEdits(before, insert);
    const at = after.indexOf('}');
    const withLine = after.slice(0, at) + '  \n' + after.slice(at);
    expect(applyEdits(withLine, growOverInsertion(inverse, at, 3))).toBe(before);
  });
});
