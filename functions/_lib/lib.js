// Shared helpers for the HSC Math Game auth functions (Cloudflare Pages port).
// The game uses Bearer tokens stored in localStorage ("hsc-math-token"),
// so sessions are stateless HMAC-signed tokens (JWT-shaped, HS256).
// Ported from the Netlify version: same token format, same semantics.
// Differences: env comes from context.env (not process.env), HTTP helpers
// return fetch Response objects, and parseJsonBody is async.
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function getSecret(env) {
  return (env && env.SESSION_SECRET) || '';
}

function hmac(env, data) {
  return crypto.createHmac('sha256', getSecret(env)).update(data).digest();
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Session tokens (30 days) ---
export function signToken(env, payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  return `${data}.${b64url(hmac(env, data))}`;
}

export function verifyToken(env, token) {
  if (!getSecret(env) || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!safeEqual(b64urlDecode(sig), hmac(env, `${header}.${body}`))) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// --- OAuth state (signed, 10 minutes) ---
// `extra` lets callers attach flags to the signed payload (e.g. { app: 1 }
// for the Android-app browser flow). With no extra, the payload is exactly
// { n, exp } as before.
export function makeState(env, extra) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = Object.assign(
    { n: nonce, exp: Math.floor(Date.now() / 1000) + 600 },
    extra || {}
  );
  const body = b64url(JSON.stringify(payload));
  return { state: `${body}.${b64url(hmac(env, body))}`, nonce };
}

export function verifyState(env, state) {
  if (!getSecret(env) || !state || typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!safeEqual(b64urlDecode(sig), hmac(env, body))) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// --- HTTP helpers (fetch-style) ---
export function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      try {
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      }
    }
  }
  return out;
}

export function getBearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function redirect(location, extraHeaders) {
  return new Response(null, {
    status: 302,
    headers: Object.assign(
      { Location: location, 'Cache-Control': 'no-store' },
      extraHeaders || {}
    ),
  });
}

export function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function siteOrigin(request) {
  return new URL(request.url).origin;
}

// Admin is decided server-side: the logged-in email must match the
// ADMIN_EMAIL env var (case-insensitive, trimmed). Unset env → no admins.
export function isAdminEmail(env, email) {
  const admin = ((env && env.ADMIN_EMAIL) || '').trim().toLowerCase();
  if (!admin || !email || typeof email !== 'string') return false;
  return email.trim().toLowerCase() === admin;
}

// Shape the game UI reads from /api/auth/me (mirrors its guest-user factory).
// is_admin is computed from the token's email claim, so tokens issued
// before ADMIN_EMAIL was set are recognised too.
export function userFromPayload(env, payload) {
  return {
    id: payload.sub,
    name: payload.name || '',
    email: payload.email || '',
    is_admin: isAdminEmail(env, payload.email),
    avatar_url: payload.picture || null,
    isGuest: false,
  };
}

// --- Admin-panel helpers ---

// Returns { payload } for a valid admin Bearer token, or { error } with a
// ready-to-return JSON Response: 401 for missing/invalid token,
// 403 for a valid token whose email is not the admin.
export function requireAdmin(env, request) {
  const token = getBearer(request);
  const payload = token ? verifyToken(env, token) : null;
  if (!payload) return { error: json(401, { error: 'Unauthorized' }) };
  if (!isAdminEmail(env, payload.email)) return { error: json(403, { error: 'Forbidden' }) };
  return { payload };
}

// Parse a JSON request body. Returns null on empty/invalid JSON.
export async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function newId() {
  return crypto.randomUUID();
}
