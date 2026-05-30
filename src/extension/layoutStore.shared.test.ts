import { describe, expect, it } from 'vitest';
import { hasConflictMarkers, serializeLayout, serializeSharedLayout } from './layoutStore';
import type { Layout } from '../shared/types';

const layout: Layout = {
  version: 1,
  viewport: { x: 120, y: -40, zoom: 0.55 },
  tables: { 'public.a': { x: 1, y: 1, hidden: true, color: '#abc' } },
  groups: { iam: { hidden: true, collapsed: true, color: '#def' }, plain: { hidden: true } },
  edges: { 'e1': { waypoints: [{ x: 10, y: 20 }] } },
};

describe('serializeSharedLayout — git form carries ZERO view-state', () => {
  const text = serializeSharedLayout(layout);

  it('omits the viewport line entirely', () => {
    expect(text).not.toContain('"viewport"');
  });

  it('omits per-table hidden and per-group hidden/collapsed', () => {
    expect(text).not.toContain('"hidden"');
    expect(text).not.toContain('"collapsed"');
  });

  it('keeps shared design: table position+color, group color, edges', () => {
    expect(text).toContain('"public.a": { "x": 1, "y": 1, "color": "#abc" }');
    expect(text).toContain('"iam": { "color": "#def" }');
    expect(text).toContain('"waypoints"');
  });

  it('drops color-less groups (a group with only a hidden flag has nothing shared)', () => {
    expect(text).not.toContain('"plain"');
  });

  it('the full serializer is unchanged and still emits view-state', () => {
    const full = serializeLayout(layout);
    expect(full).toContain('"viewport"');
    expect(full).toContain('"hidden": true');
    expect(full).toContain('"collapsed": true');
    expect(full).toContain('"plain"');
  });
});

describe('hasConflictMarkers — data-loss guard', () => {
  it('detects git conflict markers', () => {
    expect(hasConflictMarkers('{\n<<<<<<< HEAD\n"x":1\n=======\n"x":2\n>>>>>>> branch\n}')).toBe(true);
    expect(hasConflictMarkers('||||||| base')).toBe(true);
  });

  it('does not flag clean JSON', () => {
    expect(hasConflictMarkers(serializeSharedLayout(layout))).toBe(false);
  });
});
