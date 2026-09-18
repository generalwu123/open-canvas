import { LOCAL_UPLOAD_URL_PREFIX, readLocalUpload } from '@/lib/storage/local';

const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com';

const VIDEO_SYNTHESIS_PATH =
  '/api/v1/services/aigc/video-generation/video-synthesis';
const TASK_PATH = '/api/v1/tasks';
const COMPATIBLE_CHAT_PATH = '/compatible-mode/v1/chat/completions';
const IMAGE_GENERATION_PATH =
  '/api/v1/services/aigc/multimodal-generation/generation';

const SUPPORTED_RESOLUTIONS = new Set(['480P', '720P', '1080P']);
const SUPPORTED_RATIOS = new Set([
  'adaptive',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
]);

type DashScopeMediaType =
  | 'first_frame'
  | 'last_frame'
  | 'reference_image'
  | 'reference_video'
  | 'reference_audio';

interface DashScopeMediaItem {
  type: DashScopeMediaType;
  url: string;
}

function getBaseUrl(baseUrl: string) {
  const normalized = (baseUrl || '').trim() || DEFAULT_DASHSCOPE_BASE_URL;

  try {
    // Users often paste the OpenAI-compatible endpoint (used by other tools)
    // here; native DashScope paths need the scheme+host root instead.
    return new URL(normalized)
      .toString()
      .replace(/\/compatible-mode\/v1\/?$/, '/')
      .replace(/\/$/, '');
  } catch {
    throw new Error('DashScope base URL must be a valid URL');
  }
}

function getHeaders(apiKey: string) {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new Error('Missing DashScope (Bailian) API key');
  }

  return {
    Authorization: `Bearer ${normalizedApiKey}`,
    'Content-Type': 'application/json',
  };
}

function parseDashScopeError(payload: unknown, status: number) {
  if (payload && typeof payload === 'object') {
    const record = payload as {
      message?: unknown;
      code?: unknown;
      error?: { message?: unknown };
    };

    if (typeof record.error?.message === 'string' && record.error.message) {
      return record.error.message;
    }

    if (typeof record.message === 'string' && record.message) {
      return record.code
        ? `${String(record.code)}: ${record.message}`
        : record.message;
    }
  }

  return `DashScope request failed with status ${status}`;
}

function toStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }

  return value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
}

function buildMediaItems({
  options,
  scene,
}: {
  options: Record<string, unknown>;
  scene: string;
}): DashScopeMediaItem[] {
  const imageInputs = toStringArray(options.image_input);
  const videoInputs = toStringArray(options.video_input);
  const audioInputs = toStringArray(options.audio_input);
  const media: DashScopeMediaItem[] = [];

  if (videoInputs.length > 0) {
    // Video input is only ever a reference clip (edit / extend / restyle), so
    // everything is sent as omni reference media. The intent is carried by the
    // prompt. WAN3 caps: 5 clips, 10 images, 5 audio.
    for (const url of videoInputs.slice(0, 5)) {
      media.push({ type: 'reference_video', url });
    }
    for (const url of imageInputs.slice(0, 10)) {
      media.push({ type: 'reference_image', url });
    }
    for (const url of audioInputs.slice(0, 5)) {
      media.push({ type: 'reference_audio', url });
    }
    return media;
  }

  // Resolve the requested reference mode. "auto" (or empty) picks the most
  // natural mapping for an image-to-video node: a single still with no audio
  // becomes the first frame, anything else is treated as omni reference.
  const requestedMode =
    typeof options.wan_reference_mode === 'string'
      ? options.wan_reference_mode.trim()
      : '';
  let mode = requestedMode;
  if (scene === 'image-to-video' && (mode === '' || mode === 'auto')) {
    mode =
      imageInputs.length === 1 && audioInputs.length === 0
        ? 'first_frame'
        : 'omni_reference';
  }

  // Frame modes pin stills to the first/last frame. WAN3 forbids mixing
  // first_frame/last_frame with any reference_* media, so audio and extra
  // images are intentionally dropped here.
  if (
    scene === 'image-to-video' &&
    (mode === 'first_frame' || mode === 'first_last_frames')
  ) {
    if (imageInputs.length > 0) {
      media.push({ type: 'first_frame', url: imageInputs[0] });
    }
    if (mode === 'first_last_frames' && imageInputs.length > 1) {
      media.push({ type: 'last_frame', url: imageInputs[1] });
    }
    return media;
  }

  // Omni reference (and plain text-to-video) send a free mix of reference
  // media. Text-to-video simply has no inputs, so media stays empty.
  for (const url of imageInputs.slice(0, 10)) {
    media.push({ type: 'reference_image', url });
  }
  for (const url of audioInputs.slice(0, 5)) {
    media.push({ type: 'reference_audio', url });
  }

  return media;
}

