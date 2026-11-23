// /api/settings/features — feature flags for the game.
//   GET → { rag_enabled, student_view_enabled, mcq_extract_enabled }
//         (public: the books page reads it for students/guests too)
//   PUT { key, value } → { flags: {...} }  (admin only)
import { json, requireAdmin, parseJsonBody } from '../../_lib/lib.js';
import { createStore } from '../../_lib/store.js';

const KEY = 'features';
const DEFAULTS = {
  rag_enabled: true,
  student_view_enabled: true,
  mcq_extract_enabled: true,
};

async function readFlags(store) {
  const stored = await store.getJSON(KEY, {});
  return Object.assign({}, DEFAULTS, stored);
}

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const store = createStore(env.HSC_STORE);
    if (request.method === 'GET') {
      return json(200, await readFlags(store));
    }

    if (request.method === 'PUT') {
      const gate = requireAdmin(env, request);
      if (gate.error) return gate.error;
      const body = await parseJsonBody(request);
      if (!body || typeof body.key !== 'string' || !(body.key in DEFAULTS)) {
        return json(400, { error: 'Unknown feature key' });
      }
      if (typeof body.value !== 'boolean') {
        return json(400, { error: 'Value must be a boolean' });
      }
      const flags = await readFlags(store);
      flags[body.key] = body.value;
      await store.setJSON(KEY, flags);
      return json(200, { flags });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
}
