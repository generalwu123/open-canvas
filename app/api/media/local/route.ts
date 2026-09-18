import { readLocalUpload } from '@/lib/storage/local';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const item = await readLocalUpload(key);

  if (!item) {
    return new Response('Not found', { status: 404 });
  }

  return new Response(new Uint8Array(item.body), {
    headers: {
      'Content-Type': item.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
