// GET /api/ai-usage — daily AI tutor usage for the logged-in user.
// The game UI reads { isAdmin, gemini:{used,limit}, openai:{used,limit} }
// to label the "Gemini Tutor" / "Gemini Focus" mode buttons (admin → ∞).
import { verifyToken, getBearer, json, isAdminEmail } from '../_lib/lib.js';
import { createStore } from '../_lib/store.js';
import * as ai from '../_lib/ai.js';

export async function onRequest(context) {
  const { request, env } = context;
  try {
    const token = getBearer(request);
    const payload = token ? verifyToken(env, token) : null;
    if (!payload) return json(401, { error: 'Unauthorized' });

    const store = createStore(env.HSC_STORE);
    const usage = await ai.getUsage(store, ai.userIdOf(payload));
    const limit = ai.dailyLimit(env);
    return json(200, {
      isAdmin: isAdminEmail(env, payload.email),
      gemini: { used: usage.gemini, limit },
      openai: { used: usage.openai, limit },
    });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
}
