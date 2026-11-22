import type { Schema } from '../../shared/types';
import { useEffect, useState } from 'preact/hooks';
import { store, useAppStore } from '../state/store';
import { postToHost } from '../vscode';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Checkbox, TextField } from '../ui/Field';
import { RadioGroup } from '../ui/RadioGroup';
import { buildImageSvg, type ExportDerived, type ExportScope, type ExportSource } from '../export/imageExport';
import { blobToBase64, svgToPng } from '../export/raster';

interface ExportImageModalProps {
  schema: Schema;
  viewName?: string;
  /** `app.tsx`'s `derived` memo (group containers/collapsed nodes/effective refs). */
  derived: ExportDerived;
}

type ScaleKey = '1x' | '2x' | '3x';
const SCALE: Record<ScaleKey, number> = { '1x': 1, '2x': 2, '3x': 3 };

/**
 * Excalidraw-style "Export image" dialog. Builds a standalone SVG from the store model
 * (not the culled DOM — see imageExport.ts), then exports it as SVG, PNG, or clipboard.
 * Scope: whole diagram / current viewport / current selection. See specs/17-export-image.md.
 */
export function ExportImageModal({ schema, viewName, derived }: ExportImageModalProps) {
  const open = useAppStore((s) => s.exportImagePromptOpen);
  const selectionSize = useAppStore((s) => s.selection.size);

  const [scope, setScope] = useState<ExportScope>('all');
  const [scale, setScale] = useState<ScaleKey>('2x');
  const [background, setBackground] = useState(true);
  const [printerFriendly, setPrinterFriendly] = useState(false);
  const [includeProjectNote, setIncludeProjectNote] = useState(false);
  const [filename, setFilename] = useState('diagram');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setScope(selectionSize > 0 ? 'selection' : 'all');
    setScale('2x');
    setBackground(true);
    setPrinterFriendly(store.getState().settings.ui.diagramAppearance !== 'theme');
    setFilename('diagram');
    setIncludeProjectNote(store.getState().showProjectNote);
    setBusy(false);
    setNote(null);
  }, [open]);

  const hasSelection = selectionSize > 0;
  const allLabel = viewName ? `Named view (${viewName})` : 'Whole diagram';
  const scopeOptions: ReadonlyArray<{ value: ExportScope; label: string }> = hasSelection
    ? [{ value: 'all', label: allLabel }, { value: 'view', label: 'Current viewport' }, { value: 'selection', label: `Selection (${selectionSize})` }]
    : [{ value: 'all', label: allLabel }, { value: 'view', label: 'Current viewport' }];

  const gatherSource = (): ExportSource => {
    const s = store.getState();
    return {
      schema,
      positions: s.positions,
      tableColors: s.tableColors,
      edgeLayouts: s.edgeLayouts,
      selection: s.selection,
      density: s.settings.ui.density,
      showKeyColumn: s.settings.ui.showKeyColumn,
      labelLayouts: s.labelLayouts,
      editingPrintLayout: s.settings.ui.diagramAppearance !== 'theme',
      derived,
    };
  };

  const viewRect = (): { x: number; y: number; w: number; h: number } | undefined => {
    if (scope !== 'view') return undefined;
    const el = document.querySelector<HTMLElement>('.ddd-viewport');
    if (!el) return undefined;
    const vp = store.getState().viewport;
    const r = el.getBoundingClientRect();
    return { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: r.width / vp.zoom, h: r.height / vp.zoom };
  };

  const safeName = () => (filename.trim() || 'diagram').replace(/[\\/:*?"<>|]+/g, '_');

  const exportAs = async (kind: 'png' | 'svg' | 'copy') => {
    if (busy) return;
    setNote(null);
    // Busy first, then a frame, so the disabled state paints before the synchronous SVG build
    // (seconds on a large diagram) and a second click cannot start a second build.
    setBusy(true);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      const built = buildImageSvg(gatherSource(), {
        scope, background, filename: safeName(), viewRect: viewRect(), printerFriendly: kind === 'svg' && printerFriendly,
        includeProjectTitle: scope !== 'selection' && store.getState().showProjectTitle,
        includeProjectNote: scope === 'view' ? store.getState().showProjectNote : includeProjectNote,
      });
      if (!built) {
        setNote(scope === 'selection' ? 'Nothing selected to export.' : 'Nothing to export.');
        return;
      }
      if (kind === 'svg') {
        const base64 = await blobToBase64(new Blob([built.svg], { type: 'image/svg+xml' }));
        postToHost({ type: 'command:saveImage', payload: { dataBase64: base64, mime: 'image/svg+xml', suggestedName: `${safeName()}.svg` } });
        return;
      }
      const { blob, clamped, scale: effective } = await svgToPng(built.svg, built.width, built.height, SCALE[scale]);
      const reducedScale = Number(effective.toFixed(2));
      if (clamped) setNote('Diagram too large at this scale — exported at a reduced scale. Use SVG for full resolution.');
      if (kind === 'copy') {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          // Closing would hide the clamp warning, leaving a silently downscaled image on the clipboard.
          if (clamped) setNote(`Copied at ${reducedScale}× (reduced from ${SCALE[scale]}×). Use SVG for full resolution.`);
          else store.getState().setExportImagePromptOpen(false);
        } catch {
          // Clipboard image write unsupported/blocked → fall back to a host save.
          const base64 = await blobToBase64(blob);
          postToHost({ type: 'command:saveImage', payload: { dataBase64: base64, mime: 'image/png', suggestedName: `${safeName()}.png` } });
          setNote('Clipboard image not available — saving to a file instead.');
        }
        return;
      }
      const base64 = await blobToBase64(blob);
      // The dialog closes on a successful save, so the host's save notification carries the warning.
      postToHost({
        type: 'command:saveImage',
        payload: { dataBase64: base64, mime: 'image/png', suggestedName: `${safeName()}.png`, ...(clamped ? { reducedScale } : {}) },
      });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Export image"
      footer={
        <>
          <Button variant="primary" disabled={busy} onClick={() => void exportAs('png')}>PNG</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void exportAs('svg')}>SVG</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void exportAs('copy')}>Copy to clipboard</Button>
        </>
      }
    >
      <RadioGroup<ExportScope>
        label="Scope"
        hint="Whole diagram and named view exports include off-screen items."
        value={scope}
        options={scopeOptions}
        onChange={setScope}
      />
      <RadioGroup<ScaleKey>
        label="Scale"
        hint="Raster multiplier for PNG / clipboard (SVG is vector)."
        value={scale}
        options={[{ value: '1x', label: '1×' }, { value: '2x', label: '2×' }, { value: '3x', label: '3×' }]}
        onChange={setScale}
      />
      <Checkbox
        label="Background"
        hint="Include a solid background; off exports a transparent PNG."
        value={background}
        onCommit={setBackground}
      />
      <Checkbox
        label="Printer friendly"
        hint="SVG only. Uses a white page, full labels, and a PK/FK column."
        value={printerFriendly}
        onCommit={setPrinterFriendly}
      />
      {schema.project?.note && scope !== 'view' ? (
        <Checkbox label="Include project note" value={includeProjectNote} onCommit={setIncludeProjectNote} />
      ) : null}
      <TextField label="File name" value={filename} onCommit={setFilename} />
      {note ? <small class="ddd-field__hint">{note}</small> : null}
    </Modal>
  );
}

function close() {
  store.getState().setExportImagePromptOpen(false);
}
