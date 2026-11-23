// Local tests for the Cloudflare port. Runs under plain Node:
//   node test/local-test.mjs
// Uses a Map-based mock KV and a mocked global fetch (Google OAuth,
// Gemini, email API, PDF upstreams). No network, no Cloudflare account.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

import * as lib from '../functions/_lib/lib.js';
import { createStore } from '../functions/_lib/store.js';
import * as otpLib from '../functions/_lib/otp-lib.js';

import { onRequestGet as authGoogle } from '../functions/api/auth/google.js';
import { onRequestGet as authCallback } from '../functions/api/auth/google/callback.js';
import { onRequestGet as authMe } from '../functions/api/auth/me.js';
import { onRequestGet as authAvatar } from '../functions/api/auth/avatar.js';
import { onRequest as otpRequest } from '../functions/api/auth/otp/request.js';
import { onRequest as otpVerify } from '../functions/api/auth/otp/verify.js';
import { onRequestGet as settingsMe } from '../functions/api/settings/me.js';
import { onRequest as settingsFeatures } from '../functions/api/settings/features.js';
import { onRequest as settingsMcq } from '../functions/api/settings/mcq.js';
import { onRequest as settingsMcqBulk } from '../functions/api/settings/mcq/bulk.js';
import { onRequest as settingsMcqId } from '../functions/api/settings/mcq/[id].js';
import { onRequest as settingsCq } from '../functions/api/settings/cq.js';
import { onRequest as settingsCqBulkImages } from '../functions/api/settings/cq/bulk-images.js';
import { onRequest as settingsCqId } from '../functions/api/settings/cq/[id].js';
import { onRequest as mcqTopic } from '../functions/api/mcq/topic/[topicId].js';
import { onRequest as cqTopic } from '../functions/api/cq/topic/[topicId].js';
import { onRequest as cqImage } from '../functions/api/cq/image/[id].js';
import { onRequest as errorsReport } from '../functions/api/errors/report.js';
import { onRequest as errorsInbox } from '../functions/api/errors/inbox.js';
import { onRequest as errorsResolve } from '../functions/api/errors/[id]/resolve.js';
import { onRequest as books } from '../functions/api/books.js';
import { onRequest as booksUpload } from '../functions/api/books/file-upload.js';
import { onRequest as booksId } from '../functions/api/books/[id].js';
import { onRequest as booksPdf } from '../functions/api/books/[id]/pdf.js';
import { onRequest as booksStoragePath } from '../functions/api/books/[id]/storage-path.js';
import { onRequest as booksExtract } from '../functions/api/books/[id]/extract-questions.js';
import { onRequest as pdfProxy } from '../functions/api/pdf-proxy.js';
import { onRequest as aiUsage } from '../functions/api/ai-usage.js';
import { onRequest as geminiConvs } from '../functions/api/gemini/conversations.js';
import { onRequest as geminiConvId } from '../functions/api/gemini/conversations/[id].js';
import { onRequest as geminiMessages } from '../functions/api/gemini/conversations/[id]/messages.js';
import { onRequest as geminiMsgId } from '../functions/api/gemini/conversations/[id]/messages/[msgId].js';
import { onRequest as openaiConvs } from '../functions/api/openai/conversations.js';
import { onRequest as openaiMessages } from '../functions/api/openai/conversations/[id]/messages.js';
import { onRequest as apiNotFound } from '../functions/api/[[catchall]].js';

