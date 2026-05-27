import { registerExporter } from './registry';
import { typeormExporter } from './typeorm';

registerExporter(typeormExporter);
// Future exporters: add a single registerExporter(...) line. See specs/09-exporters.md.

export { getExporter, listExporters } from './registry';
