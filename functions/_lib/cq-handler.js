// /api/settings/cq — admin CQ (creative question) management (Cloudflare port).
//   GET    /api/settings/cq[?subjectId=]   → array of snake_case records
//   POST   /api/settings/cq                → create one (text and/or image)
//   POST   /api/settings/cq/bulk           → create many, { inserted }
//   POST   /api/settings/cq/bulk-images    → one CQ per image, { inserted, failed }
//   PUT    /api/settings/cq/:id            → update text fields
//   DELETE /api/settings/cq/:id            → delete (and its image)
// All routes require the admin Bearer token. Images are stored as binary
// values under "cq-image:<id>"; records carry has_image + image_mime.
// Route files pass { bulk, bulkImages, id }; legacy ?bulk=1 / ?bulkImages=1
// / ?id= query forms are still honoured.
import { Buffer } from 'node:buffer';
import { json, requireAdmin, parseJsonBody, newId } from './lib.js';
import { createStore, bufferToArrayBuffer } from './store.js';

const KEY = 'cq';
const IMAGE_PREFIX = 'cq-image:';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function str(v) {
  return typeof v === 'string' ? v : '';
}

function validCqText(q) {
  if (!q || typeof q !== 'object') return false;
  return (
    str(q.stem).trim() &&
    str(q.questionKa).trim() &&
    str(q.questionKha).trim() &&
    str(q.questionGa).trim() &&
    str(q.questionGha).trim()
  );
}

function decodeImage(base64, mime) {
  if (!base64 || typeof base64 !== 'string') return null;
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const type = typeof mime === 'string' && mime.startsWith('image/') ? mime : 'image/jpeg';
  return { buffer: bufferToArrayBuffer(buf), contentType: type };
}

function toRecord(q, meta, hasImage, imageMime) {
  return {
    id: newId(),
    topic_id: str(meta.topicId),
    subject_id: str(meta.subjectId),
    chapter_bangla: str(meta.chapterBangla),
    stem: str(q.stem),
    question_ka: str(q.questionKa),
    question_kha: str(q.questionKha),
    question_ga: str(q.questionGa),
    question_gha: str(q.questionGha),
    difficulty: Number.isFinite(Number(q.difficulty)) ? Number(q.difficulty) : 2,
    has_image: !!hasImage,
    image_mime: hasImage ? imageMime : null,
    created_at: new Date().toISOString(),
  };
}

export async function handleCq(context, route) {
  const { request, env } = context;
  const gate = requireAdmin(env, request);
  if (gate.error) return gate.error;

  const store = createStore(env.HSC_STORE);
  const method = request.method;
  const q = new URL(request.url).searchParams;
  const isBulkImages = !!(route && route.bulkImages) || q.get('bulkImages') === '1';
  const isBulk = !isBulkImages && (!!(route && route.bulk) || q.get('bulk') === '1');
  const id =
    q.get('id') ||
    (route && route.id) ||
    (!isBulk && !isBulkImages && (method === 'PUT' || method === 'DELETE')
      ? context.params.id || ''
      : '');

  try {
    if (method === 'GET') {
      const all = await store.getJSON(KEY, []);
      const subjectId = q.get('subjectId') || '';
      const list = subjectId ? all.filter((r) => r.subject_id === subjectId) : all;
      return json(200, list);
    }

    if (method === 'POST' && isBulkImages) {
      const body = await parseJsonBody(request);
      if (!body || !Array.isArray(body.images) || body.images.length === 0) {
        return json(400, { error: 'No images provided' });
      }
      const meta = { topicId: body.topicId, subjectId: body.subjectId, chapterBangla: body.chapterBangla };
      const all = await store.getJSON(KEY, []);
      let inserted = 0;
      let failed = 0;
      for (const img of body.images) {
        const decoded = img ? decodeImage(img.imageBase64, img.imageMimeType) : null;
        if (!decoded) {
          failed++;
          continue;
        }
        const record = toRecord({}, meta, true, decoded.contentType);
        await store.setBinary(IMAGE_PREFIX + record.id, decoded.buffer, decoded.contentType);
        all.push(record);
        inserted++;
      }
      if (inserted === 0) return json(400, { error: 'No valid images' });
      await store.setJSON(KEY, all);
      return json(200, { inserted, failed });
    }

    if (method === 'POST' && isBulk) {
      const body = await parseJsonBody(request);
      if (!body || !Array.isArray(body.questions) || body.questions.length === 0) {
        return json(400, { error: 'No questions provided' });
      }
      const meta = { topicId: body.topicId, subjectId: body.subjectId, chapterBangla: body.chapterBangla };
      const valid = body.questions.filter(validCqText);
      if (valid.length === 0) return json(400, { error: 'No valid questions' });
      const all = await store.getJSON(KEY, []);
      for (const item of valid) all.push(toRecord(item, meta, false, null));
      await store.setJSON(KEY, all);
      return json(200, { inserted: valid.length });
    }

    if (method === 'POST') {
      const body = await parseJsonBody(request);
      if (!body) return json(400, { error: 'Invalid body' });
      const decoded = body.imageBase64 ? decodeImage(body.imageBase64, body.imageMimeType) : null;
      if (body.imageBase64 && !decoded) return json(400, { error: 'Invalid image' });
      if (!decoded && !validCqText(body)) {
        return json(400, { error: 'Provide an image or stem with all questions' });
      }
      const record = toRecord(body, body, !!decoded, decoded ? decoded.contentType : null);
      if (decoded) {
        await store.setBinary(IMAGE_PREFIX + record.id, decoded.buffer, decoded.contentType);
      }
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
      if (body.stem !== undefined) r.stem = str(body.stem);
      if (body.questionKa !== undefined) r.question_ka = str(body.questionKa);
      if (body.questionKha !== undefined) r.question_kha = str(body.questionKha);
      if (body.questionGa !== undefined) r.question_ga = str(body.questionGa);
      if (body.questionGha !== undefined) r.question_gha = str(body.questionGha);
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
      await store.deleteKey(IMAGE_PREFIX + id);
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
}