// ---------- mock KV ----------
function createMockKV() {
  const map = new Map();
  return {
    map,
    async get(key, opts) {
      const e = map.get(key);
      if (!e) return null;
      if (opts && opts.type === 'json') return JSON.parse(e.value);
      return e.value;
    },
    async getWithMetadata(key) {
      const e = map.get(key);
      if (!e) return { value: null, metadata: null };
      return { value: e.value, metadata: e.metadata || null };
    },
    async put(key, value, opts) {
      map.set(key, { value, metadata: (opts && opts.metadata) || null });
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix } = {}) {
      const keys = [...map.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

// ---------- mock fetch ----------
const sentEmails = [];
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PDFBYTES = new TextEncoder().encode('%PDF-1.4 mock');
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    return Response.json({ access_token: 'test-access-token' });
  }
  if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
    return Response.json({
      sub: '12345',
      name: 'Test User',
      email: 'student@example.com',
      picture: 'https://example.com/pic.jpg',
    });
  }
  if (u === 'https://example.com/pic.jpg') {
    return new Response(JPEG, { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (u.startsWith('https://generativelanguage.googleapis.com/')) {
    return Response.json({
      candidates: [{ content: { parts: [{ text: 'Mock answer: 42' }] } }],
    });
  }
  if (u === 'https://email.example/send') {
    sentEmails.push(JSON.parse(opts.body));
    return new Response('{}', { status: 200 });
  }
  if (u === 'https://example.com/book.pdf') {
    return new Response(PDFBYTES, { headers: { 'Content-Type': 'application/pdf' } });
  }
  if (u === 'https://example.com/page.html') {
    return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } });
  }
  return new Response('not found', { status: 404 });
};

// ---------- test plumbing ----------
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}
const BASE = 'https://hsc-math-game.pages.dev';
function ctx(env, { method = 'GET', path = '/', headers = {}, body, params = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  return { request: new Request(BASE + path, init), env, params };
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
async function j(res) {
  return JSON.parse(await res.text());
}

const kv = createMockKV();
const env = {
  SESSION_SECRET: 'test-secret',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  ADMIN_EMAIL: 'admin@example.com',
  GEMINI_API_KEY: 'test-gemini-key',
  EMAIL_API_URL: 'https://email.example/send',
  HSC_STORE: kv,
};
const nowSec = Math.floor(Date.now() / 1000);
const studentToken = lib.signToken(env, {
  sub: '12345', name: 'Test User', email: 'student@example.com',
  picture: 'https://example.com/pic.jpg', iat: nowSec, exp: nowSec + 3600,
});
const adminToken = lib.signToken(env, {
  sub: '999', name: 'Admin', email: 'admin@example.com',
  picture: null, iat: nowSec, exp: nowSec + 3600,
});

// ---------- lib: tokens ----------
{
  const t = lib.signToken(env, { sub: 'x', exp: nowSec + 60 });
  check('token roundtrip', lib.verifyToken(env, t)?.sub === 'x');
  check('tampered token rejected', lib.verifyToken(env, t.slice(0, -2) + 'zz') === null);
  const expired = lib.signToken(env, { sub: 'x', exp: nowSec - 10 });
  check('expired token rejected', lib.verifyToken(env, expired) === null);
  check('wrong secret rejected', lib.verifyToken({ SESSION_SECRET: 'other' }, t) === null);

  // Cross-compat: a token built exactly like the old Netlify lib must verify.
  const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: 'legacy', exp: nowSec + 60 }));
  const sig = b64(crypto.createHmac('sha256', 'test-secret').update(`${header}.${body}`).digest());
  check('legacy-format token verifies', lib.verifyToken(env, `${header}.${body}.${sig}`)?.sub === 'legacy');

  const { state, nonce } = lib.makeState(env, { app: 1 });
  const sp = lib.verifyState(env, state);
  check('state roundtrip + app flag', sp && sp.n === nonce && sp.app === 1);
  check('bad state rejected', lib.verifyState(env, state + 'x') === null);
}

