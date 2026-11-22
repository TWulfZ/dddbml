/** Decide canvas navigation before the marquee starts; chrome and tables retain their own drags. */
export function shouldPanCanvas(
  e: Pick<PointerEvent, 'button' | 'shiftKey'>,
  onCanvas: boolean,
  emptyCanvas: boolean,
  selectionSize: number,
  panActive: boolean,
): boolean {
  return onCanvas && (e.button === 1 || (e.button === 0 && (panActive || (emptyCanvas && selectionSize === 0 && !e.shiftKey))));
}
