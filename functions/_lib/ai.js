// Shared helpers for the AI tutor functions (ai-usage, ai-conversations).
// Cloudflare port: storage is the KV-backed store (see store.js):
// conversation docs, per-user daily usage counters, and numeric id
// sequences (the game UI coerces ids with Number()).

export const PROVIDERS = ['gemini', 'openai'];
const DEFAULT_MODEL = 'gemini-3.7-flash';
const DEFAULT_DAILY_LIMIT = 20;
const MAX_HISTORY = 20; // messages sent to the model as context
const MAX_IMAGE_B64 = 5_000_000; // ~3.7 MB image; UI sends <=1024px JPEGs

const SYSTEM_INSTRUCTION = [
  'You are a friendly study tutor inside "HSC Math Game", an app for HSC',
  '(Higher Secondary Certificate, Bangladesh) students. Help students solve',
  'math and other subject problems step by step, explain concepts simply,',
  'and read questions from images when provided.',
  'The student message may end with a [STRICT RULE: ...] language instruction',
  '— always obey it. If no language rule is given, reply in the language the',
  'student used (Bengali or English).',
  'Format answers clearly: short headings, bullet points, plain-text math',
  '(write fractions like (a)/(b), avoid heavy LaTeX). Keep answers focused',
  'and not overly long. Be encouraging.',
].join(' ');

// --- Identity / config ---
export function userIdOf(payload) {
  return String(payload.sub || payload.email || 'anon');
}

export function dailyLimit(env) {
  const n = parseInt((env && env.AI_DAILY_LIMIT) || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

export function geminiModel(env) {
  return ((env && env.GEMINI_MODEL) || '').trim() || DEFAULT_MODEL;
}

export function geminiKey(env) {
  return ((env && env.GEMINI_API_KEY) || '').trim();
}

// --- Daily usage (resets at midnight Asia/Dhaka, UTC+6) ---
function todayKey() {
  return new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
}

function usageKey(userId) {
  return `ai-usage:${userId}:${todayKey()}`;
}

export async function getUsage(store, userId) {
  const u = await store.getJSON(usageKey(userId), {});
  return { gemini: u.gemini || 0, openai: u.openai || 0 };
}

export async function bumpUsage(store, userId, provider) {
  const u = await getUsage(store, userId);
  u[provider] = (u[provider] || 0) + 1;
  await store.setJSON(usageKey(userId), u);
  return u;
}

// --- Numeric ids (UI does Number(id), so ids must be integers) ---
export async function nextId(store, kind) {
  const seq = await store.getJSON('ai-seq', { conv: 0, msg: 0 });
  seq[kind] = (seq[kind] || 0) + 1;
  await store.setJSON('ai-seq', seq);
  return seq[kind];
}

// --- Conversations ---
export function convKey(provider, userId, id) {
  return `ai-conv:${provider}:${userId}:${id}`;
}

export async function loadConversation(store, provider, userId, id) {
  if (!id || !/^\d+$/.test(String(id))) return null;
  return store.getJSON(convKey(provider, userId, id), null);
}

export async function saveConversation(store, conv) {
  await store.setJSON(convKey(conv.provider, conv.userId, conv.id), conv);
}

// --- User-facing error text (UI appends a language rule to each message) ---
export function langOf(content) {
  return /ONLY in English/.test(content || '') ? 'en' : 'bn';
}

export const ERRORS = {
  limit: {
    bn: 'আজকের AI limit শেষ হয়ে গেছে।',
    en: "Today's AI limit has been reached.",
  },
  noKey: {
    bn: 'AI Tutor এখনো চালু হয়নি। পরে আবার চেষ্টা করো।',
    en: 'The AI Tutor is not switched on yet. Please try again later.',
  },
  focusOff: {
    bn: 'Gemini Focus মোডটি এখনো চালু হয়নি। Gemini Tutor ব্যবহার করো।',
    en: 'Gemini Focus is not available yet. Please use Gemini Tutor.',
  },
  generic: {
    bn: 'দুঃখিত, কিছু একটা ভুল হয়েছে। আবার চেষ্টা করো।',
    en: 'Sorry, something went wrong. Please try again.',
  },
  imageTooBig: {
    bn: 'ছবিটি অনেক বড়। ছোট ছবি পাঠাও।',
    en: 'The image is too large. Please send a smaller image.',
  },
};

// --- SSE (the UI reads data: {...} chunks split on blank lines) ---
function sseResponse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function sseText(text) {
  const chunks = [];
  const STEP = 240;
  for (let i = 0; i < text.length; i += STEP) {
    chunks.push({ content: text.slice(i, i + STEP) });
  }
  chunks.push({ done: true });
  return sseResponse(chunks);
}

export function sseError(message) {
  return sseResponse([{ error: message }, { done: true }]);
}

// --- Gemini ---
// history: stored messages [{role:'user'|'assistant', content}] (oldest first,
// current user turn last). image: optional data URL for the current turn.
export async function callGemini(env, { history, image }) {
  const key = geminiKey(env);
  if (!key) {
    const e = new Error('missing-key');
    e.code = 'missing-key';
    throw e;
  }

  const contents = history.slice(-MAX_HISTORY).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').replace(/\n\[IMAGE_ATTACHED\]$/, '') }],
  }));

  if (image) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(image);
    if (!match) {
      const e = new Error('bad-image');
      e.code = 'bad-image';
      throw e;
    }
    if (match[2].length > MAX_IMAGE_B64) {
      const e = new Error('image-too-big');
      e.code = 'image-too-big';
      throw e;
    }
    const last = contents[contents.length - 1];
    if (last) last.parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel(env)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) {
    const e = new Error(`gemini-http-${res.status}`);
    e.code = 'gemini-http';
    e.status = res.status;
    throw e;
  }

  const data = await res.json();
  const parts =
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts) ||
    [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) {
    const e = new Error('gemini-empty');
    e.code = 'gemini-empty';
    throw e;
  }
  return text;
}
