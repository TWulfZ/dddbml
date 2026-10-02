import { describe, expect, it } from 'vitest';
import { newTableRequest } from './canvasMenu';
import type { SceneRect } from './sceneGeometry';

const box = (name: string, x: number, y: number, w: number, h: number): SceneRect => ({ name, x, y, w, h, color: '#000' });
const grid16 = (n: number) => Math.round(n / 16) * 16;

describe('newTableRequest (spec 19 §Crear tabla)', () => {
  it('snaps the click and names no group on open canvas', () => {
    expect(newTableRequest({ x: 37, y: 9 }, [box('billing', 500, 500, 100, 100)], grid16)).toEqual({ type: 'schema:addTable', payload: { x: 32, y: 16 } });
  });

  it('names the innermost expanded group box under the click', () => {
    const containers = [box('outer', 0, 0, 1000, 1000), box('inner', 100, 100, 200, 200)];
    expect(newTableRequest({ x: 150, y: 150 }, containers, Math.round).payload.group).toBe('inner');
    expect(newTableRequest({ x: 800, y: 800 }, containers, Math.round).payload.group).toBe('outer');
  });
});
