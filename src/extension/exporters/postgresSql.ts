import type { Exporter } from '../../shared/exporters/types';
import { parseRequest } from '../parseService';

export const postgresSqlExporter: Exporter = {
  id: 'postgres-sql',
  label: 'PostgreSQL (SQL)',
  description: 'Save the full schema as a PostgreSQL DDL script.',
  language: 'sql',
  optionsSchema: [],
  fullSchemaOnly: true,
  async export({ dbmlSource, channel }) {
    if (dbmlSource === undefined) throw new Error('DBML source is unavailable.');
    const result = await parseRequest({ op: 'postgresSql', source: dbmlSource }, channel ?? 'export:postgres');
    if (!result) throw new Error('PostgreSQL export was interrupted.');
    if (!result.ok) throw new Error(result.message);
    return { language: 'sql', fileExtension: 'sql', content: result.sql };
  },
};
