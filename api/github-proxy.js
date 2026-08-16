/**
 * POST /api/github-proxy
 *
 * The only backend surface the CMS frontend (/contenido.html) talks to.
 * Requires a valid Google ID token (Authorization: Bearer <token>) from an
 * @<ALLOWED_EMAIL_DOMAIN> account — see requireGoogleUser in ./_github.js.
 * Holds the GitHub PAT server-side (process.env.GITHUB_TOKEN) so it never
 * reaches the browser.
 *
 * Body shapes:
 *   { action: "read",  paths: string[] }
 *     -> { ok: true, files: { [path]: { exists, sha, content } } }
 *     `content` is the raw file text (frontend does JSON.parse itself).
 *
 *   { action: "write", files: [{ path, content, message }] }
 *     -> { ok: true, results: [{ path, sha, commit }] }
 *     Files are committed sequentially, in array order, so the caller
 *     controls write order (e.g. image sidecar before locations.json on
 *     create, the reverse on delete). If a later file fails, earlier
 *     commits already happened — the response's `results` array reflects
 *     exactly what succeeded before the error.
 */

const { requireGoogleUser, readFile, writeFile, withApi, HttpError } = require('./_github');

module.exports = withApi(async function handler(req, res) {
  if (req.method !== 'POST') throw new HttpError(405, 'Método no permitido.');

  const user = await requireGoogleUser(req);
  const body = req.body || {};

  if (body.action === 'read') {
    const paths = Array.isArray(body.paths) ? body.paths : [];
    if (paths.length === 0) throw new HttpError(400, 'paths vacío.');
    const files = {};
    for (const path of paths) {
      if (typeof path !== 'string' || !path) throw new HttpError(400, 'path inválido.');
      const f = await readFile(path);
      files[path] = { exists: f.exists, sha: f.sha, content: f.text };
    }
    return res.status(200).json({ ok: true, files: files });
  }

  if (body.action === 'write') {
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length === 0) throw new HttpError(400, 'files vacío.');
    const results = [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || !f.path || typeof f.content !== 'string') {
        throw new HttpError(400, 'Cada file necesita path (string) y content (string).');
      }
      const message = (typeof f.message === 'string' && f.message) || ('Actualiza ' + f.path + ' vía CMS (' + user.email + ')');
      const result = await writeFile(f.path, f.content, message, user.email);
      results.push({ path: f.path, sha: result.sha, commit: result.commit });
    }
    return res.status(200).json({ ok: true, results: results });
  }

  throw new HttpError(400, 'action desconocida: ' + body.action);
});
