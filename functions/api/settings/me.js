// GET /api/settings/me — tell the game whether the logged-in user is admin.
// The UI reads only the `isAdmin` field (admin gets unlimited AI tutor use).
import { verifyToken, getBearer, json, isAdminEmail } from '../../_lib/lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const token = getBearer(request);
  const payload = token ? verifyToken(env, token) : null;
  if (!payload) return json(401, { error: 'Unauthorized' });
  return json(200, { isAdmin: isAdminEmail(env, payload.email) });
}
