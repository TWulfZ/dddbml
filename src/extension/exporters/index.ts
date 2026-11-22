import { registerExporter } from './registry';
import { typeormExporter } from './typeorm';
import { postgresSqlExporter } from './postgresSql';

registerExporter(typeormExporter);
registerExporter(postgresSqlExporter);
// Future exporters: add a single registerExporter(...) line. See specs/09-exporters.md.

export { getExporter, listExporters } from './registry';
