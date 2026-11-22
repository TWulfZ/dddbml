import * as vscode from 'vscode';
import type { Schema } from '../shared/types';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const imageTypes: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export function projectImageUri(dbml: vscode.Uri, filename: string): vscode.Uri | undefined {
  if (filename.trim() !== filename || /[/\\:\x00-\x1f]/.test(filename)) return undefined;
  const extension = /\.([a-z]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if (!extension || !Object.hasOwn(imageTypes, extension) || filename.length <= extension.length + 1) return undefined;
  return vscode.Uri.joinPath(dbml, '..', filename);
}

async function imageDataUri(dbml: vscode.Uri, filename: string): Promise<string | undefined> {
  const uri = projectImageUri(dbml, filename);
  if (!uri) return undefined;
  const mime = imageTypes[filename.split('.').at(-1)!.toLowerCase()];
  try {
    const info = await vscode.workspace.fs.stat(uri);
    if (info.type !== vscode.FileType.File || info.size === 0 || info.size > MAX_IMAGE_BYTES) return undefined;
    const data = await vscode.workspace.fs.readFile(uri);
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) return undefined;
    return `data:${mime};base64,${Buffer.from(data).toString('base64')}`;
  } catch {
    return undefined;
  }
}

export function diagramImageFiles(schema: Schema): string[] {
  return [
    ...(schema.project?.images ?? []).map((image) => image.filename),
    ...(schema.architecture?.nodes ?? []).flatMap((node) => node.icon && !node.icon.startsWith('data:') ? [node.icon] : []),
  ];
}

export async function loadDiagramImages(dbml: vscode.Uri, schema: Schema): Promise<Schema> {
  const files = new Set(diagramImageFiles(schema));
  if (!files.size) return schema;
  const resolved = new Map(await Promise.all([...files].map(async (filename) => [filename, await imageDataUri(dbml, filename)] as const)));
  const result = { ...schema };
  if (schema.project?.images?.length) {
    result.project = { ...schema.project, images: schema.project.images.map((image) => ({
      ...image, ...(resolved.get(image.filename) ? { dataUri: resolved.get(image.filename) } : {}),
    })) };
  }
  if (schema.architecture) {
    result.architecture = { ...schema.architecture, nodes: schema.architecture.nodes.map((node) => ({
      ...node, icon: node.icon ? resolved.get(node.icon) ?? node.icon : undefined,
    })) };
  }
  return result;
}