const LOCAL_BASE64_MAX_BYTES = 7 * 1024 * 1024;

const LOCAL_IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

async function uploadLocalFileToDashScopeOss({
  apiKey,
  baseUrl,
  model,
  body,
  filename,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  body: Buffer;
  filename: string;
}): Promise<string> {
  const policyUrl = new URL('/api/v1/uploads', getBaseUrl(baseUrl));
  policyUrl.searchParams.set('action', 'getPolicy');
  policyUrl.searchParams.set('model', model);

  const policyRes = await fetch(policyUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!policyRes.ok) {
    throw new Error(
      `DashScope upload policy request failed with status ${policyRes.status}`
    );
  }

  const policyPayload = (await policyRes.json()) as {
    data?: Record<string, string>;
  };
  const policy = policyPayload.data;
  if (!policy?.upload_host || !policy?.upload_dir) {
    throw new Error('DashScope upload policy response is missing fields');
  }

  const objectKey = `${policy.upload_dir}/${filename}`;
  const form = new FormData();
  form.set('OSSAccessKeyId', policy.oss_access_key_id || '');
  form.set('Signature', policy.signature || '');
  form.set('policy', policy.policy || '');
  form.set('x-oss-object-acl', policy.x_oss_object_acl || '');
  form.set('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite || '');
  form.set('key', objectKey);
  form.set('success_action_status', '200');
  form.set(
    'file',
    new Blob([new Uint8Array(body)], { type: 'application/octet-stream' }),
    filename
  );

  const uploadRes = await fetch(policy.upload_host, {
    method: 'POST',
    body: form,
  });
  if (!uploadRes.ok) {
    throw new Error(
      `DashScope OSS upload failed with status ${uploadRes.status}`
    );
  }

  return `oss://${objectKey}`;
}

// Media produced by canvas uploads lives on this server's disk, which
// DashScope cannot fetch. Photos go inline as base64 (supported for images);
// anything larger or non-image is pushed to DashScope's temporary OSS space
// and referenced by the returned oss:// URL.
async function resolveMediaUrlForDashScope({
  url,
  apiKey,
  baseUrl,
  model,
}: {
  url: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}): Promise<string> {
  const trimmed = String(url || '').trim();
  if (!trimmed || !trimmed.startsWith(LOCAL_UPLOAD_URL_PREFIX)) {
    return trimmed;
  }

  const key =
    new URL(trimmed, 'http://localhost').searchParams.get('key') || '';
  const item = await readLocalUpload(key);
  if (!item) {
    throw new Error('Uploaded media file is missing on this server');
  }

  const ext = key.split('.').pop()?.toLowerCase() || '';
  const imageMime = LOCAL_IMAGE_MIME[ext];

  if (imageMime && item.body.byteLength <= LOCAL_BASE64_MAX_BYTES) {
    return `data:${imageMime};base64,${item.body.toString('base64')}`;
  }

  const filename = key.split('/').pop() || `upload.${ext || 'bin'}`;
  return uploadLocalFileToDashScopeOss({
    apiKey,
    baseUrl,
    model,
    body: item.body,
    filename,
  });
}

function buildParameters(options: Record<string, unknown>) {
  const parameters: Record<string, unknown> = {};

  const resolution =
    typeof options.resolution === 'string'
      ? options.resolution.trim().toUpperCase()
      : '';
  if (SUPPORTED_RESOLUTIONS.has(resolution)) {
    parameters.resolution = resolution;
  }

  const ratio =
    typeof options.aspect_ratio === 'string'
      ? options.aspect_ratio.trim().toLowerCase()
      : '';
  if (SUPPORTED_RATIOS.has(ratio)) {
    parameters.ratio = ratio;
  }

  const rawDuration = options.duration;
  const duration =
    typeof rawDuration === 'number'
      ? rawDuration
      : typeof rawDuration === 'string'
        ? Number(rawDuration)
        : Number.NaN;

  if (Number.isFinite(duration) && duration >= 2 && duration <= 30) {
    parameters.duration = Math.round(duration);
  }

  if (typeof options.seed === 'number' && Number.isFinite(options.seed)) {
    parameters.seed = Math.trunc(options.seed);
  }

  parameters.audio = options.audio === false ? false : true;
  parameters.prompt_extend = options.prompt_extend === false ? false : true;
  parameters.watermark = options.watermark === true;

  return parameters;
}

async function dashscopeJsonRequest<T>({
  apiKey,
  baseUrl,
  path,
  method = 'GET',
  body,
  extraHeaders,
}: {
  apiKey: string;
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  extraHeaders?: Record<string, string>;
}): Promise<T> {
  const response = await fetch(`${getBaseUrl(baseUrl)}${path}`, {
    method,
    headers: {
      ...getHeaders(apiKey),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(parseDashScopeError(payload, response.status));
  }

  return payload as T;
}

function mapTaskStatus(status: string | undefined) {
  if (status === 'SUCCEEDED') {
    return 'success' as const;
  }

  if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
    return 'error' as const;
  }

  return 'running' as const;
}

function extractVideoUrl(payload: unknown) {
  const output = (payload as { output?: Record<string, unknown> })?.output;
  if (!output) {
    return '';
  }

  if (typeof output.video_url === 'string' && output.video_url) {
    return output.video_url;
  }

  const results = output.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { url?: unknown }).url === 'string'
      ) {
        return (item as { url: string }).url;
      }
    }
  }

  return '';
}

