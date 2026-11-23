// GET /api/auth/me — return the current user for a Bearer session token.
// The game sends Authorization: Bearer <token> and uses the JSON body
// directly as its user object.
import { verifyToken, getBearer, json, userFromPayload } from '../../_lib/lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = getBearer(request);
  const payload = token ? verifyToken(env, token) : null;
  if (!payload) return json(401, { error: 'Unauthorized' });
  return json(200, userFromPayload(env, payload));
}
