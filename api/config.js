/**
 * GET /api/config
 *
 * Serves the CMS frontend's public configuration (Google OAuth Client ID,
 * allowed email domain) from environment variables, so contenido.html
 * doesn't need to hardcode them and they can change without a code edit.
 * Nothing here is secret — the Google Client ID is meant to be public,
 * and the allowed domain is just informational for the login screen.
 */

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    allowedEmailDomain: process.env.ALLOWED_EMAIL_DOMAIN || '',
  });
};
