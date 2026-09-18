import fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  StorageDownloadUploadOptions,
  StorageProvider,
  StorageUploadOptions,
  StorageUploadResult,
} from './core';

export const LOCAL_UPLOAD_URL_PREFIX = '/api/media/local';

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

function resolveUploadDir() {
  const fromEnv = String(process.env.CANVAS_UPLOAD_DIR || '').trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  // Inside the container this lands on the persisted /app/data volume; in dev
  // it lands in <repo>/data so uploads survive restarts either way.
  return path.resolve(path.join(process.cwd(), 'data', 'uploads'));
}

const UPLOAD_DIR = resolveUploadDir();

export function getLocalUploadDir() {
  return UPLOAD_DIR;
}

function safeKeyPath(key: string) {
  const cleaned = String(key || '').replace(/^\/+/, '');
  if (!cleaned) {
    return null;
  }

  const root = path.resolve(UPLOAD_DIR);
  const full = path.resolve(root, cleaned);
  if (full !== root && !full.startsWith(root + path.sep)) {
    return null;
  }

  return full;
}

export function localUploadUrl(key: string) {
  return `${LOCAL_UPLOAD_URL_PREFIX}?key=${encodeURIComponent(key)}`;
}

export async function readLocalUpload(
  key: string
): Promise<{ body: Buffer; contentType: string } | null> {
  const full = safeKeyPath(key);
  if (!full) {
    return null;
  }

  try {
    const body = await fsp.readFile(full);
    const ext = path.extname(full).slice(1).toLowerCase();
    return {
      body,
      contentType: EXT_MIME[ext] || 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';

  async exists({ key }: { key: string; bucket?: string }) {
    const full = safeKeyPath(key);
    if (!full) {
      return false;
    }

    try {
      await fsp.stat(full);
      return true;
    } catch {
      return false;
    }
  }

  getPublicUrl({ key }: { key: string; bucket?: string }) {
    return localUploadUrl(key);
  }

  async uploadFile(options: StorageUploadOptions): Promise<StorageUploadResult> {
    const full = safeKeyPath(options.key);
    if (!full) {
      return {
        success: false,
        provider: this.name,
        error: 'Invalid upload key',
      };
    }

    try {
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, options.body);
      return {
        success: true,
        provider: this.name,
        key: options.key,
        url: localUploadUrl(options.key),
      };
    } catch (error) {
      return {
        success: false,
        provider: this.name,
        error:
          error instanceof Error ? error.message : 'Local upload failed',
      };
    }
  }

  async downloadAndUpload(options: StorageDownloadUploadOptions) {
    try {
      const res = await fetch(options.url);
      if (!res.ok) {
        return {
          success: false,
          provider: this.name,
          error: `Download failed with status ${res.status}`,
        };
      }

      const body = new Uint8Array(await res.arrayBuffer());
      return this.uploadFile({ ...options, body });
    } catch (error) {
      return {
        success: false,
        provider: this.name,
        error: error instanceof Error ? error.message : 'Local upload failed',
      };
    }
  }
}
