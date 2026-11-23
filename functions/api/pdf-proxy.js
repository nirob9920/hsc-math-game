// GET /api/pdf-proxy?url=<encoded> — fetch an external PDF for the book reader.
// Guarded: http/https only, no localhost/private-IP hostnames, PDF-ish
// content type required, ~4 MB cap, 15s timeout.
import { json } from '../_lib/lib.js';

const MAX_BYTES = 4 * 1024 * 1024;

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const q = new URL(request.url).searchParams;
  const raw = q.get('url') || '';
  let target;
  try {
    target = new URL(raw);
  } catch {
    return json(400, { error: 'Invalid URL' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json(400, { error: 'Invalid URL' });
  }
  if (isPrivateHost(target.hostname)) return json(400, { error: 'Invalid URL' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'HSCMathGame/1.0' },
    });
    if (!res.ok) return json(502, { error: `Upstream error (${res.status})` });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
      return json(415, { error: 'URL does not point to a PDF' });
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return json(413, { error: 'PDF is too large (max 4 MB)' });
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return json(413, { error: 'PDF is too large (max 4 MB)' });
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    return json(502, { error: 'Failed to fetch PDF' });
  } finally {
    clearTimeout(timer);
  }
}
