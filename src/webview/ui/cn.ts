import { clsx, type ClassValue } from 'clsx';

/**
 * Join class names (the shadcn `cn` helper, minus tailwind-merge). Variants are
 * authored conflict-free — idle/active looks live in mutually-exclusive
 * `compoundVariants`, so no two utilities ever target the same property on one
 * element. That removes the need for tailwind-merge (~15KB gzip) purely to
 * dedupe; `clsx` flattening conditional/array inputs is enough.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
