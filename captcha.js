// Verifies a Cloudflare Turnstile token server-side. If TURNSTILE_SECRET_KEY isn't
// set, this is a safe no-op (always passes) so signup keeps working before you've
// set up Turnstile - configure it whenever you're ready, nothing else changes.
async function verifyTurnstile(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, configured: false };

  if (!token) return { ok: false, configured: true, error: 'Missing CAPTCHA response.' };

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: remoteIp }),
    });
    const data = await res.json();
    return { ok: !!data.success, configured: true, error: data.success ? null : 'CAPTCHA verification failed.' };
  } catch (e) {
    return { ok: false, configured: true, error: 'Could not verify CAPTCHA right now.' };
  }
}

function isTurnstileConfigured() {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

module.exports = { verifyTurnstile, isTurnstileConfigured };
