/**
 * Browser-side image optimization for the upload fields.
 *
 * An uploaded file is decoded, downscaled to fit `maxDimension`, and re-encoded as
 * WebP before it ever leaves the browser. The result is a `data:` URL that is both
 * what the preview shows and what the form submits — so a user sees the exact bytes
 * the server will store.
 *
 * This module touches the DOM, so it is only imported from `<script>` blocks (which
 * Vite bundles for the client); it must never be imported from server code.
 */

import {
  ALLOWED_IMAGE_TYPES,
  MAX_ENCODED_BYTES,
  base64PayloadBytes,
  type AllowedImageType,
} from './image.ts';

/** Reject absurd source files before we spend time decoding them. */
export const MAX_SOURCE_BYTES = 12_000_000;

export class ImageUploadError extends Error {}

export interface OptimizeOptions {
  maxDimension?: number;
  quality?: number;
  maxEncodedBytes?: number;
}

type Drawable = ImageBitmap | HTMLImageElement;

async function loadDrawable(file: File): Promise<Drawable> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new ImageUploadError('That file could not be read as an image.'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encode(source: Drawable, width: number, height: number, quality: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new ImageUploadError('This browser cannot process images.');
  context.drawImage(source, 0, 0, width, height);
  // Browsers without WebP encoding silently fall back to PNG, which the server also accepts.
  return canvas.toDataURL('image/webp', quality);
}

function release(source: Drawable): void {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
}

/**
 * Decode, downscale, and re-encode a file as a WebP data URL within `maxBytes`.
 * The scale is reduced until the encoded result fits, so the cap always holds.
 */
export async function optimizeImageFile(file: File, options: OptimizeOptions = {}): Promise<string> {
  const maxDimension = options.maxDimension ?? 512;
  const quality = options.quality ?? 0.85;
  const maxEncodedBytes = options.maxEncodedBytes ?? MAX_ENCODED_BYTES;

  if (!ALLOWED_IMAGE_TYPES.includes(file.type as AllowedImageType)) {
    throw new ImageUploadError('Choose a PNG, JPEG, or WebP image.');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImageUploadError(
      `That image is ${formatBytes(file.size)} — please pick one under ${formatBytes(MAX_SOURCE_BYTES)}.`,
    );
  }

  const source = await loadDrawable(file);
  try {
    const sourceWidth = 'width' in source ? source.width : 0;
    const sourceHeight = 'height' in source ? source.height : 0;
    if (!sourceWidth || !sourceHeight) throw new ImageUploadError('That image has no dimensions.');

    let scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const dataUrl = encode(source, width, height, quality);
      if (dataUrl.length <= maxEncodedBytes) return dataUrl;
      scale *= 0.75;
    }
    throw new ImageUploadError(
      `Could not shrink that image under ${formatBytes(maxEncodedBytes)}. Try a simpler image.`,
    );
  } finally {
    release(source);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ImageFieldHandlers {
  onError?: (message: string) => void;
  onStatus?: (message: string) => void;
}

/**
 * Wire a `[data-image-field]` container: a file input, an optional URL input, a
 * hidden value input (what the form submits), a preview image, and a clear button.
 *
 * A file selection is optimized and written to the hidden input; typing a URL
 * writes the URL instead. Both update the preview immediately.
 */
export function initImageField(root: HTMLElement, handlers: ImageFieldHandlers = {}): void {
  const fileInput = root.querySelector<HTMLInputElement>('[data-image-file]');
  const urlInput = root.querySelector<HTMLInputElement>('[data-image-url]');
  const valueInput = root.querySelector<HTMLInputElement>('[data-image-value]');
  const preview = root.querySelector<HTMLImageElement>('[data-image-preview]');
  const placeholder = root.querySelector<HTMLElement>('[data-image-placeholder]');
  const meta = root.querySelector<HTMLElement>('[data-image-meta]');
  const clearButton = root.querySelector<HTMLButtonElement>('[data-image-clear]');

  const maxDimension = Number(root.dataset.imageMax ?? 512);
  const quality = Number(root.dataset.imageQuality ?? 0.85);

  function render(value: string, metaText = '') {
    if (valueInput) valueInput.value = value;
    if (preview) {
      if (value) {
        preview.src = value;
        preview.classList.remove('hidden');
      } else {
        preview.removeAttribute('src');
        preview.classList.add('hidden');
      }
    }
    placeholder?.classList.toggle('hidden', Boolean(value));
    if (meta) meta.textContent = metaText;
    clearButton?.classList.toggle('hidden', !value);
  }

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    handlers.onStatus?.('Optimizing image…');
    try {
      const dataUrl = await optimizeImageFile(file, { maxDimension, quality });
      if (urlInput) urlInput.value = '';
      render(dataUrl, `Optimized to ${formatBytes(base64PayloadBytes(dataUrl) ?? 0)} (WebP)`);
      handlers.onStatus?.('Image ready — remember to save.');
    } catch (error) {
      fileInput.value = '';
      const message =
        error instanceof ImageUploadError ? error.message : 'Could not process that image.';
      handlers.onError?.(message);
      handlers.onStatus?.('');
    }
  });

  urlInput?.addEventListener('input', () => {
    const value = urlInput.value.trim();
    if (fileInput) fileInput.value = '';
    render(value, value ? 'Using the pasted URL' : '');
  });

  clearButton?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
    if (urlInput) urlInput.value = '';
    render('', '');
    handlers.onStatus?.('');
  });
}
