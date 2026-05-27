import type { Exporter } from '../../../shared/exporters/types';
import './dialects'; // register built-in dialects
import { listDialects } from './dialect';
import { generateTypeOrm } from './generate';

function dialectChoices() {
  const all = listDialects();
  if (all.length === 0) return [{ value: 'postgres', label: 'PostgreSQL' }];
  return all.map((d) => ({ value: d.id, label: d.label }));
}

export const typeormExporter: Exporter = {
  id: 'typeorm',
  label: 'TypeORM (TypeScript)',
  description: 'Generate TypeORM @Entity classes for the selected SQL dialect.',
  language: 'typescript',
  optionsSchema: [
    {
      id: 'dialect',
      type: 'enum',
      label: 'SQL dialect',
      default: 'postgres',
      choices: dialectChoices(),
      description: 'Drives DBML→TypeScript type mapping and @Column type strings.',
    },
    {
      id: 'singularize',
      type: 'boolean',
      label: 'Singularize class names (English)',
      default: true,
      description: 'Turn `order_items` into `OrderItem` instead of `OrderItems`.',
    },
    {
      id: 'includeImports',
      type: 'boolean',
      label: 'Include typeorm imports',
      default: true,
      description: "Emit `import { Entity, Column, ... } from 'typeorm'` at the top.",
    },
    {
      id: 'emitNullableExplicit',
      type: 'boolean',
      label: 'Emit nullable explicitly',
      default: true,
      description: 'Always include `nullable: true/false` in @Column options.',
    },
  ],
  export: generateTypeOrm,
};
