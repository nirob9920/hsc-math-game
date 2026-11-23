// GET /api/cq/image/:id — serve a CQ's stem image (public; used as <img src>).
import { json } from '../../../_lib/lib.js';
import { createStore } from '../../../_lib/store.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const q = new URL(request.url).searchParams;
  const id = q.get('id') || context.params.id || '';
  try {
    const store = createStore(env.HSC_STORE);
    const img = await store.getBinary('cq-image:' + id);
    if (!img) return json(404, { error: 'Not found' });
    return new Response(img.buffer, {
      status: 200,
      headers: {
        'Content-Type': img.contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    return json(404, { error: 'Not found' });
  }
}
