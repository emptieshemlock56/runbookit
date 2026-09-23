// Sends email via Resend (https://resend.com) if RESEND_API_KEY is set in the
// environment. If it's not set, falls back to logging the email to the console
// instead - lets the verification-code flow be fully testable without spending
// anything or setting up a real provider yet.
async function sendEmail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'runbookIT.wiki <onboarding@resend.dev>';

  if (!apiKey) {
    console.log(`\n[email not configured - would have sent]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return { sent: false, mode: 'console' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Email send failed (${res.status}): ${body}`);
  }
  return { sent: true, mode: 'resend' };
}

module.exports = { sendEmail };
