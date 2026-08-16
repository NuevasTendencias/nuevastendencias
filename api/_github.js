/**
 * Shared backend helpers for the /contenido CMS.
 *
 * Filename starts with "_" so Vercel does NOT expose it as a route —
 * it's only ever imported by the actual /api function files.
 *
 * Everything that touches the GitHub Personal Access Token lives here,
 * server-side only. The token never reaches the browser.
 */

const GITHUB_API = 'https://api.github.com';

function readRepoConfig() {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const branch = process.env.REPO_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    throw new HttpError(500, 'Faltan variables de entorno del servidor (REPO_OWNER, REPO_NAME, GITHUB_TOKEN).');
  }
  return { owner, repo, branch, token };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Verifies a Google Identity Services ID token server-side and enforces
 * the company email allowlist. Uses Google's tokeninfo endpoint, which
 * validates the JWT signature/issuer/expiry for us — appropriate for the
 * login volume of an internal tool without pulling in a JWT library.
 */
async function requireGoogleUser(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const idToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) throw new HttpError(401, 'No autenticado: falta el token de sesión.');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const allowedDomain = (process.env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
  if (!clientId || !allowedDomain) {
    throw new HttpError(500, 'Faltan variables de entorno del servidor (GOOGLE_CLIENT_ID, ALLOWED_EMAIL_DOMAIN).');
  }

  let info;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!r.ok) throw new HttpError(401, 'Sesión inválida o expirada. Volvé a iniciar sesión.');
    info = await r.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'No se pudo verificar la sesión con Google.');
  }

  if (info.aud !== clientId) throw new HttpError(401, 'Token de sesión no válido para esta aplicación.');
  if (info.email_verified !== 'true') throw new HttpError(403, 'El email de Google no está verificado.');

  const email = String(info.email || '').toLowerCase();
  if (!email.endsWith('@' + allowedDomain)) {
    throw new HttpError(403, 'Tu cuenta (' + (info.email || '?') + ') no tiene acceso al CMS.');
  }

  return { email: info.email, name: info.name || info.email };
}

function ghHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * Reads a file's metadata (always includes `sha`, regardless of file size)
 * and, when needed, its full content. The Contents API silently omits/
 * truncates `content` for files over ~1MB (our .image-slots.state.json is
 * already past that), so for those we fall back to the Git Blobs API,
 * which returns the full base64 body keyed by blob sha.
 */
async function readFile(path) {
  const { owner, repo, branch, token } = readRepoConfig();
  const metaUrl = GITHUB_API + '/repos/' + owner + '/' + repo + '/contents/' + encodeURIComponent(path) + '?ref=' + encodeURIComponent(branch);
  const metaRes = await fetch(metaUrl, { headers: ghHeaders(token) });

  if (metaRes.status === 404) return { exists: false, sha: null, text: null };
  if (!metaRes.ok) throw new HttpError(502, 'GitHub API error leyendo ' + path + ': ' + metaRes.status);
  const meta = await metaRes.json();

  if (typeof meta.content === 'string' && meta.encoding === 'base64') {
    const text = Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { exists: true, sha: meta.sha, text };
  }

  // Large file: content omitted from the contents response, fetch via blob sha.
  const blobUrl = GITHUB_API + '/repos/' + owner + '/' + repo + '/git/blobs/' + meta.sha;
  const blobRes = await fetch(blobUrl, { headers: ghHeaders(token) });
  if (!blobRes.ok) throw new HttpError(502, 'GitHub API error leyendo blob de ' + path + ': ' + blobRes.status);
  const blob = await blobRes.json();
  const text = Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return { exists: true, sha: meta.sha, text };
}

/**
 * Creates or updates a file with a fresh commit. Always re-reads the
 * current sha immediately before writing (rather than trusting a sha the
 * client may have cached) to keep the race window with concurrent edits
 * as small as possible.
 */
async function writeFile(path, contentText, message, authorEmail) {
  const { owner, repo, branch, token } = readRepoConfig();
  const current = await readFile(path);

  const url = GITHUB_API + '/repos/' + owner + '/' + repo + '/contents/' + encodeURIComponent(path);
  const body = {
    message: message,
    content: Buffer.from(contentText, 'utf8').toString('base64'),
    branch: branch,
    committer: { name: 'CMS Nuevas Tendencias', email: 'cms@nuevastendencias.ar' },
  };
  if (current.exists) body.sha = current.sha;
  if (authorEmail) body.author = { name: authorEmail, email: authorEmail };

  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(function () { return ''; });
    throw new HttpError(res.status === 409 ? 409 : 502, 'GitHub API error escribiendo ' + path + ': ' + res.status + ' ' + detail);
  }
  const json = await res.json();
  return { sha: json.content && json.content.sha, commit: json.commit && json.commit.sha };
}

/** Wraps a Vercel Node function handler with uniform error handling + JSON responses. */
function withApi(handler) {
  return async function (req, res) {
    try {
      await handler(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error(e);
      res.status(status).json({ ok: false, error: e.message || 'Error interno.' });
    }
  };
}

module.exports = { HttpError, requireGoogleUser, readFile, writeFile, withApi };
