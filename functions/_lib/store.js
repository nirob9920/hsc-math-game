// Storage for admin-managed game data (questions, features, books, errors)
// and user records — Cloudflare KV port of the Netlify Blobs store.
//
// One KV namespace (binding HSC_STORE) replaces both Blobs stores:
//   Blobs "game-data" keys → KV keys prefixed "game-data:"
//   Blobs "users" keys     → KV keys prefixed "users:"
// Key names after the prefix are identical to the Netlify version.
//
// Semantics match the original store.js: getJSON/setJSON for documents,
// setBinary/getBinary for CQ images and book PDFs (contentType kept in KV
// metadata), deleteKey. A listKeys helper is included for completeness —
// the Netlify code never listed, but KV supports it natively.
//
// Note: KV is eventually consistent (writes propagate globally in ~60s),
// the same consistency class as Netlify Blobs. The read-modify-write
// patterns in the handlers (question lists, usage counters) behave the
// same as they did on Blobs.
import { Buffer } from 'node:buffer';

const GAME_PREFIX = 'game-data:';
const USERS_PREFIX = 'users:';

export function createStore(kv) {
  if (!kv) throw new Error('HSC_STORE KV binding is missing');

  async function getJSON(key, fallback) {
    const v = await kv.get(GAME_PREFIX + key, { type: 'json' });
    return v === null || v === undefined ? fallback : v;
  }

  async function setJSON(key, value) {
    await kv.put(GAME_PREFIX + key, JSON.stringify(value));
  }

  async function setBinary(key, buffer, contentType) {
    await kv.put(GAME_PREFIX + key, buffer, { metadata: { contentType } });
  }

  // Returns { buffer: ArrayBuffer, contentType } or null.
  async function getBinary(key) {
    const { value, metadata } = await kv.getWithMetadata(GAME_PREFIX + key, {
      type: 'arrayBuffer',
    });
    if (!value) return null;
    const contentType =
      (metadata && metadata.contentType) || 'application/octet-stream';
    return { buffer: value, contentType };
  }

  async function deleteKey(key) {
    await kv.delete(GAME_PREFIX + key);
  }

  async function listKeys(prefix) {
    const out = [];
    let cursor;
    do {
      const page = await kv.list({ prefix: GAME_PREFIX + (prefix || ''), cursor });
      for (const k of page.keys) out.push(k.name.slice(GAME_PREFIX.length));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return out;
  }

  // --- User records (Blobs "users" store) ---
  async function upsertUser(user) {
    await kv.put(USERS_PREFIX + user.id, JSON.stringify(user));
  }

  async function getUser(id) {
    return kv.get(USERS_PREFIX + id, { type: 'json' });
  }

  return { getJSON, setJSON, setBinary, getBinary, deleteKey, listKeys, upsertUser, getUser };
}

// Buffer → ArrayBuffer helper for callers that decode base64.
export function bufferToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export { Buffer };
