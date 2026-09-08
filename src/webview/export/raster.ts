/**
 * Rasterize an exported SVG to a PNG blob using an in-webview <canvas> — no heavy
 * dependency. The SVG is loaded as an <img> via a `data:` URL — the webview CSP allows
 * `img-src … data:` but NOT `blob:`, so a blob URL would be refused — then drawn onto a
 * canvas at the requested scale.
 *
 * Browsers cap canvas dimensions (~16384px/side, ~256MP area); a huge diagram at 3×
 * blows past that and `toBlob` returns null. `fitScale` clamps the effective scale and
 * reports it, so the modal can warn instead of producing a blank file. See specs/17.
 */

const MAX_DIM = 16384;
// 64 Mpx ≈ 256 MB of RGBA backing store — the previous 256 Mpx cap allowed ~1 GB plus a decoded
// <img> of the same size, enough to OOM the webview renderer on a large diagram.
const MAX_AREA = 64 * 1024 * 1024;

/**
 * Clamp `desired` scale so neither raster dimension exceeds MAX_DIM and total area
 * stays under MAX_AREA. Pure — unit-tested. `clamped` is true when it had to reduce.
 */
export function fitScale(width: number, height: number, desired: number): { scale: number; clamped: boolean } {
  if (width <= 0 || height <= 0) return { scale: desired, clamped: false };
  const maxByDim = Math.min(MAX_DIM / width, MAX_DIM / height);
  const maxByArea = Math.sqrt(MAX_AREA / (width * height));
  const max = Math.min(maxByDim, maxByArea);
  if (desired <= max) return { scale: desired, clamped: false };
  return { scale: Math.max(0.05, max), clamped: true };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load SVG for rasterization'));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null (image too large?)'))), 'image/png');
  });
}

/** Rasterize `svg` (with intrinsic `width`/`height`) to a PNG blob at `scale` (clamped). */
export async function svgToPng(
  svg: string,
  width: number,
  height: number,
  scale: number,
): Promise<{ blob: Blob; clamped: boolean }> {
  const { scale: s, clamped } = fitScale(width, height, scale);
  // Ensure webfonts are ready so <text> rasterizes with the intended glyphs, not fallbacks.
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch { /* non-fatal */ }
  }
  // data: URL (not blob:) so the webview CSP `img-src … data:` permits the load.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * s));
  canvas.height = Math.max(1, Math.round(height * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not acquire a 2D canvas context');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas);
  return { blob, clamped };
}

/** Base64 (no data-URL prefix) of a blob — for sending image bytes to the host over postMessage. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    fr.onerror = () => reject(fr.error ?? new Error('failed to read blob'));
    fr.readAsDataURL(blob);
  });
}
