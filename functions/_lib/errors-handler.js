// Error inbox used by the admin panel + the game's crash reporter.
// Cloudflare port — same routes, shapes and status codes.
//   POST   /api/errors/report        (public, fire-and-forget from the app)
//   GET    /api/errors/inbox         (admin) → { logs: [...] } newest first
//   DELETE /api/errors/inbox         (admin) → clears all logs
//   PATCH  /api/errors/:id/resolve   (admin) → marks one log resolved
// Logs are capped (newest 200 kept) and field sizes are trimmed.
// Route files pass { report, inbox, resolve, id }; legacy ?report=1 /
// ?inbox=1 / ?resolve=1 / ?id= query forms are still honoured.
import { json, requireAdmin, parseJsonBody, newId } from './lib.js';
import { createStore } from './store.js';

const KEY = 'errors';
const MAX_LOGS = 200;

function clip(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

export async function handleErrors(context, route) {
  const { request, env } = context;
  const store = createStore(env.HSC_STORE);
  const method = request.method;
  const q = new URL(request.url).searchParams;
  const isReport = !!(route && route.report) || q.get('report') === '1';
  const isInbox = !!(route && route.inbox) || q.get('inbox') === '1';
  const isResolve = !!(route && route.resolve) || q.get('resolve') === '1';

  try {
    if (method === 'POST' && isReport) {
      const body = await parseJsonBody(request);
      if (!body || typeof body !== 'object') return json(400, { error: 'Invalid body' });
      const log = {
        id: newId(),
        errorType: clip(body.errorType, 200) || 'Error',
        errorMessage: clip(body.errorMessage, 1000),
        page: clip(body.page, 300),
        context: clip(body.context, 1000),
        stack: clip(body.stack, 4000),
        timestamp: new Date().toISOString(),
        resolved: false,
        resolvedAt: null,
      };
      const all = await store.getJSON(KEY, []);
      all.unshift(log);
      await store.setJSON(KEY, all.slice(0, MAX_LOGS));
      return json(201, { ok: true });
    }

    // Everything below is admin-only.
    const gate = requireAdmin(env, request);
    if (gate.error) return gate.error;

    if (method === 'GET' && isInbox) {
      const all = await store.getJSON(KEY, []);
      return json(200, { logs: all });
    }

    if (method === 'DELETE' && isInbox) {
      await store.setJSON(KEY, []);
      return json(200, { ok: true });
    }

    if (method === 'PATCH' && isResolve) {
      const id = q.get('id') || (route && route.id) || context.params.id || '';
      if (!id) return json(400, { error: 'Missing id' });
      const all = await store.getJSON(KEY, []);
      const log = all.find((l) => l.id === id);
      if (!log) return json(404, { error: 'Not found' });
      log.resolved = true;
      log.resolvedAt = new Date().toISOString();
      await store.setJSON(KEY, all);
      return json(200, { ok: true });
    }

    return json(404, { error: 'Not found' });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
}
