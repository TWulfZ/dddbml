import { cn } from './cn';
import { IconSearch } from '../icons';

/** Search input with a leading icon (= legacy `.ddd-search`). Wraps the classes. */
export interface SearchProps {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  class?: string;
}

export function Search({ value, onInput, placeholder, class: extra }: SearchProps) {
  return (
    <label class={cn('ddd-search', extra)}>
      <span class="ddd-search__icon">
        <IconSearch size={12} />
      </span>
      <input
        class="ddd-search__input"
        type="text"
        placeholder={placeholder}
        value={value}
        onInput={(e) => onInput((e.currentTarget as HTMLInputElement).value)}
      />
    </label>
  );
}
