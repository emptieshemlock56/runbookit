const { authenticator } = require('otplib');
const QRCode = require('qrcode');

function generateSecret() {
  return authenticator.generateSecret();
}
function verifyToken(token, secret) {
  try {
    return authenticator.verify({ token: String(token).trim(), secret });
  } catch (e) {
    return false;
  }
}
async function generateQrDataUrl(username, secret, issuer) {
  const otpauth = authenticator.keyuri(username, issuer || 'runbookIT.wiki', secret);
  return QRCode.toDataURL(otpauth);
}

module.exports = { generateSecret, verifyToken, generateQrDataUrl };
