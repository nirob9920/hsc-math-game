// Catch-all for /api/* paths that have no backend yet.
// Keeps them returning a JSON 404 (instead of the SPA's index.html),
// so unimplemented features fail the same way they did before.
import { json } from '../_lib/lib.js';

export async function onRequest() {
  return json(404, { error: 'Not found' });
}
