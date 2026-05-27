/**
 * Exporter contract — shared between extension host and webview.
 *
 * `ExporterMeta` and friends are plain data and cross the postMessage boundary
 * (webview populates the export modal from these). `Exporter.export` is the impl
 * and only ever runs in the extension host.
 *
 * See specs/09-exporters.md for the architecture rationale.
 */

import type { QualifiedName, Schema } from '../types';

export type ExporterOptionField =
  | {
      id: string;
      type: 'boolean';
      label: string;
      default: boolean;
      description?: string;
    }
  | {
      id: string;
      type: 'string';
      label: string;
      default: string;
      description?: string;
    }
  | {
      id: string;
      type: 'enum';
      label: string;
      default: string;
      choices: Array<{ value: string; label: string }>;
      description?: string;
    };

export interface ExporterMeta {
  id: string;
  label: string;
  description?: string;
  language: string;
  optionsSchema: ExporterOptionField[];
}

export interface ExportInput {
  schema: Schema;
  scope: 'all' | 'selected';
  selection: ReadonlyArray<QualifiedName>;
  options: Record<string, unknown>;
}

export interface ExportResult {
  language: string;
  content: string;
  warnings?: string[];
}

export interface Exporter extends ExporterMeta {
  export(input: ExportInput): ExportResult;
}

export interface ExportCommandPayload {
  formatId: string;
  scope: 'all' | 'selected';
  selection: QualifiedName[];
  options: Record<string, unknown>;
}