export async function createDashScopeVideo({
  apiKey,
  baseUrl,
  model,
  prompt,
  options,
  scene,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  options: Record<string, unknown>;
  scene: string;
}) {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error('DashScope video nodes require a model name');
  }

  const normalizedPrompt = prompt.trim();
  const media = buildMediaItems({ options, scene });
  if (!normalizedPrompt && media.length === 0) {
    throw new Error('DashScope video node requires a prompt or media input');
  }

  const resolvedMedia = await Promise.all(
    media.map((item) =>
      resolveMediaUrlForDashScope({
        url: item.url,
        apiKey,
        baseUrl,
        model: normalizedModel,
      }).then((resolvedUrl) => ({ ...item, url: resolvedUrl }))
    )
  );

  const input: Record<string, unknown> = {};
  if (normalizedPrompt) {
    input.prompt = normalizedPrompt;
  }
  if (resolvedMedia.length > 0) {
    input.media = resolvedMedia;
  }

  const payload = await dashscopeJsonRequest<{
    output?: { task_id?: string; task_status?: string };
    message?: string;
    code?: string;
  }>({
    apiKey,
    baseUrl,
    path: VIDEO_SYNTHESIS_PATH,
    method: 'POST',
    extraHeaders: {
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: {
      model: normalizedModel,
      input,
      parameters: buildParameters(options),
    },
  });

  const taskId = payload.output?.task_id;
  if (!taskId) {
    throw new Error(
      payload.message || 'DashScope did not return a task id'
    );
  }

  return {
    predictionId: taskId,
    status: mapTaskStatus(payload.output?.task_status),
    outputMediaUrl: '',
  };
}

