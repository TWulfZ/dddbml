import type { Exporter, ExporterMeta } from '../../shared/exporters/types';

const registry = new Map<string, Exporter>();

export function registerExporter(exporter: Exporter): void {
  registry.set(exporter.id, exporter);
}

export function getExporter(id: string): Exporter | undefined {
  return registry.get(id);
}

export function listExporters(): ExporterMeta[] {
  const out: ExporterMeta[] = [];
  for (const e of registry.values()) {
    out.push({
      id: e.id,
      label: e.label,
      description: e.description,
      language: e.language,
      optionsSchema: e.optionsSchema,
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}
