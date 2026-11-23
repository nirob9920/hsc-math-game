// GET /api/auth/google — start the Google OAuth flow.
// The game navigates here with window.location.href. On any problem we
// redirect to the app's /auth/callback route with an error code the UI reads.
// With ?app=1 (Android app, opened in the system browser so Google shows
// the phone's account chooser) the app flag rides inside the signed state,
// and the callback returns via the hscmathgame:// deep link instead.
import { makeState, redirect, siteOrigin } from '../../_lib/lib.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const q = new URL(request.url).searchParams;
  const isApp = q.get('app') === '1';
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const sessionSecret = env.SESSION_SECRET;
  if (!clientId || !clientSecret || !sessionSecret) {
    return redirect(
      isApp
        ? 'hscmathgame://auth?error=google_not_configured'
        : '/auth/callback?error=google_not_configured'
    );
  }

  const { state, nonce } = makeState(env, isApp ? { app: 1 } : undefined);
  const redirectUri = `${siteOrigin(request)}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  const cookie = `hsc_oauth_state=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=600`;
  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, {
    'Set-Cookie': cookie,
  });
}
