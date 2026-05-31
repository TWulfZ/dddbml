import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { cn } from './cn';
import { Button } from './Button';
import { IconClose } from '../icons';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Wider variant (= legacy .ddd-modal--wide). */
  wide?: boolean;
  /** Optional footer row (e.g. action buttons). */
  footer?: ComponentChildren;
  children?: ComponentChildren;
}

/**
 * Modal dialog built on the native `<dialog>` element: `showModal()` gives a
 * focus trap, Esc-to-close, the top layer (escapes z-index/overflow) and a
 * `::backdrop` scrim for free. Wraps the existing `.ddd-modal*` `@layer` classes
 * (structural/animated CSS stays in style.css; see specs/12-design-system.md).
 *
 * The dialog stays mounted so `open` can drive `showModal()`/`close()`; gate the
 * heavy body with `{open && …}` at the call site if needed.
 */
export function Modal({ open, onClose, title, wide, footer, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      class={cn('ddd-modal', wide && 'ddd-modal--wide')}
      // Native `close` fires on Esc or .close() — sync parent state.
      onClose={onClose}
      // A click whose target is the dialog itself landed on the backdrop.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div class="ddd-modal__head">
        <span class="ddd-modal__title">{title}</span>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close">
          <IconClose size={12} />
        </Button>
      </div>
      <div class="ddd-modal__body">{children}</div>
      {footer ? <div class="ddd-modal__foot">{footer}</div> : null}
    </dialog>
  );
}
