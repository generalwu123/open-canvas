import { cookies } from 'next/headers';

import {
  normalizeProviderSettings,
  validateProviderSettings,
} from '@/lib/provider-settings';
import type { ProviderSettings } from '@/lib/types';

export const PROVIDER_SETTINGS_COOKIE = 'open_canvas_provider_settings';

function encodeBase64Url(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function serializeProviderSettingsCookie(settings: ProviderSettings) {
  return encodeBase64Url(JSON.stringify(normalizeProviderSettings(settings)));
}

export function parseProviderSettingsCookie(value: string | undefined | null) {
  if (!value) {
    return normalizeProviderSettings(null);
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(value)) as Partial<ProviderSettings>;
    return normalizeProviderSettings(parsed);
  } catch {
    return normalizeProviderSettings(null);
  }
}

export async function readProviderSettingsFromCookie() {
  const cookieStore = await cookies();
  const value = cookieStore.get(PROVIDER_SETTINGS_COOKIE)?.value;
  const settings = parseProviderSettingsCookie(value);
  return applyServerEnvFallback(settings);
}

/**
 * Server-side fallback so a fresh browser (or a different origin) can upload
 * and generate without opening the settings dialog first: env-provided keys
 * fill in blanks left by the cookie, and the storage provider falls back to
 * the built-in local disk provider.
 */
function applyServerEnvFallback(settings: ProviderSettings): ProviderSettings {
  const envBailianKey = String(process.env.BAILIAN_API_KEY || '').trim();
  const envBailianBaseUrl = String(process.env.BAILIAN_BASE_URL || '').trim();

  const next: ProviderSettings = { ...settings };
  if (!next.bailianApiKey.trim() && envBailianKey) {
    next.bailianApiKey = envBailianKey;
  }
  if (!next.bailianBaseUrl.trim() && envBailianBaseUrl) {
    next.bailianBaseUrl = envBailianBaseUrl;
  }
  if (!next.storageProvider || next.storageProvider === 'disabled') {
    next.storageProvider = 'local';
  }
  return next;
}

export async function writeProviderSettingsCookie(settings: ProviderSettings) {
  const cookieStore = await cookies();
  const normalized = normalizeProviderSettings(settings);
  const validation = validateProviderSettings(normalized);
  if (!validation.success) {
    throw validation.error;
  }

  cookieStore.set(PROVIDER_SETTINGS_COOKIE, serializeProviderSettingsCookie(normalized), {
    httpOnly: false,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}
