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
  quizzes: 'quiz',
  // Plurals of -u words, which the -us guard below would otherwise keep as-is.
  menus: 'menu',
  skus: 'sku',
  gurus: 'guru',
};

/** -ie nouns whose plural would otherwise fall into the `ies → y` rule. */
const IE_NOUNS = new Set([
  'movie',
  'cookie',
  'zombie',
  'calorie',
  'rookie',
  'selfie',
  'hoodie',
  'genie',
  'prairie',
  'smoothie',
  'brownie',
  'goalie',
  'newbie',
  'sortie',
]);

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
  if (/ies$/i.test(word)) {
    // ties, pies, lies: a single letter before `ies` means the singular ends in -ie.
    if (word.length <= 4 || IE_NOUNS.has(lower.slice(0, -1))) return word.slice(0, -1);
    return word.slice(0, -3) + 'y';
  }
  // Sibilant plurals take -es: addresses, boxes, matches, quizzes, statuses.
  const sibilant = /(.+(?:ss|sh|ch|x|zz|us))es$/i.exec(word);
  if (sibilant) return sibilant[1]!;
  // status, campus, analysis, class are already singular.
  if (/(?:us|is|ss)$/i.test(word)) return word;
  // courses, purchases, sizes: the singular ends in -e, so only the s goes.
  if (/s$/i.test(word)) return word.slice(0, -1);
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
  if (!opts.singularize) return toIdentifier(pascal);
  const words = splitPascalWords(pascal);
  if (words.length === 0) return toIdentifier(pascal);
  words[words.length - 1] = singularizeEnglish(words[words.length - 1]!);
  return toIdentifier(words.join(''));
}

const IDENT = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

export function isIdentifier(s: string): boolean {
  return IDENT.test(s);
}

function toIdentifier(s: string): string {
  const cleaned = s.replace(/[^\p{ID_Continue}$‌‍]/gu, '');
  return /^[\p{ID_Start}$_]/u.test(cleaned) ? cleaned : `_${cleaned}`;
}

/** Not toPascalCase-based: re-splitting on `_` would drop the prefix that keeps `_2faCode` valid. */
export function lowerFirst(identifier: string): string {
  return identifier.charAt(0).toLowerCase() + identifier.slice(1);
}

export function pluralize(word: string): string {
  if (word.length === 0) return word;
  const lower = word.toLowerCase();
  if (SINGULAR_INVARIANT.has(lower)) return word;
  if (/(s|ch|sh|x|z)$/i.test(word)) return word + 'es';
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}
