// POST /api/auth/otp/request {email} — mail a 6-digit login code.
// Always answers a generic success for well-formed emails (never reveals
// whether an account exists). 503 otp_not_configured until the email
// sender is configured (EMAIL_API_URL + SESSION_SECRET; see otp-lib.js).
import { json, parseJsonBody } from '../../../_lib/lib.js';
import { createStore } from '../../../_lib/store.js';
import { requestOtp } from '../../../_lib/otp-lib.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }
  const body = (await parseJsonBody(request)) || {};
  try {
    const store = createStore(env.HSC_STORE);
    const r = await requestOtp(env, body.email, { store });
    return json(r.status, r.body);
  } catch (e) {
    return json(500, { error: 'otp_failed' });
  }
}
