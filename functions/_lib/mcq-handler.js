// /api/settings/mcq — admin MCQ question management (Cloudflare port).
//   GET    /api/settings/mcq[?subjectId=]  → array of snake_case records
//   POST   /api/settings/mcq               → create one
//   POST   /api/settings/mcq/bulk          → create many, { inserted }
//   PUT    /api/settings/mcq/:id           → update
//   DELETE /api/settings/mcq/:id           → delete
// All routes require the admin Bearer token.
// The route files pass { bulk, id } from the URL; the legacy ?bulk=1 / ?id=
// query forms the Netlify _redirects produced are still honoured.
import { json, requireAdmin, parseJsonBody, newId } from './lib.js';
import { createStore } from './store.js';

const KEY = 'mcq';

function str(v) {
  return typeof v === 'string' ? v : '';
}

function validMcq(q) {
  if (!q || typeof q !== 'object') return false;
  if (!str(q.question).trim()) return false;
  for (const k of ['optionA', 'optionB', 'optionC', 'optionD']) {
    if (!str(q[k]).trim()) return false;
  }
  const ci = Number(q.correctIndex);
  if (!Number.isInteger(ci) || ci < 0 || ci > 3) return false;
  return true;
}

function toRecord(q, meta) {
  return {
    id: newId(),
    topic_id: str(meta.topicId),
    subject_id: str(meta.subjectId),
    chapter_bangla: str(meta.chapterBangla),
    question: str(q.question),
    option_a: str(q.optionA),
    option_b: str(q.optionB),
    option_c: str(q.optionC),
    option_d: str(q.optionD),
    correct_index: Number(q.correctIndex),
    difficulty: Number.isFinite(Number(q.difficulty)) ? Number(q.difficulty) : 2,
    created_at: new Date().toISOString(),
  };
}

export async function handleMcq(context, route) {
  const { request, env } = context;
  const gate = requireAdmin(env, request);
  if (gate.error) return gate.error;

  const store = createStore(env.HSC_STORE);
  const method = request.method;
  const q = new URL(request.url).searchParams;
  const isBulk = !!(route && route.bulk) || q.get('bulk') === '1';
  const id =
    q.get('id') ||
    (route && route.id) ||
    (!isBulk && (method === 'PUT' || method === 'DELETE') ? context.params.id || '' : '');

  try {
    if (method === 'GET') {
      const all = await store.getJSON(KEY, []);
      const subjectId = q.get('subjectId') || '';
      const list = subjectId ? all.filter((r) => r.subject_id === subjectId) : all;
      return json(200, list);
    }

    if (method === 'POST' && isBulk) {
      const body = await parseJsonBody(request);
      if (!body || !Array.isArray(body.questions) || body.questions.length === 0) {
        return json(400, { error: 'No questions provided' });
      }
      const meta = { topicId: body.topicId, subjectId: body.subjectId, chapterBangla: body.chapterBangla };
      const valid = body.questions.filter(validMcq);
      if (valid.length === 0) return json(400, { error: 'No valid questions' });
      const all = await store.getJSON(KEY, []);
      for (const item of valid) all.push(toRecord(item, meta));
      await store.setJSON(KEY, all);
      return json(200, { inserted: valid.length });
    }

    if (method === 'POST') {
      const body = await parseJsonBody(request);
      if (!validMcq(body)) return json(400, { error: 'Question and all options are required' });
      const record = toRecord(body, body);
      const all = await store.getJSON(KEY, []);
      all.push(record);
      await store.setJSON(KEY, all);
      return json(201, record);
    }

    if (method === 'PUT' && id) {
      const body = await parseJsonBody(request);
      if (!body) return json(400, { error: 'Invalid body' });
      const all = await store.getJSON(KEY, []);
      const idx = all.findIndex((r) => r.id === id);
      if (idx === -1) return json(404, { error: 'Not found' });
      const r = all[idx];
      if (body.question !== undefined) r.question = str(body.question);
      if (body.optionA !== undefined) r.option_a = str(body.optionA);
      if (body.optionB !== undefined) r.option_b = str(body.optionB);
      if (body.optionC !== undefined) r.option_c = str(body.optionC);
      if (body.optionD !== undefined) r.option_d = str(body.optionD);
      if (body.correctIndex !== undefined) {
        const ci = Number(body.correctIndex);
        if (Number.isInteger(ci) && ci >= 0 && ci <= 3) r.correct_index = ci;
      }
      if (body.difficulty !== undefined && Number.isFinite(Number(body.difficulty))) {
        r.difficulty = Number(body.difficulty);
      }
      await store.setJSON(KEY, all);
      return json(200, r);
    }

    if (method === 'DELETE' && id) {
      const all = await store.getJSON(KEY, []);
      const next = all.filter((r) => r.id !== id);
      if (next.length === all.length) return json(404, { error: 'Not found' });
      await store.setJSON(KEY, next);
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
}
