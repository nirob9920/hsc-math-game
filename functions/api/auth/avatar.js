// GET /api/auth/avatar — proxy the user's Google profile picture.
// The game fetches this with its Bearer token and turns the response into
// an object URL. Any failure is fine: the UI falls back to an initial letter.
import { verifyToken, getBearer, json } from '../../_lib/lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = getBearer(request);
  const payload = token ? verifyToken(env, token) : null;
  if (!payload) return json(401, { error: 'Unauthorized' });
  if (!payload.picture) return json(404, { error: 'No avatar' });
  try {
    const res = await fetch(payload.picture);
    if (!res.ok) return json(404, { error: 'No avatar' });
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (e) {
    return json(404, { error: 'No avatar' });
  }
}