const IMAGE_SIZE_PRESETS: Record<string, number> = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
};

// DashScope rejects images whose total pixel count falls outside this range.
const IMAGE_MIN_PIXELS = 589824;
const IMAGE_MAX_PIXELS = 16777216;

// Extreme ratios at low presets (e.g. 21:9 at 1K -> 1024*448) land below the
// minimum, so scale both sides proportionally and re-round to the 64px grid
// until the request fits inside the accepted pixel range.
function clampImageSize(width: number, height: number) {
  let w = width;
  let h = height;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pixels = w * h;
    if (pixels >= IMAGE_MIN_PIXELS && pixels <= IMAGE_MAX_PIXELS) {
      return `${w}*${h}`;
    }
    const target =
      pixels < IMAGE_MIN_PIXELS ? IMAGE_MIN_PIXELS : IMAGE_MAX_PIXELS;
    const scale = Math.sqrt(target / pixels);
    const nextW = Math.max(64, Math.round((w * scale) / 64) * 64);
    const nextH = Math.max(64, Math.round((h * scale) / 64) * 64);
    if (nextW === w && nextH === h) {
      if (pixels < IMAGE_MIN_PIXELS) {
        h += 64;
      } else {
        h = Math.max(64, h - 64);
      }
      continue;
    }
    w = nextW;
    h = nextH;
  }
  return `${w}*${h}`;
}

// Wan image models accept either a resolution preset ("2K") or an explicit
// "width*height" size. Canvas nodes store resolution + aspect ratio, so
// translate those into the long-side-preserving size string the API expects.
// Qwen image-edit models reject preset strings and pick the output size
// themselves when "size" is omitted, so return "" to signal omission.
function buildImageSizeParameter(
  options: Record<string, unknown>,
  model: string
) {
  const isQwenEditModel = model.trim().startsWith('qwen-image-edit');
  const resolution =
    typeof options.resolution === 'string'
      ? options.resolution.trim().toUpperCase()
      : '';
  const preset = IMAGE_SIZE_PRESETS[resolution] ? resolution : '2K';

  const ratio =
    typeof options.aspect_ratio === 'string'
      ? options.aspect_ratio.trim()
      : '';
  if (!ratio || ratio === 'auto' || ratio === 'adaptive') {
    return isQwenEditModel ? '' : preset;
  }

  const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
  if (
    !Number.isFinite(ratioWidth) ||
    !Number.isFinite(ratioHeight) ||
    ratioWidth <= 0 ||
    ratioHeight <= 0
  ) {
    return preset;
  }

  const longSide = IMAGE_SIZE_PRESETS[preset];
  if (ratioWidth >= ratioHeight) {
    const shortSide = Math.max(
      64,
      Math.round((longSide * ratioHeight) / ratioWidth / 64) * 64
    );
    return clampImageSize(longSide, shortSide);
  }

  const shortSide = Math.max(
    64,
    Math.round((longSide * ratioWidth) / ratioHeight / 64) * 64
  );
  return clampImageSize(shortSide, longSide);
}

function extractImageUrls(payload: unknown) {
  const choices = (payload as { output?: { choices?: unknown } })?.output
    ?.choices;
  if (!Array.isArray(choices)) {
    return [] as string[];
  }

  const urls: string[] = [];
  for (const choice of choices) {
    const content = (choice as { message?: { content?: unknown } })?.message
      ?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const item of content) {
      const image = (item as { image?: unknown })?.image;
      if (typeof image === 'string' && image.trim()) {
        urls.push(image.trim());
      }
    }
  }

  return urls;
}