// ---------- auth/google ----------
{
  const res = await authGoogle(ctx(env, { path: '/api/auth/google' }));
  const loc = res.headers.get('location') || '';
  check('google start 302', res.status === 302 && loc.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
  check('google start params', loc.includes('client_id=test-client-id') && loc.includes(encodeURIComponent(BASE + '/api/auth/google/callback')));
  check('google start cookie', (res.headers.get('set-cookie') || '').includes('hsc_oauth_state='));

  const resApp = await authGoogle(ctx(env, { path: '/api/auth/google?app=1' }));
  const stateParam = new URL(resApp.headers.get('location')).searchParams.get('state');
  check('google app state flag', lib.verifyState(env, stateParam)?.app === 1);

  const resNoCfg = await authGoogle(ctx({}, { path: '/api/auth/google' }));
  check('google not configured', (resNoCfg.headers.get('location') || '').includes('error=google_not_configured'));
}

// ---------- auth/google/callback ----------
{
  const cancelled = await authCallback(ctx(env, { path: '/api/auth/google/callback?error=access_denied' }));
  check('callback cancelled', (cancelled.headers.get('location') || '').includes('error=google_cancelled'));

  const { state } = lib.makeState(env);
  const ok = await authCallback(ctx(env, { path: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}` }));
  const loc = ok.headers.get('location') || '';
  check('callback success redirect', loc.startsWith('/auth/callback?token='));
  const token = decodeURIComponent(loc.split('token=')[1]);
  check('callback token valid', lib.verifyToken(env, token)?.email === 'student@example.com');
  const userRec = await kv.get('users:12345', { type: 'json' });
  check('callback upserts user', userRec && userRec.email === 'student@example.com');

  const { state: appState } = lib.makeState(env, { app: 1 });
  const okApp = await authCallback(ctx(env, { path: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(appState)}` }));
  check('callback app deep link', (okApp.headers.get('location') || '').startsWith('hscmathgame://auth?token='));

  const bad = await authCallback(ctx(env, { path: '/api/auth/google/callback?code=abc&state=bogus' }));
  check('callback bad state', (bad.headers.get('location') || '').includes('error=google_failed'));
}

// ---------- auth/me + avatar + settings/me ----------
{
  check('me anon 401', (await authMe(ctx(env, { path: '/api/auth/me' }))).status === 401);
  const me = await j(await authMe(ctx(env, { path: '/api/auth/me', headers: bearer(studentToken) })));
  check('me shape', me.id === '12345' && me.is_admin === false && me.isGuest === false && me.avatar_url === 'https://example.com/pic.jpg');
  const meAdmin = await j(await authMe(ctx(env, { path: '/api/auth/me', headers: bearer(adminToken) })));
  check('me admin flag', meAdmin.is_admin === true);

  check('avatar anon 401', (await authAvatar(ctx(env, { path: '/api/auth/avatar' }))).status === 401);
  check('avatar no picture 404', (await authAvatar(ctx(env, { path: '/api/auth/avatar', headers: bearer(adminToken) }))).status === 404);
  const av = await authAvatar(ctx(env, { path: '/api/auth/avatar', headers: bearer(studentToken) }));
  check('avatar bytes', av.status === 200 && av.headers.get('content-type') === 'image/jpeg' && (await av.arrayBuffer()).byteLength === JPEG.length);

  check('settings/me anon 401', (await settingsMe(ctx(env, { path: '/api/settings/me' }))).status === 401);
  check('settings/me student', (await j(await settingsMe(ctx(env, { path: '/api/settings/me', headers: bearer(studentToken) })))).isAdmin === false);
  check('settings/me admin', (await j(await settingsMe(ctx(env, { path: '/api/settings/me', headers: bearer(adminToken) })))).isAdmin === true);
}

// ---------- settings/features ----------
{
  const flags = await j(await settingsFeatures(ctx(env, { path: '/api/settings/features' })));
  check('features defaults', flags.rag_enabled === true && flags.student_view_enabled === true);
  check('features PUT student 403', (await settingsFeatures(ctx(env, { method: 'PUT', path: '/api/settings/features', headers: bearer(studentToken), body: { key: 'rag_enabled', value: false } }))).status === 403);
  check('features PUT bad key 400', (await settingsFeatures(ctx(env, { method: 'PUT', path: '/api/settings/features', headers: bearer(adminToken), body: { key: 'nope', value: false } }))).status === 400);
  const put = await j(await settingsFeatures(ctx(env, { method: 'PUT', path: '/api/settings/features', headers: bearer(adminToken), body: { key: 'rag_enabled', value: false } })));
  check('features PUT admin', put.flags.rag_enabled === false);
  check('features persisted', (await j(await settingsFeatures(ctx(env, { path: '/api/settings/features' })))).rag_enabled === false);
  check('features POST 405', (await settingsFeatures(ctx(env, { method: 'POST', path: '/api/settings/features' }))).status === 405);
}

