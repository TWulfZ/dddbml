/**
 * Naming utilities for converting DBML table names into TypeORM-friendly identifiers.
 * Rules: see specs/09-exporters.md § Naming.
 */

const IRREGULAR_SINGULAR: Record<string, string> = {
  children: 'child',
  people: 'person',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  geese: 'goose',
  mice: 'mouse',
  teeth: 'tooth',
};

const SINGULAR_INVARIANT = new Set([
  'series',
  'species',
  'news',
  'data',
  'metadata',
  'media',
  'sheep',
  'fish',
  'deer',
]);

/**
 * Converts an identifier with separators (`_`, `-`, `.`, whitespace) to PascalCase.
 * Schema prefix `public.` is stripped; other schemas are preserved (`billing.invoices` → `BillingInvoices`).
 */
export function toPascalCase(input: string): string {
  let s = input.trim();
  if (s.startsWith('public.')) s = s.slice('public.'.length);
  const parts = s.split(/[\s_\-.]+/).filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

export function toCamelCase(input: string): string {
  const pascal = toPascalCase(input);
  if (pascal.length === 0) return pascal;
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Best-effort English singularization. Applied to the last word of a PascalCase token.
 * Returns the input unchanged when no rule matches.
 */
export function singularizeEnglish(word: string): string {
  if (word.length === 0) return word;
  const lower = word.toLowerCase();
  if (SINGULAR_INVARIANT.has(lower)) return word;
  if (IRREGULAR_SINGULAR[lower]) {
    return matchCase(IRREGULAR_SINGULAR[lower]!, word);
  }
  // (.+)ies → $1y
  const ies = /(.+)ies$/i.exec(word);
  if (ies) return ies[1] + 'y';
  // (.+s|ch|sh|x|z)es → $1
  const xes = /(.+(?:s|ch|sh|x|z))es$/i.exec(word);
  if (xes) return xes[1]!;
  // (.+)s → $1 (not "ss")
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function matchCase(target: string, source: string): string {
  if (source.length === 0) return target;
  const first = source.charAt(0);
  if (first === first.toUpperCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }
  return target;
}

/**
 * Split PascalCase into words (e.g. `OrderItems` → ['Order', 'Items']).
 * Used so singularize only affects the last segment.
 */
function splitPascalWords(pascal: string): string[] {
  if (pascal.length === 0) return [];
  const out: string[] = [];
  let buf = pascal.charAt(0);
  for (let i = 1; i < pascal.length; i++) {
    const ch = pascal.charAt(i);
    if (ch >= 'A' && ch <= 'Z') {
      out.push(buf);
      buf = ch;
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

export function toClassName(qualifiedName: string, opts: { singularize: boolean }): string {
  const pascal = toPascalCase(qualifiedName);
  if (!opts.singularize) return pascal;
  const words = splitPascalWords(pascal);
  if (words.length === 0) return pascal;
  words[words.length - 1] = singularizeEnglish(words[words.length - 1]!);
  return words.join('');
}

export function pluralize(word: string): string {
  if (word.length === 0) return word;
  const lower = word.toLowerCase();
  if (SINGULAR_INVARIANT.has(lower)) return word;
  if (/(s|ch|sh|x|z)$/i.test(word)) return word + 'es';
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}
