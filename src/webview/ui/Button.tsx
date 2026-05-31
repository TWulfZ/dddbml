import type { JSX, ComponentChildren } from 'preact';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

/**
 * Button variant config (shadcn-style: co-located with the component, exported
 * as `buttonVariants`). Each variant maps 1:1 to a former hand-picked class
 * family, expressed as Tailwind arbitrary-value utilities over the existing
 * --ddd-* / --vscode-* tokens — so --ddd-* stays the single source of truth and
 * theme switches repaint with no JS.
 *
 *   ghost     → .ddd-icon-btn          secondary → .ddd-btn
 *   primary   → .ddd-btn--primary      action    → .ddd-actions-btn
 *   history   → .ddd-hist-btn          zoom      → .ddd-zoom__btn
 *   toolbar   → .ddd-edge-toolbar__btn
 *   subtle    → (new) borderless icon button; only the hover bg changes
 *
 * `active` / `off` are boolean toggle variants (= legacy .is-on/.is-active /
 * .is-off). For toggle-able variants (ghost/action/history) the resting bg/text/
 * border colors live in `compoundVariants` keyed on `active`, so idle and active
 * never set the same property at once — conflict-free, no tailwind-merge needed.
 *
 * The `.ddd-*` mapping above is lineage only — those legacy CSS rules were
 * retired from style.css once the look was confirmed. Reverting Tailwind now
 * means a `git revert` of that change, not a string swap.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center cursor-pointer active:scale-[0.97] ' +
    'transition-[color,background-color,border-color,scale] duration-[var(--ddd-duration-instant)] ease-[var(--ddd-ease-out)]',
  {
    variants: {
      variant: {
        // toggle-able: resting bg/text come from compoundVariants below (idle vs active are
        // mutually exclusive there, so the base must NOT set bg — that would collide, no tw-merge).
        ghost:
          'rounded-[var(--ddd-radius-sm)] border border-transparent ' +
          'hover:bg-[var(--ddd-surface-hover)] hover:border-[color:var(--ddd-border)] disabled:opacity-50 disabled:cursor-not-allowed',
        // like ghost but fully borderless (no hover border) — only the bg changes
        subtle:
          'rounded-[var(--ddd-radius-sm)] border-none ' +
          'hover:bg-[var(--ddd-surface-hover)] disabled:opacity-50 disabled:cursor-not-allowed',
        action:
          'rounded-[var(--ddd-radius-sm)] border gap-[var(--ddd-space-3)] px-[var(--ddd-space-5)] py-[var(--ddd-space-2)] ' +
          'text-[length:var(--ddd-text-base)]',
        // icon-only variants below carry COLOR/STATE only — geometry comes from `size` (use size="tool")
        history:
          'rounded-[var(--ddd-radius-sm)] border-none ' +
          'hover:bg-[var(--ddd-surface-hover)] hover:text-[color:var(--ddd-fg)] disabled:opacity-[0.35] disabled:cursor-default',
        // non-toggle: full look inline
        secondary:
          'rounded-[var(--ddd-radius-sm)] border border-[color:var(--ddd-border)] px-[var(--ddd-space-5)] py-[var(--ddd-space-2)] ' +
          'text-[length:var(--ddd-text-base)] bg-transparent text-[color:var(--ddd-fg)] active:scale-[0.97] ' +
          'hover:bg-[var(--ddd-surface-hover)] hover:border-[color:var(--ddd-fg-muted)] disabled:opacity-50 disabled:cursor-not-allowed',
        primary:
          'rounded-[var(--ddd-radius-sm)] border border-[color:var(--ddd-accent)] px-[var(--ddd-space-5)] py-[var(--ddd-space-2)] ' +
          'text-[length:var(--ddd-text-base)] font-medium bg-[var(--ddd-accent)] text-[color:var(--ddd-fg-on-accent)] active:scale-[0.97] ' +
          'hover:bg-[var(--ddd-accent-hover)] hover:border-[color:var(--ddd-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed',
        // destructive (irreversible) actions: outline so it reads as danger in both themes without
        // relying on a danger-bg token (errorForeground is a text color). Mirrors `secondary` geometry.
        danger:
          'rounded-[var(--ddd-radius-sm)] border border-[color:var(--ddd-danger)] px-[var(--ddd-space-5)] py-[var(--ddd-space-2)] ' +
          'text-[length:var(--ddd-text-base)] font-medium bg-transparent text-[color:var(--ddd-danger)] active:scale-[0.97] ' +
          'hover:bg-[var(--ddd-surface-hover)] disabled:opacity-50 disabled:cursor-not-allowed',
        // toggle-able (pan tool): resting colors come from compoundVariants below
        zoom:
          'rounded-[var(--ddd-radius-sm)] border-none hover:bg-[var(--ddd-surface-hover)]',
        toolbar:
          'rounded-[var(--ddd-radius-sm)] border-none bg-transparent text-[color:var(--ddd-fg)] ' +
          'hover:bg-[var(--ddd-surface-selected)]',
      },
      size: {
        sm: 'px-[var(--ddd-space-4)] py-[var(--ddd-space-1)] text-[length:var(--ddd-text-sm)]',
        md: 'px-[var(--ddd-space-5)] py-[var(--ddd-space-2)] text-[length:var(--ddd-text-base)]',
        // dense list rows
        icon: 'w-[24px] h-[22px] p-0',
        // canonical floating-toolbar / menu icon button — one fixed square everywhere
        tool: 'w-[28px] h-[28px] p-0',
      },
      active: { true: '', false: '' },
      off: { true: 'opacity-[0.55]', false: '' },
    },
    compoundVariants: [
      // Icon toggles (ghost/subtle/history/zoom): active = background highlight ONLY. The icon
      // keeps its normal --ddd-fg color (never tinted accent) so "active" reads as a filled chip,
      // not a recolored glyph. Idle/active bg live in mutually-exclusive compounds → conflict-free.
      { variant: 'ghost', active: false, class: 'bg-transparent text-[color:var(--ddd-fg)]' },
      { variant: 'ghost', active: true, class: 'bg-[var(--ddd-surface-selected)] text-[color:var(--ddd-fg)]' },
      { variant: 'subtle', active: false, class: 'bg-transparent text-[color:var(--ddd-fg)]' },
      { variant: 'subtle', active: true, class: 'bg-[var(--ddd-surface-selected)] text-[color:var(--ddd-fg)]' },
      // action (= .ddd-actions-btn .is-active): full accent fill when active
      {
        variant: 'action',
        active: false,
        class: 'bg-transparent text-[color:var(--ddd-fg)] border-[color:var(--ddd-border)] hover:bg-[var(--ddd-surface-hover)]',
      },
      {
        variant: 'action',
        active: true,
        class:
          'bg-[var(--ddd-accent)] text-[color:var(--ddd-fg-on-accent)] border-[color:var(--ddd-accent)] ' +
          'hover:bg-[var(--ddd-accent-hover)] hover:border-[color:var(--ddd-accent-hover)]',
      },
      // history (= .ddd-hist-btn): idle muted; active = selected bg, icon stays normal fg (no tint)
      { variant: 'history', active: false, class: 'bg-transparent text-[color:var(--ddd-fg-muted)]' },
      { variant: 'history', active: true, class: 'bg-[var(--ddd-surface-selected)] text-[color:var(--ddd-fg)]' },
      // zoom (toolbar/pan toggle): active = selected bg only, icon stays normal fg
      { variant: 'zoom', active: false, class: 'bg-transparent text-[color:var(--ddd-fg)]' },
      { variant: 'zoom', active: true, class: 'bg-[var(--ddd-surface-selected)] text-[color:var(--ddd-fg)]' },
    ],
    defaultVariants: { variant: 'secondary', active: false, off: false },
  },
);

export { buttonVariants };
export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

type NativeButtonProps = JSX.IntrinsicElements['button'];

export interface ButtonProps
  extends Omit<NativeButtonProps, 'size' | 'class'>,
    VariantProps<typeof buttonVariants> {
  /** Extra classes appended after the variant classes (additive escape hatch). */
  class?: string;
  children?: ComponentChildren;
}

/**
 * The single button primitive for the webview. Replaces the 7 hand-picked
 * `.ddd-*-btn` class families with a typed variant/size API. `size="icon"`
 * yields a square icon-only button (the former `.ddd-icon-btn`). Toggle state
 * is `active` (= .is-on/.is-active) / `off` (= .is-off). All native button
 * attributes (onClick, title, disabled, aria-*) pass through; type defaults to
 * "button".
 */
export function Button({
  variant,
  size,
  active,
  off,
  class: extra,
  type,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      class={cn(buttonVariants({ variant, size, active, off }), extra)}
      {...rest}
    >
      {children}
    </button>
  );
}