// Synchronous image generation through the multimodal-generation endpoint
// (wan2.7-image / wan2.7-image-pro / qwen-image-edit). Unlike video
// synthesis there is no async task, so the caller gets the final URL back.
export async function createDashScopeImage({
  apiKey,
  baseUrl,
  model,
  prompt,
  options,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  options: Record<string, unknown>;
}) {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error('DashScope image nodes require a model name');
  }

  const normalizedPrompt = prompt.trim();
  const imageInputs = toStringArray(options.image_input).slice(0, 3);
  if (!normalizedPrompt && imageInputs.length === 0) {
    throw new Error('DashScope image node requires a prompt or image input');
  }

  const resolvedImages = await Promise.all(
    imageInputs.map((url) =>
      resolveMediaUrlForDashScope({
        url,
        apiKey,
        baseUrl,
        model: normalizedModel,
      })
    )
  );

  const content: Array<Record<string, string>> = [];
  if (normalizedPrompt) {
    content.push({ text: normalizedPrompt });
  }
  for (const image of resolvedImages) {
    content.push({ image });
  }

  const sizeParameter = buildImageSizeParameter(options, normalizedModel);
  const parameters: Record<string, unknown> = {
    n: 1,
    watermark: options.watermark === true,
    thinking_mode: options.thinking_mode === false ? false : true,
  };
  if (sizeParameter) {
    parameters.size = sizeParameter;
  }

  const payload = await dashscopeJsonRequest<{
    output?: { choices?: unknown; code?: unknown; message?: unknown };
    code?: string;
    message?: string;
  }>({
    apiKey,
    baseUrl,
    path: IMAGE_GENERATION_PATH,
    method: 'POST',
    extraHeaders: {
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: {
      model: normalizedModel,
      input: {
        messages: [{ role: 'user', content }],
      },
      parameters,
    },
  });

  const images = extractImageUrls(payload);
  if (images.length === 0) {
    throw new Error('DashScope image generation returned no images');
  }

  return {
    predictionId: '',
    status: 'success' as const,
    outputMediaUrl: images[0],
    allImageUrls: images,
  };
}

export async function queryDashScopeTask({
  apiKey,
  baseUrl,
  taskId,
}: {
  apiKey: string;
  baseUrl: string;
  taskId: string;
}) {
  const payload = await dashscopeJsonRequest<{
    output?: {
      task_id?: string;
      task_status?: string;
      code?: string;
      message?: string;
      video_url?: string;
    };
  }>({
    apiKey,
    baseUrl,
    path: `${TASK_PATH}/${encodeURIComponent(taskId)}`,
  });

  const output = payload.output || {};
  const status = mapTaskStatus(output.task_status);

  return {
    predictionId: output.task_id || taskId,
    status,
    outputMediaUrl: status === 'success' ? extractVideoUrl(payload) : '',
    errorMessage:
      status === 'error'
        ? [output.code, output.message].filter(Boolean).join(': ') ||
          'DashScope video generation failed'
        : '',
  };
}

export async function runDashScopeText({
  apiKey,
  baseUrl,
  model,
  prompt,
  contextText,
  imageUrls,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  contextText: string[];
  imageUrls: string[];
}) {
  const normalizedModel = model.trim();
  if (!normalizedModel) {
    throw new Error('Text node requires a Bailian text model');
  }

  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    throw new Error('Text node requires a prompt');
  }

  const userMessage = [
    contextText.length > 0
      ? `Upstream context:\n${contextText.join('\n\n---\n\n')}`
      : '',
    normalizedPrompt,
  ]
    .filter(Boolean)
    .join('\n\n');

  const payload = await dashscopeJsonRequest<{
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: string };
  }>({
    apiKey,
    baseUrl,
    path: COMPATIBLE_CHAT_PATH,
    method: 'POST',
    body: {
      model: normalizedModel,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userMessage },
            ...imageUrls.map((url) => ({
              type: 'image_url',
              image_url: { url },
            })),
          ],
        },
      ],
    },
  });

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('DashScope text endpoint returned an empty response');
  }

  return {
    text: content.trim(),
    payload,
  };
}
