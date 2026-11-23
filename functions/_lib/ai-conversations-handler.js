// /api/{gemini|openai}/conversations[...] — AI tutor chat backend.
// Cloudflare port — same routes, shapes, status codes and SSE format.
// Route files pass { provider, id, messages, msgId }; legacy ?provider= /
// ?id= / ?messages=1 / ?msgId= query forms are still honoured.
//
//   POST   /api/{p}/conversations                    {title} → {id}
//   GET    /api/{p}/conversations/{id}               → {id, title} (existence check)
//   DELETE /api/{p}/conversations/{id}               → {ok:true}
//   GET    /api/{p}/conversations/{id}/messages      → [{id, role, content}]
//   POST   /api/{p}/conversations/{id}/messages      {content, image?} → SSE
//          stream of data: {"content":...} chunks, then {"done":true};
//          429 {error} when the daily limit is reached, 401 when logged out.
//   DELETE /api/{p}/conversations/{id}/messages/{msgId} → {ok:true}
//
// "gemini" (Gemini Tutor) calls the Gemini API. "openai" (labelled
// "Gemini Focus" in the UI) has no API key: conversation storage works,
// but sending a message returns a clear in-stream error.
import { verifyToken, getBearer, json, parseJsonBody, isAdminEmail } from './lib.js';
import { createStore } from './store.js';
import * as ai from './ai.js';

function auth(env, request) {
  const token = getBearer(request);
  const payload = token ? verifyToken(env, token) : null;
  if (!payload) return { error: json(401, { error: 'Unauthorized' }) };
  return { payload, userId: ai.userIdOf(payload) };
}

async function handleChat(context, store, { provider, userId, payload, conv }) {
  const { request, env } = context;
  const body = await parseJsonBody(request);
  if (!body || typeof body.content !== 'string') {
    return json(400, { error: 'Invalid request body' });
  }
  const content = body.content;
  const image = typeof body.image === 'string' && body.image ? body.image : null;
  const lang = ai.langOf(content);

  if (provider === 'openai') {
    return ai.sseError(ai.ERRORS.focusOff[lang]);
  }
  if (!ai.geminiKey(env)) {
    return ai.sseError(ai.ERRORS.noKey[lang]);
  }

  // Daily limit (admin is unlimited). Checked before persisting anything.
  if (!isAdminEmail(env, payload.email)) {
    const usage = await ai.getUsage(store, userId);
    if (usage.gemini >= ai.dailyLimit(env)) {
      return json(429, { error: ai.ERRORS.limit[lang] });
    }
  }

  // Persist the user turn (image itself is not stored; the UI strips the
  // trailing marker when displaying history).
  const userMsg = {
    id: await ai.nextId(store, 'msg'),
    role: 'user',
    content: image ? `${content}\n[IMAGE_ATTACHED]` : content,
    ts: Date.now(),
  };
  conv.messages.push(userMsg);
  await ai.saveConversation(store, conv);

  let reply;
  try {
    reply = await ai.callGemini(env, { history: conv.messages, image });
  } catch (e) {
    console.error('gemini call failed:', e && e.code, e && e.status, e && e.message);
    if (e && e.code === 'image-too-big') return ai.sseError(ai.ERRORS.imageTooBig[lang]);
    if (e && e.code === 'bad-image') return ai.sseError(ai.ERRORS.generic[lang]);
    return ai.sseError(ai.ERRORS.generic[lang]);
  }

  conv.messages.push({
    id: await ai.nextId(store, 'msg'),
    role: 'assistant',
    content: reply,
    ts: Date.now(),
  });
  await ai.saveConversation(store, conv);
  await ai.bumpUsage(store, userId, 'gemini');

  return ai.sseText(reply);
}

export async function handleConversations(context, route) {
  const { request, env } = context;
  try {
    const store = createStore(env.HSC_STORE);
    const q = new URL(request.url).searchParams;
    const provider = (route && route.provider) || q.get('provider');
    if (!ai.PROVIDERS.includes(provider)) {
      return json(404, { error: 'Not found' });
    }

    const gate = auth(env, request);
    if (gate.error) return gate.error;
    const { payload, userId } = gate;
    const method = request.method;
    const id = q.get('id') || (route && route.id) || context.params.id || null;
    const msgId = q.get('msgId') || (route && route.msgId) || context.params.msgId || null;
    const wantMessages = !!(route && route.messages) || q.get('messages') === '1';

    // POST /api/{p}/conversations — create
    if (!id) {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' });
      const body = (await parseJsonBody(request)) || {};
      const conv = {
        id: await ai.nextId(store, 'conv'),
        provider,
        userId,
        title: typeof body.title === 'string' && body.title ? body.title : 'HSC AI Assistant',
        createdAt: Date.now(),
        messages: [],
      };
      await ai.saveConversation(store, conv);
      return json(200, { id: conv.id });
    }

    const conv = await ai.loadConversation(store, provider, userId, id);
    if (!conv) return json(404, { error: 'Conversation not found' });

    // /api/{p}/conversations/{id}/messages/{msgId}
    if (msgId) {
      if (method !== 'DELETE') return json(405, { error: 'Method not allowed' });
      conv.messages = conv.messages.filter((m) => String(m.id) !== String(msgId));
      await ai.saveConversation(store, conv);
      return json(200, { ok: true });
    }

    // /api/{p}/conversations/{id}/messages
    if (wantMessages) {
      if (method === 'GET') {
        return json(
          200,
          conv.messages.map((m) => ({ id: m.id, role: m.role, content: m.content }))
        );
      }
      if (method === 'POST') {
        return handleChat(context, store, { provider, userId, payload, conv });
      }
      return json(405, { error: 'Method not allowed' });
    }

    // /api/{p}/conversations/{id}
    if (method === 'GET') {
      return json(200, { id: conv.id, title: conv.title });
    }
    if (method === 'DELETE') {
      await store.deleteKey(ai.convKey(provider, userId, id));
      return json(200, { ok: true });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
}
