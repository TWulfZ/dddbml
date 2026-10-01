import { describe, expect, it } from 'vitest';
import { singularizeEnglish } from './naming';

describe('singularizeEnglish', () => {
  it.each([
    ['users', 'user'],
    ['categories', 'category'],
    ['courses', 'course'],
    ['purchases', 'purchase'],
    ['responses', 'response'],
    ['sizes', 'size'],
    ['addresses', 'address'],
    ['classes', 'class'],
    ['boxes', 'box'],
    ['matches', 'match'],
    ['quizzes', 'quiz'],
    ['statuses', 'status'],
    ['buses', 'bus'],
    ['movies', 'movie'],
    ['cookies', 'cookie'],
    ['ties', 'tie'],
    ['menus', 'menu'],
    ['children', 'child'],
  ])('%s → %s', (plural, singular) => {
    expect(singularizeEnglish(plural)).toBe(singular);
  });

  it.each(['status', 'campus', 'analysis', 'axis', 'class', 'address', 'data', 'series'])(
    'leaves the singular %s unchanged',
    (word) => {
      expect(singularizeEnglish(word)).toBe(word);
    },
  );
});
