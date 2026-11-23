// GET /api/auth/google/callback — finish the Google OAuth flow.
// On success: issue a signed session token and redirect to the app's
// /auth/callback?token=... route (the app stores it in localStorage).
// On failure: redirect to /auth/callback?error=<code> with a code the UI reads.
// Android-app flow (state carries app:1): the same results are delivered
// via the hscmathgame://auth deep link so the system browser hands control
// back to the app, which then loads /auth/callback itself. The web flow
// (no app flag) is unchanged.
import { verifyState, parseCookies, signToken, redirect, siteOrigin } from '../../../_lib/lib.js';
import { createStore } from '../../../_lib/store.js';

const CLEAR_COOKIE =
  'hsc_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=0';

function fail(code, isApp) {
  const target = isApp
    ? `hscmathgame://auth?error=${code}`
    : `/auth/callback?error=${code}`;
  return redirect(target, { 'Set-Cookie': CLEAR_COOKIE });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const q = new URL(request.url).searchParams;
  // Verify the state first so app-flow errors can be routed back to the
  // app. Observable web behaviour is unchanged: access_denied still maps
  // to google_cancelled even if the state is missing/invalid.
  const statePayload = verifyState(env, q.get('state'));
  const isApp = !!(statePayload && statePayload.app === 1);
  if (q.get('error') === 'access_denied') return fail('google_cancelled', isApp);
  if (q.get('error') || !q.get('code')) return fail('google_failed', isApp);

  if (!statePayload) return fail('google_failed', isApp);
  const cookies = parseCookies(request);
  if (cookies.hsc_oauth_state && cookies.hsc_oauth_state !== statePayload.n) {
    return fail('google_failed', isApp);
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail('google_not_configured', isApp);

  const redirectUri = `${siteOrigin(request)}/api/auth/google/callback`;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: q.get('code'),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) return fail('google_failed', isApp);
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return fail('google_failed', isApp);

    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) return fail('google_failed', isApp);
    const profile = await userRes.json();
    if (!profile.sub) return fail('google_failed', isApp);

    // Best-effort: persist the user record in KV for future features
    // (profile/leaderboard). Never block login on this.
    try {
      const store = createStore(env.HSC_STORE);
      await store.upsertUser({
        id: String(profile.sub),
        name: profile.name || '',
        email: profile.email || '',
        avatar_url: profile.picture || null,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      // KV unavailable — login continues statelessly.
    }

    const now = Math.floor(Date.now() / 1000);
    const token = signToken(env, {
      sub: String(profile.sub),
      name: profile.name || '',
      email: profile.email || '',
      picture: profile.picture || null,
      iat: now,
      exp: now + 30 * 24 * 3600,
    });
    const target = isApp
      ? `hscmathgame://auth?token=${encodeURIComponent(token)}`
      : `/auth/callback?token=${encodeURIComponent(token)}`;
    return redirect(target, {
      'Set-Cookie': CLEAR_COOKIE,
    });
  } catch (e) {
    return fail('google_failed', isApp);
  }
}