// ---------- settings/mcq + mcq/topic ----------
let mcqId;
{
  check('mcq anon 401', (await settingsMcq(ctx(env, { path: '/api/settings/mcq' }))).status === 401);
  check('mcq student 403', (await settingsMcq(ctx(env, { path: '/api/settings/mcq', headers: bearer(studentToken) }))).status === 403);
  const q1 = { question: '2+2?', optionA: '1', optionB: '2', optionC: '3', optionD: '4', correctIndex: 3, topicId: 't1', subjectId: 's1', chapterBangla: 'অধ্যায়' };
  check('mcq invalid 400', (await settingsMcq(ctx(env, { method: 'POST', path: '/api/settings/mcq', headers: bearer(adminToken), body: { question: 'x' } }))).status === 400);
  const created = await settingsMcq(ctx(env, { method: 'POST', path: '/api/settings/mcq', headers: bearer(adminToken), body: q1 }));
  const rec = await j(created);
  mcqId = rec.id;
  check('mcq create 201', created.status === 201 && rec.option_d === '4' && rec.topic_id === 't1');

  const bulk = await j(await settingsMcqBulk(ctx(env, { method: 'POST', path: '/api/settings/mcq/bulk', headers: bearer(adminToken), body: { topicId: 't2', subjectId: 's1', questions: [{ ...q1, question: '3+3?' }, { bad: true }] } })));
  check('mcq bulk inserted', bulk.inserted === 1);

  const list = await j(await settingsMcq(ctx(env, { path: '/api/settings/mcq?subjectId=s1', headers: bearer(adminToken) })));
  check('mcq list filter', list.length === 2);

  const topic = await j(await mcqTopic(ctx(env, { path: '/api/mcq/topic/t1', params: { topicId: 't1' } })));
  check('mcq topic shape', topic.length === 1 && topic[0].options[3] === '4' && topic[0].correctIndex === 3);
  check('mcq topic empty', (await j(await mcqTopic(ctx(env, { path: '/api/mcq/topic/none', params: { topicId: 'none' } })))).length === 0);

  const upd = await j(await settingsMcqId(ctx(env, { method: 'PUT', path: `/api/settings/mcq/${mcqId}`, headers: bearer(adminToken), params: { id: mcqId }, body: { question: '2+2=?' } })));
  check('mcq update', upd.question === '2+2=?');
  check('mcq update missing 404', (await settingsMcqId(ctx(env, { method: 'PUT', path: '/api/settings/mcq/nope', headers: bearer(adminToken), params: { id: 'nope' }, body: {} }))).status === 404);
  check('mcq delete', (await settingsMcqId(ctx(env, { method: 'DELETE', path: `/api/settings/mcq/${mcqId}`, headers: bearer(adminToken), params: { id: mcqId } }))).status === 200);
  check('mcq delete again 404', (await settingsMcqId(ctx(env, { method: 'DELETE', path: `/api/settings/mcq/${mcqId}`, headers: bearer(adminToken), params: { id: mcqId } }))).status === 404);
}

