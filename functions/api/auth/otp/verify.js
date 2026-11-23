// POST /api/auth/otp/verify {email, code} — exchange a mailed login code
// for the standard Bearer session token. The injected sign-in widget
// stores the returned token in localStorage["hsc-math-token"].
import { json, parseJsonBody } from '../../../_lib/lib.js';
import { createStore } from '../../../_lib/store.js';
import { verifyOtp } from '../../../_lib/otp-lib.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }
  const body = (await parseJsonBody(request)) || {};
  try {
    const store = createStore(env.HSC_STORE);
    const r = await verifyOtp(env, body.email, body.code, { store });
    return json(r.status, r.body);
  } catch (e) {
    return json(500, { error: 'otp_failed' });
  }
}
