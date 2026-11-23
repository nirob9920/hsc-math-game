// GET /api/mcq/topic/:topicId — public game-side read of admin MCQs.
// The quiz UI expects { id, question, options: [a,b,c,d], correctIndex, difficulty }.
import { json } from '../../../_lib/lib.js';
import { createStore } from '../../../_lib/store.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const q = new URL(request.url).searchParams;
  const topicId = q.get('topicId') || context.params.topicId || '';
  try {
    const store = createStore(env.HSC_STORE);
    const all = await store.getJSON('mcq', []);
    const list = all
      .filter((r) => r.topic_id === topicId)
      .map((r) => ({
        id: r.id,
        question: r.question,
        options: [r.option_a, r.option_b, r.option_c, r.option_d],
        correctIndex: r.correct_index,
        difficulty: r.difficulty,
      }));
    return json(200, list);
  } catch (e) {
    return json(200, []);
  }
}
