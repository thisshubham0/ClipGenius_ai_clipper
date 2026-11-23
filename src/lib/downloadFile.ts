import { apiFetch } from './apiClient';
import { isPlayableDownloadContentType } from './exportFormats';
import type { ExportContainerFormat } from '../types/clipgenius';

export interface DownloadExportFileOptions {
  url: string;
  filename: string;
  kind: 'mp4' | 'batch_zip';
  containerFormat?: ExportContainerFormat;
  onProgress?: (pct: number) => void;
}

export interface DownloadExportFileResult {
  bytesDownloaded: number;
  contentType: string;
}

/**
 * Downloads a rendered video/audio/GIF/ZIP export via authenticated fetch() -> verified Blob
 * -> object URL anchor trigger.
 *
 * Unlike bare <a href="/api/..."> links, this works reliably inside sandboxed iframes,
 * reports real byte download progress, and refuses to save an HTML or JSON error page
 * as a corrupt .mp4 file.
 */
export async function downloadExportFile(
  options: DownloadExportFileOptions
): Promise<DownloadExportFileResult> {
  const { url, filename, kind, containerFormat = 'mp4', onProgress } = options;

  onProgress?.(2);
  const res = await apiFetch(url, { method: 'GET' });

  const contentType = res.headers.get('Content-Type') || '';
  if (!res.ok) {
    let errText = `Download failed (HTTP ${res.status}).`;
    if (contentType.includes('application/json')) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (json.error) errText = json.error;
    }
    throw new Error(errText);
  }

  if (!isPlayableDownloadContentType(contentType, kind, containerFormat)) {
    throw new Error(
      `Server returned unexpected content type (${contentType || 'unknown'}) instead of a playable file. Try rendering again.`
    );
  }

  const totalBytes = Number(res.headers.get('Content-Length') || 0);
  let blob: Blob;

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const copy = new Uint8Array(value.byteLength);
        copy.set(value);
        chunks.push(copy);
        received += value.byteLength;
        if (totalBytes > 0) {
          onProgress?.(Math.min(99, Math.max(5, Math.round((received / totalBytes) * 100))));
        }
      }
    }

    blob = new Blob(chunks, {
      type: contentType.split(';')[0].trim() || 'application/octet-stream',
    });
  } else {
    blob = await res.blob();
  }

  if (blob.size < 64) {
    throw new Error('Downloaded file is empty. Please re-render the clip and try again.');
  }

  onProgress?.(100);

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 60_000);

  return {
    bytesDownloaded: blob.size,
    contentType: blob.type || contentType,
  };
}
