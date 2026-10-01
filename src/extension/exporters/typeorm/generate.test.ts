import { describe, expect, it } from 'vitest';
import { parseDbml } from '../../parser';
import { typeormExporter } from './index';

function exportDbml(src: string, options: Record<string, unknown> = {}) {
  const r = parseDbml(src);
  if (!r.schema) throw new Error(r.error.message);
  return typeormExporter.export({ schema: r.schema, scope: 'all', selection: [], options });
}

function propertyLine(content: string, prop: string): string {
  const lines = content.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s*"?${prop}"?[?!]:`).test(l));
  if (i < 1) throw new Error(`property ${prop} not found`);
  return lines[i - 1]!.trim();
}

describe('generateTypeOrm — column defaults follow the DBML default kind', () => {
  const { content } = exportDbml(`
    Table t {
      id int [pk]
      created timestamp [default: \`CURRENT_TIMESTAMP\`]
      nothing varchar [default: null]
      zip varchar [default: '00501']
      flag varchar [default: 'true']
      qty int [default: 5]
      active boolean [default: true]
      quote varchar [default: 'it\\'s']
      call varchar [default: 'now()']
    }
  `);

  it('emits backtick expressions as raw SQL', () => {
    expect(propertyLine(content, 'created')).toContain('default: () => "CURRENT_TIMESTAMP"');
  });
  it('omits a null default instead of emitting the string "null"', () => {
    expect(propertyLine(content, 'nothing')).not.toContain('default');
  });
  it('keeps numeric- and boolean-looking strings as string literals', () => {
    expect(propertyLine(content, 'zip')).toContain('default: "00501"');
    expect(propertyLine(content, 'flag')).toContain('default: "true"');
    expect(propertyLine(content, 'call')).toContain('default: "now()"');
  });
  it('emits numbers and booleans unquoted', () => {
    expect(propertyLine(content, 'qty')).toContain('default: 5');
    expect(propertyLine(content, 'active')).toContain('default: true');
  });
  it('escapes embedded quotes, which TypeORM does not do for string defaults', () => {
    expect(propertyLine(content, 'quote')).toContain(`default: () => "'it''s'"`);
  });
});

describe('generateTypeOrm — primary keys keep their DEFAULT', () => {
  it('emits the default on a non-increment primary column', () => {
    const { content } = exportDbml(`
      Table a { id uuid [pk, default: \`gen_random_uuid()\`] }
      Table b { code varchar [pk, default: 'x'] }
    `);
    expect(propertyLine(content, 'id')).toBe('@PrimaryColumn({ type: "uuid", default: () => "gen_random_uuid()" })');
    expect(propertyLine(content, 'code')).toBe('@PrimaryColumn({ type: "varchar", default: "x" })');
  });
});

function entityBlock(content: string, className: string): string {
  const start = content.indexOf(`export class ${className} {`);
  if (start < 0) throw new Error(`class ${className} not found`);
  return content.slice(start, content.indexOf('\n}', start));
}

describe('generateTypeOrm — one-to-one @JoinColumn sits on the FK holder', () => {
  const tables = `
    Table users { id int [pk] }
    Table profiles { id uuid [pk]
      user_id int`;

  it.each([
    ['inline ref', `${tables} [ref: - users.id] }`],
    ['standalone ref, FK side first', `${tables} }\nRef: profiles.user_id - users.id`],
    ['standalone ref, PK side first', `${tables} }\nRef: users.id - profiles.user_id`],
    ['unique FK column', `${tables} [unique] }\nRef: profiles.user_id - users.id`],
  ])('%s', (_label, src) => {
    const { content } = exportDbml(src);
    expect(entityBlock(content, 'Profile')).toContain('@JoinColumn({ name: "user_id" })');
    expect(entityBlock(content, 'User')).not.toContain('@JoinColumn');
  });

  it('falls back to the second endpoint for a shared-PK one-to-one', () => {
    const { content } = exportDbml(`
      Table users { id int [pk] }
      Table profiles { id int [pk] }
      Ref: profiles.id - users.id
    `);
    expect(entityBlock(content, 'User')).toContain('@JoinColumn({ name: "id" })');
    expect(entityBlock(content, 'Profile')).not.toContain('@JoinColumn');
  });
});

describe('generateTypeOrm — entities without a primary column', () => {
  it('emits a composite pk index as one @PrimaryColumn per member', () => {
    const { content, warnings } = exportDbml(`
      Table enrollments {
        student_id int
        course_id int
        indexes { (student_id, course_id) [pk] }
      }
    `);
    expect(propertyLine(content, 'student_id')).toBe('@PrimaryColumn({ type: "int" })');
    expect(propertyLine(content, 'course_id')).toBe('@PrimaryColumn({ type: "int" })');
    expect(warnings ?? []).toEqual([]);
  });

  it('warns when a table has no primary key, which TypeORM rejects at startup', () => {
    const { warnings } = exportDbml(`Table logs { msg text }`);
    expect(warnings).toEqual([expect.stringContaining('public.logs')]);
  });
});
