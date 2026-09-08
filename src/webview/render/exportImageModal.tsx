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
export function ExportImageModal({ derived }: ExportImageModalProps) {
  const open = useAppStore((s) => s.exportImagePromptOpen);
  const selectionSize = useAppStore((s) => s.selection.size);

  const [scope, setScope] = useState<ExportScope>('all');
  const [scale, setScale] = useState<ScaleKey>('2x');
  const [background, setBackground] = useState(true);
  const [filename, setFilename] = useState('diagram');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setScope(selectionSize > 0 ? 'selection' : 'all');
    setScale('2x');
    setBackground(true);
    setFilename('diagram');
    setBusy(false);
    setNote(null);
  }, [open]);

  const hasSelection = selectionSize > 0;
  const scopeOptions: ReadonlyArray<{ value: ExportScope; label: string }> = hasSelection
    ? [{ value: 'all', label: 'Whole diagram' }, { value: 'view', label: 'Current view' }, { value: 'selection', label: `Selection (${selectionSize})` }]
    : [{ value: 'all', label: 'Whole diagram' }, { value: 'view', label: 'Current view' }];

  const gatherSource = (): ExportSource => {
    const s = store.getState();
    return {
      schema: s.schema,
      positions: s.positions,
      tableColors: s.tableColors,
      edgeLayouts: s.edgeLayouts,
      selection: s.selection,
      density: s.settings.ui.density,
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

  const build = () => buildImageSvg(gatherSource(), { scope, background, filename: safeName(), viewRect: viewRect() });

  const exportAs = async (kind: 'png' | 'svg' | 'copy') => {
    if (busy) return;
    setNote(null);
    const built = build();
    if (!built) {
      setNote(scope === 'selection' ? 'Nothing selected to export.' : 'Nothing to export.');
      return;
    }
    setBusy(true);
    try {
      if (kind === 'svg') {
        const base64 = await blobToBase64(new Blob([built.svg], { type: 'image/svg+xml' }));
        postToHost({ type: 'command:saveImage', payload: { dataBase64: base64, mime: 'image/svg+xml', suggestedName: `${safeName()}.svg` } });
        return;
      }
      const { blob, clamped } = await svgToPng(built.svg, built.width, built.height, SCALE[scale]);
      if (clamped) setNote('Diagram too large at this scale — exported at a reduced scale. Use SVG for full resolution.');
      if (kind === 'copy') {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          store.getState().setExportImagePromptOpen(false);
        } catch {
          // Clipboard image write unsupported/blocked → fall back to a host save.
          const base64 = await blobToBase64(blob);
          postToHost({ type: 'command:saveImage', payload: { dataBase64: base64, mime: 'image/png', suggestedName: `${safeName()}.png` } });
          setNote('Clipboard image not available — saving to a file instead.');
        }
        return;
      }
      const base64 = await blobToBase64(blob);
      postToHost({ type: 'command:saveImage', payload: { dataBase64: base64, mime: 'image/png', suggestedName: `${safeName()}.png` } });
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
        hint="Whole diagram is built from the model, so off-screen tables are included."
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
      <TextField label="File name" value={filename} onCommit={setFilename} />
      {note ? <small class="ddd-field__hint">{note}</small> : null}
    </Modal>
  );
}

function close() {
  store.getState().setExportImagePromptOpen(false);
}
