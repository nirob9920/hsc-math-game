// GET /api/cq/topic/:topicId — public game-side read of admin CQs.
// The CQ game UI expects snake_case records incl. has_image.
import { json } from '../../../_lib/lib.js';
import { createStore } from '../../../_lib/store.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const q = new URL(request.url).searchParams;
  const topicId = q.get('topicId') || context.params.topicId || '';
  try {
    const store = createStore(env.HSC_STORE);
    const all = await store.getJSON('cq', []);
    const list = all
      .filter((r) => r.topic_id === topicId)
      .map((r) => ({
        id: r.id,
        stem: r.stem,
        question_ka: r.question_ka,
        question_kha: r.question_kha,
        question_ga: r.question_ga,
        question_gha: r.question_gha,
        difficulty: r.difficulty,
        has_image: !!r.has_image,
      }));
    return json(200, list);
  } catch (e) {
    return json(200, []);
  }
}
