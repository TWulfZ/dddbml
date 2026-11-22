import { describe, expect, it } from 'vitest';
import { shouldPanCanvas } from './canvasGestures';

describe('empty canvas dragging', () => {
  it('pans with the left button when no tables are selected', () => {
    expect(shouldPanCanvas({ button: 0, shiftKey: false }, true, true, 0, false)).toBe(true);
  });
  it('keeps Shift-drag available for marquee selection', () => {
    expect(shouldPanCanvas({ button: 0, shiftKey: true }, true, true, 0, false)).toBe(false);
  });
  it('does not steal table, edge, or toolbar gestures', () => {
    expect(shouldPanCanvas({ button: 0, shiftKey: false }, true, false, 0, false)).toBe(false);
    expect(shouldPanCanvas({ button: 0, shiftKey: false }, false, true, 0, false)).toBe(false);
  });
  it('retains marquee behavior with selected tables and explicit pan controls', () => {
    expect(shouldPanCanvas({ button: 0, shiftKey: false }, true, true, 1, false)).toBe(false);
    expect(shouldPanCanvas({ button: 0, shiftKey: false }, true, false, 1, true)).toBe(true);
    expect(shouldPanCanvas({ button: 1, shiftKey: false }, true, false, 1, false)).toBe(true);
  });
});