// ---------- settings/cq + cq/topic + cq/image ----------
let cqId;
{
  const imgB64 = Buffer.from(JPEG).toString('base64');
  const cqText = { stem: 'উদ্দীপক', questionKa: 'ক', questionKha: 'খ', questionGa: 'গ', questionGha: 'ঘ', topicId: 't1', subjectId: 's1' };
  const created = await settingsCq(ctx(env, { method: 'POST', path: '/api/settings/cq', headers: bearer(adminToken), body: { ...cqText, imageBase64: imgB64, imageMimeType: 'image/jpeg' } }));
  const rec = await j(created);
  cqId = rec.id;
  check('cq create with image', created.status === 201 && rec.has_image === true && rec.image_mime === 'image/jpeg');
  check('cq invalid 400', (await settingsCq(ctx(env, { method: 'POST', path: '/api/settings/cq', headers: bearer(adminToken), body: { stem: 'x' } }))).status === 400);

  const imgRes = await cqImage(ctx(env, { path: `/api/cq/image/${cqId}`, params: { id: cqId } }));
  check('cq image serve', imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/jpeg' && (await imgRes.arrayBuffer()).byteLength === JPEG.length);

  const bulk = await j(await settingsCqBulkImages(ctx(env, { method: 'POST', path: '/api/settings/cq/bulk-images', headers: bearer(adminToken), body: { topicId: 't9', images: [{ imageBase64: imgB64, imageMimeType: 'image/png' }, { imageBase64: '' }] } })));
  check('cq bulk-images counts', bulk.inserted === 1 && bulk.failed === 1);

  const topic = await j(await cqTopic(ctx(env, { path: '/api/cq/topic/t1', params: { topicId: 't1' } })));
  check('cq topic shape', topic.length === 1 && topic[0].has_image === true && topic[0].question_ka === 'ক');

  check('cq delete', (await settingsCqId(ctx(env, { method: 'DELETE', path: `/api/settings/cq/${cqId}`, headers: bearer(adminToken), params: { id: cqId } }))).status === 200);
  check('cq image gone after delete', (await cqImage(ctx(env, { path: `/api/cq/image/${cqId}`, params: { id: cqId } }))).status === 404);
}

// ---------- errors ----------
{
  check('errors report invalid 400', (await errorsReport(ctx(env, { method: 'POST', path: '/api/errors/report', body: 'x' }))).status === 400);
  check('errors report 201', (await errorsReport(ctx(env, { method: 'POST', path: '/api/errors/report', body: { errorType: 'TypeError', errorMessage: 'boom', page: '/quiz' } }))).status === 201);
  check('errors inbox student 403', (await errorsInbox(ctx(env, { path: '/api/errors/inbox', headers: bearer(studentToken) }))).status === 403);
  const inbox = await j(await errorsInbox(ctx(env, { path: '/api/errors/inbox', headers: bearer(adminToken) })));
  check('errors inbox list', inbox.logs.length === 1 && inbox.logs[0].errorMessage === 'boom');
  const logId = inbox.logs[0].id;
  check('errors resolve', (await errorsResolve(ctx(env, { method: 'PATCH', path: `/api/errors/${logId}/resolve`, headers: bearer(adminToken), params: { id: logId } }))).status === 200);
  const inbox2 = await j(await errorsInbox(ctx(env, { path: '/api/errors/inbox', headers: bearer(adminToken) })));
  check('errors resolved flag', inbox2.logs[0].resolved === true && !!inbox2.logs[0].resolvedAt);
  check('errors clear', (await errorsInbox(ctx(env, { method: 'DELETE', path: '/api/errors/inbox', headers: bearer(adminToken) }))).status === 200);
  check('errors cleared', (await j(await errorsInbox(ctx(env, { path: '/api/errors/inbox', headers: bearer(adminToken) })))).logs.length === 0);
}

// ---------- books ----------
let bookId;
{
  check('books list public', Array.isArray(await j(await books(ctx(env, { path: '/api/books' })))));
  const form = new FormData();
  form.append('pdf', new File([PDFBYTES], 'algebra.pdf', { type: 'application/pdf' }));
  form.append('title', 'Algebra Book');
  form.append('subject', 'গণিত');
  check('books upload student 403', (await booksUpload(ctx(env, { method: 'POST', path: '/api/books/file-upload', headers: bearer(studentToken), body: form }))).status === 403);

  const form2 = new FormData();
  form2.append('pdf', new File([PDFBYTES], 'algebra.pdf', { type: 'application/pdf' }));
  form2.append('title', 'Algebra Book');
  const up = await booksUpload(ctx(env, { method: 'POST', path: '/api/books/file-upload', headers: bearer(adminToken), body: form2 }));
  const book = await j(up);
  bookId = book.id;
  check('books upload 201', up.status === 201 && book.storage_path === 'local:blob' && book.file_size === PDFBYTES.length);

  const pdfRes = await booksPdf(ctx(env, { path: `/api/books/${bookId}/pdf`, params: { id: bookId } }));
  check('books pdf serve', pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf' && (await pdfRes.arrayBuffer()).byteLength === PDFBYTES.length);

  check('books storage-path invalid 400', (await booksStoragePath(ctx(env, { method: 'PATCH', path: `/api/books/${bookId}/storage-path`, headers: bearer(adminToken), params: { id: bookId }, body: { storagePath: 'ftp://x' } }))).status === 400);
  const sp = await j(await booksStoragePath(ctx(env, { method: 'PATCH', path: `/api/books/${bookId}/storage-path`, headers: bearer(adminToken), params: { id: bookId }, body: { storagePath: 'local:blob' } })));
  check('books storage-path ok', sp.storage_path === 'local:blob');

  check('books extract 501', (await booksExtract(ctx(env, { method: 'POST', path: `/api/books/${bookId}/extract-questions`, headers: bearer(adminToken), params: { id: bookId } }))).status === 501);

  const bigForm = new FormData();
  bigForm.append('pdf', new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' }));
  bigForm.append('title', 'Big');
  check('books oversize 413', (await booksUpload(ctx(env, { method: 'POST', path: '/api/books/file-upload', headers: bearer(adminToken), body: bigForm }))).status === 413);

  check('books delete', (await booksId(ctx(env, { method: 'DELETE', path: `/api/books/${bookId}`, headers: bearer(adminToken), params: { id: bookId } }))).status === 200);
  check('books pdf gone', (await booksPdf(ctx(env, { path: `/api/books/${bookId}/pdf`, params: { id: bookId } }))).status === 404);
}

// ---------- pdf-proxy ----------
{
  check('proxy no url 400', (await pdfProxy(ctx(env, { path: '/api/pdf-proxy' }))).status === 400);
  check('proxy ftp 400', (await pdfProxy(ctx(env, { path: '/api/pdf-proxy?url=' + encodeURIComponent('ftp://example.com/x.pdf') }))).status === 400);
  check('proxy localhost 400', (await pdfProxy(ctx(env, { path: '/api/pdf-proxy?url=' + encodeURIComponent('http://localhost/x.pdf') }))).status === 400);
  check('proxy private ip 400', (await pdfProxy(ctx(env, { path: '/api/pdf-proxy?url=' + encodeURIComponent('http://192.168.1.1/x.pdf') }))).status === 400);
  check('proxy html 415', (await pdfProxy(ctx(env, { path: '/api/pdf-proxy?url=' + encodeURIComponent('https://example.com/page.html') }))).status === 415);
  const ok = await pdfProxy(ctx(env, { path: '/api/pdf-proxy?url=' + encodeURIComponent('https://example.com/book.pdf') }));
  check('proxy pdf 200', ok.status === 200 && ok.headers.get('content-type') === 'application/pdf' && (await ok.arrayBuffer()).byteLength === PDFBYTES.length);
  check('proxy POST 405', (await pdfProxy(ctx(env, { method: 'POST', path: '/api/pdf-proxy' }))).status === 405);
}

// ---------- OTP ----------
{
  const noCfgEnv = { ...env, EMAIL_API_URL: undefined };
  check('otp 503 unconfigured', (await otpRequest(ctx(noCfgEnv, { method: 'POST', path: '/api/auth/otp/request', body: { email: 'a@b.com' } }))).status === 503);
  check('otp invalid email 400', (await otpRequest(ctx(env, { method: 'POST', path: '/api/auth/otp/request', body: { email: 'nope' } }))).status === 400);
  check('otp GET 405', (await otpRequest(ctx(env, { path: '/api/auth/otp/request' }))).status === 405);

  const before = sentEmails.length;
  const r1 = await otpRequest(ctx(env, { method: 'POST', path: '/api/auth/otp/request', body: { email: 'New@Example.com' } }));
  check('otp request 200', r1.status === 200 && sentEmails.length === before + 1);
  const code = /code is (\d{6})/.exec(sentEmails[before].text)[1];
  check('otp code in email', /^\d{6}$/.test(code));

  const r2 = await otpRequest(ctx(env, { method: 'POST', path: '/api/auth/otp/request', body: { email: 'new@example.com' } }));
  check('otp cooldown no resend', r2.status === 200 && sentEmails.length === before + 1);

  check('otp verify malformed 400', (await otpVerify(ctx(env, { method: 'POST', path: '/api/auth/otp/verify', body: { email: 'new@example.com', code: '12' } }))).status === 400);
  check('otp verify wrong 401', (await otpVerify(ctx(env, { method: 'POST', path: '/api/auth/otp/verify', body: { email: 'new@example.com', code: code === '000000' ? '111111' : '000000' } }))).status === 401);
  const okRes = await otpVerify(ctx(env, { method: 'POST', path: '/api/auth/otp/verify', body: { email: 'new@example.com', code } }));
  const okBody = await j(okRes);
  check('otp verify success', okRes.status === 200 && okBody.ok === true && okBody.user.email === 'new@example.com');
  check('otp token works on me', (await authMe(ctx(env, { path: '/api/auth/me', headers: bearer(okBody.token) }))).status === 200);
  check('otp code burned', (await otpVerify(ctx(env, { method: 'POST', path: '/api/auth/otp/verify', body: { email: 'new@example.com', code } }))).status === 401);
  const otpUser = await kv.get('users:email:new@example.com', { type: 'json' });
  check('otp user upserted', !!otpUser);
  check('otpConfigured helper', otpLib.smtpConfigured(env) === true && otpLib.smtpConfigured(noCfgEnv) === false);
}

// ---------- ai-usage + ai-conversations ----------
{
  check('ai-usage anon 401', (await aiUsage(ctx(env, { path: '/api/ai-usage' }))).status === 401);
  const usage = await j(await aiUsage(ctx(env, { path: '/api/ai-usage', headers: bearer(studentToken) })));
  check('ai-usage shape', usage.isAdmin === false && usage.gemini.used === 0 && usage.gemini.limit === 20);

  check('conv anon 401', (await geminiConvs(ctx(env, { method: 'POST', path: '/api/gemini/conversations', body: {} }))).status === 401);
  const created = await j(await geminiConvs(ctx(env, { method: 'POST', path: '/api/gemini/conversations', headers: bearer(studentToken), body: { title: 'Math help' } })));
  check('conv create numeric id', typeof created.id === 'number');
  const convId = created.id;

  const got = await j(await geminiConvId(ctx(env, { path: `/api/gemini/conversations/${convId}`, headers: bearer(studentToken), params: { id: String(convId) } })));
  check('conv get', got.id === convId && got.title === 'Math help');

  const chat = await geminiMessages(ctx(env, { method: 'POST', path: `/api/gemini/conversations/${convId}/messages`, headers: bearer(studentToken), params: { id: String(convId) }, body: { content: 'What is 6*7?' } }));
  const sse = await chat.text();
  check('chat SSE reply', chat.status === 200 && sse.includes('Mock answer: 42') && sse.includes('"done":true'));
  check('chat SSE content-type', (chat.headers.get('content-type') || '').includes('text/event-stream'));

  const msgs = await j(await geminiMessages(ctx(env, { path: `/api/gemini/conversations/${convId}/messages`, headers: bearer(studentToken), params: { id: String(convId) } })));
  check('messages listed', msgs.length === 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant');

  const usage2 = await j(await aiUsage(ctx(env, { path: '/api/ai-usage', headers: bearer(studentToken) })));
  check('usage bumped', usage2.gemini.used === 1);

  const msgId = msgs[0].id;
  check('delete message', (await geminiMsgId(ctx(env, { method: 'DELETE', path: `/api/gemini/conversations/${convId}/messages/${msgId}`, headers: bearer(studentToken), params: { id: String(convId), msgId: String(msgId) } }))).status === 200);
  const msgs2 = await j(await geminiMessages(ctx(env, { path: `/api/gemini/conversations/${convId}/messages`, headers: bearer(studentToken), params: { id: String(convId) } })));
  check('message deleted', msgs2.length === 1);

  check('delete conv', (await geminiConvId(ctx(env, { method: 'DELETE', path: `/api/gemini/conversations/${convId}`, headers: bearer(studentToken), params: { id: String(convId) } }))).status === 200);
  check('conv gone 404', (await geminiConvId(ctx(env, { path: `/api/gemini/conversations/${convId}`, headers: bearer(studentToken), params: { id: String(convId) } }))).status === 404);

  // openai provider: storage works, sending returns in-stream error
  const oc = await j(await openaiConvs(ctx(env, { method: 'POST', path: '/api/openai/conversations', headers: bearer(studentToken), body: {} })));
  const ochat = await openaiMessages(ctx(env, { method: 'POST', path: `/api/openai/conversations/${oc.id}/messages`, headers: bearer(studentToken), params: { id: String(oc.id) }, body: { content: 'hi' } }));
  const osse = await ochat.text();
  check('openai focus-off SSE', osse.includes('Gemini Focus') && osse.includes('"error"'));

  // daily limit (fresh KV + limit 1)
  const envLim = { ...env, AI_DAILY_LIMIT: '1', HSC_STORE: createMockKV() };
  const lc = await j(await geminiConvs(ctx(envLim, { method: 'POST', path: '/api/gemini/conversations', headers: bearer(studentToken), body: {} })));
  await geminiMessages(ctx(envLim, { method: 'POST', path: `/api/gemini/conversations/${lc.id}/messages`, headers: bearer(studentToken), params: { id: String(lc.id) }, body: { content: 'one' } }));
  const limited = await geminiMessages(ctx(envLim, { method: 'POST', path: `/api/gemini/conversations/${lc.id}/messages`, headers: bearer(studentToken), params: { id: String(lc.id) }, body: { content: 'two' } }));
  check('daily limit 429', limited.status === 429);

  // no Gemini key → in-stream "not switched on" error
  const envNoKey = { ...env, GEMINI_API_KEY: '', HSC_STORE: createMockKV() };
  const nc = await j(await geminiConvs(ctx(envNoKey, { method: 'POST', path: '/api/gemini/conversations', headers: bearer(studentToken), body: {} })));
  const nchat = await geminiMessages(ctx(envNoKey, { method: 'POST', path: `/api/gemini/conversations/${nc.id}/messages`, headers: bearer(studentToken), params: { id: String(nc.id) }, body: { content: 'hi' } }));
  check('no key SSE error', (await nchat.text()).includes('"error"'));
}

// ---------- api-not-found ----------
{
  const res = await apiNotFound(ctx(env, { path: '/api/whatever' }));
  check('catchall 404', res.status === 404 && (await j(res)).error === 'Not found');
}

// ---------- store direct ----------
{
  const store = createStore(createMockKV());
  await store.setJSON('k', { a: 1 });
  check('store json roundtrip', (await store.getJSON('k', null)).a === 1);
  check('store fallback', (await store.getJSON('missing', 'fb')) === 'fb');
  await store.setBinary('b', new Uint8Array([1, 2]).buffer, 'image/png');
  const bin = await store.getBinary('b');
  check('store binary + metadata', bin.contentType === 'image/png' && bin.buffer.byteLength === 2);
  await store.deleteKey('k');
  check('store delete', (await store.getJSON('k', null)) === null);
  await store.setJSON('x:1', 1);
  await store.setJSON('x:2', 2);
  check('store list', (await store.listKeys('x:')).length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
