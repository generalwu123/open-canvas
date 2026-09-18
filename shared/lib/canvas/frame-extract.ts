// Extract a still frame from a canvas video by decoding it in an offscreen
// <video> element and drawing the requested timestamp to a canvas.

export type CanvasFrameTarget = 'current' | 'last';

const FRAME_SEEK_TIMEOUT_MS = 15000;

async function fetchVideoBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`video fetch failed with status ${response.status}`);
  }
  return response.blob();
}

function waitForEvent(
  element: HTMLVideoElement,
  name: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`video ${name} timed out`));
    }, timeoutMs);
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`video ${name} failed`));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      element.removeEventListener(name, onDone);
      element.removeEventListener('error', onError);
    };
    element.addEventListener(name, onDone, { once: true });
    element.addEventListener('error', onError, { once: true });
  });
}

function drawFrameToBlob(
  video: HTMLVideoElement,
  label: string
): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) {
    return Promise.reject(new Error('video has no decoded frame'));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    return Promise.reject(new Error('canvas 2d context unavailable'));
  }
  context.drawImage(video, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error(`frame encode failed for ${label}`));
      }
    }, 'image/png');
  });
}

export async function extractCanvasVideoFrame({
  url,
  target,
  currentTime,
}: {
  url: string;
  target: CanvasFrameTarget;
  currentTime?: number;
}): Promise<Blob> {
  const blobUrl = URL.createObjectURL(await fetchVideoBlob(url));
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = blobUrl;

  try {
    await waitForEvent(video, 'loadedmetadata', FRAME_SEEK_TIMEOUT_MS);

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    let seekTo = 0;
    if (target === 'last') {
      seekTo = duration > 0.1 ? duration - 0.05 : 0;
    } else if (
      typeof currentTime === 'number' &&
      Number.isFinite(currentTime) &&
      currentTime > 0
    ) {
      seekTo = duration > 0 ? Math.min(currentTime, Math.max(duration - 0.05, 0)) : currentTime;
    }

    if (seekTo > 0) {
      video.currentTime = seekTo;
      await waitForEvent(video, 'seeked', FRAME_SEEK_TIMEOUT_MS);
    } else {
      await waitForEvent(video, 'loadeddata', FRAME_SEEK_TIMEOUT_MS);
    }

    return await drawFrameToBlob(video, target);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(blobUrl);
  }
}
