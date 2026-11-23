// Email-OTP login for the HSC Math Game (Cloudflare port).
//
// Flow: POST /api/auth/otp/request {email} mails a 6-digit code;
// POST /api/auth/otp/verify {email, code} exchanges it for the same
// Bearer session token the Google flow issues (lib.js signToken).
//
// Security properties (unchanged from the Netlify version):
// - Only an HMAC hash of the code is stored (keyed with SESSION_SECRET).
// - Codes expire after 10 minutes, allow 5 wrong tries, resends are
//   limited to one per 60 seconds and 10 per email per day (UTC).
// - request always answers a generic success for well-formed emails, so
//   it never reveals whether an account exists (accounts are created on
//   first successful verify anyway).
//
// EMAIL SENDING ON WORKERS: nodemailer / raw SMTP cannot run in the
// Workers runtime, so the Netlify version's Gmail-SMTP sender is replaced
// with a fetch-based sender: POST JSON {from, to, subject, text} to
// EMAIL_API_URL, with "Authorization: Bearer EMAIL_API_KEY" when a key is
// set. Point EMAIL_API_URL at any HTTPS email API (or a tiny relay you
// control). Until EMAIL_API_URL + SESSION_SECRET are set, request answers
// 503 otp_not_configured — exactly the behaviour the game UI already
// handles. The legacy SMTP_USER / SMTP_PASS vars are accepted but unused
// on Workers (SMTP_USER doubles as the default From address).
//
// deps injection (store / sendMail / upsertUser / now) exists for tests;
// production uses the KV-backed store (store.js).
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { signToken, userFromPayload } from './lib.js';

export const OTP_TTL_SEC = 600; // code valid 10 minutes
export const RESEND_COOLDOWN_SEC = 60; // min gap between sends
export const MAX_ATTEMPTS = 5; // wrong-code tries per issued code
export const DAILY_CAP = 10; // codes per email per day (UTC)
const TOKEN_TTL_SEC = 30 * 24 * 3600; // same 30 days as Google tokens

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function hashCode(env, email, code) {
  return crypto
    .createHmac('sha256', (env && env.SESSION_SECRET) || '')
    .update(email + ':' + code)
    .digest('hex');
}

function otpKey(email) {
  return 'otp:' + email;
}

// A working sender exists only when an HTTPS email endpoint is configured.
// (Name kept from the Netlify version, where this checked SMTP vars.)
export function smtpConfigured(env) {
  return !!(
    env &&
    env.EMAIL_API_URL &&
    env.SESSION_SECRET
  );
}
export const emailConfigured = smtpConfigured;

function dayString(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export async function sendOtpEmail(env, email, code) {
  const headers = { 'Content-Type': 'application/json' };
  if (env.EMAIL_API_KEY) headers.Authorization = `Bearer ${env.EMAIL_API_KEY}`;
  const res = await fetch(env.EMAIL_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: env.EMAIL_FROM || env.SMTP_USER || 'HSC Math Game',
      to: email,
      subject: 'HSC Math Game — your login code',
      text:
        'Your HSC Math Game login code is ' +
        code +
        '. It expires in 10 minutes.\n\n' +
        'তোমার লগইন কোড: ' +
        code +
        ' (১০ মিনিটের মধ্যে ব্যবহার করো)',
    }),
  });
  if (!res.ok) throw new Error(`email-api-http-${res.status}`);
}

function resolveDeps(env, deps) {
  deps = deps || {};
  return {
    store: deps.store,
    sendMail: deps.sendMail || ((email, code) => sendOtpEmail(env, email, code)),
    upsertUser:
      deps.upsertUser ||
      (async (user) => {
        try {
          await deps.store.upsertUser(user);
        } catch (e) {
          // KV unavailable — login continues statelessly.
        }
      }),
    now: deps.now || (() => Date.now()),
  };
}

export async function requestOtp(env, rawEmail, deps) {
  const d = resolveDeps(env, deps);
  const email = normalizeEmail(rawEmail);
  if (!validEmail(email)) return { status: 400, body: { error: 'invalid_email' } };
  if (!smtpConfigured(env)) return { status: 503, body: { error: 'otp_not_configured' } };

  const nowMs = d.now();
  const nowSec = Math.floor(nowMs / 1000);
  const today = dayString(nowMs);
  const key = otpKey(email);
  const existing = await d.store.getJSON(key, null);

  // Resend cooldown / daily cap: answer generic success, send nothing.
  if (existing && typeof existing.sent_at === 'number') {
    if (nowSec - existing.sent_at < RESEND_COOLDOWN_SEC) {
      return { status: 200, body: { ok: true } };
    }
    if (existing.day === today && (existing.count || 0) >= DAILY_CAP) {
      return { status: 200, body: { ok: true } };
    }
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const record = {
    hash: hashCode(env, email, code),
    exp: nowSec + OTP_TTL_SEC,
    attempts: 0,
    sent_at: nowSec,
    day: today,
    count: existing && existing.day === today ? (existing.count || 0) + 1 : 1,
  };
  await d.store.setJSON(key, record);

  try {
    await d.sendMail(email, code);
  } catch (e) {
    // Let the user retry immediately instead of waiting out the cooldown.
    try {
      await d.store.deleteKey(key);
    } catch (_) {}
    return { status: 502, body: { error: 'email_failed' } };
  }
  return { status: 200, body: { ok: true } };
}

export async function verifyOtp(env, rawEmail, rawCode, deps) {
  const d = resolveDeps(env, deps);
  const email = normalizeEmail(rawEmail);
  if (!validEmail(email)) return { status: 400, body: { error: 'invalid_email' } };
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!/^\d{6}$/.test(code)) return { status: 400, body: { error: 'invalid_code' } };

  const key = otpKey(email);
  const record = await d.store.getJSON(key, null);
  if (!record || typeof record.hash !== 'string') {
    return { status: 401, body: { error: 'invalid_code' } };
  }

  const nowSec = Math.floor(d.now() / 1000);
  if (typeof record.exp !== 'number' || nowSec > record.exp) {
    await d.store.deleteKey(key);
    return { status: 401, body: { error: 'code_expired' } };
  }
  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    await d.store.deleteKey(key);
    return { status: 401, body: { error: 'too_many_attempts' } };
  }

  const expected = Buffer.from(record.hash, 'hex');
  const actual = Buffer.from(hashCode(env, email, code), 'hex');
  const match =
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!match) {
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      await d.store.deleteKey(key);
      return { status: 401, body: { error: 'too_many_attempts' } };
    }
    await d.store.setJSON(key, record);
    return { status: 401, body: { error: 'invalid_code' } };
  }

  // Success: burn the code, upsert the user, issue the standard token.
  await d.store.deleteKey(key);
  const sub = 'email:' + email;
  const name = email.split('@')[0];
  await d.upsertUser({
    id: sub,
    name,
    email,
    avatar_url: null,
    updated_at: new Date(d.now()).toISOString(),
  });
  const payload = {
    sub,
    name,
    email,
    picture: null,
    iat: nowSec,
    exp: nowSec + TOKEN_TTL_SEC,
  };
  const token = signToken(env, payload);
  return { status: 200, body: { ok: true, token, user: userFromPayload(env, payload) } };
}
