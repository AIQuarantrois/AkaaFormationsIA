import { put, list, get, del } from '@vercel/blob';
import { timingSafeEqual, randomInt, randomBytes, scryptSync, createHmac } from 'node:crypto';

export const SESSIONS = { s1: '2026-10-10', s2: '2026-10-17' };
export const MODES = ['Espèces', 'Mvola', 'Orange Money', 'Airtel Money'];
export const KINDS = ['Paiement intégral', 'Acompte', 'Solde'];
export const OBJET = 'Formation « Reprendre la main sur l’IA » · séances des 10 et 17 oct. 2026';

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const httpError = (status, message) => Object.assign(new Error(message), { status });

export function fail(e) {
  if (!e || !e.status) console.error(e);
  return json({ error: e && e.status ? e.message : 'server' }, (e && e.status) || 500);
}

export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Indian/Antananarivo' }).format(new Date());
export const currentSession = () => (today() >= SESSIONS.s2 ? 's2' : 's1');

export function normPhone(p) {
  let d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '261' + d.slice(1);
  else if (d.length === 9 && d[0] === '3') d = '261' + d;
  return /^\d{10,15}$/.test(d) ? d : '';
}

export const clean = (s, max = 200) =>
  String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanLong = (s, max = 1500) =>
  String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

export async function readBody(request) {
  const text = await request.text();
  if (text.length > 30000) throw httpError(413, 'too_large');
  try {
    const b = JSON.parse(text);
    if (!b || typeof b !== 'object') throw 0;
    return b;
  } catch {
    throw httpError(400, 'bad_json');
  }
}

/* Code de séance : généré automatiquement au premier accès, puis stocké (un par séance). */
export async function getSessionCode(sid) {
  const path = `c/${sid}.json`;
  const [existing] = await readAll(path);
  if (existing && existing.code) return existing.code;
  const code = String(randomInt(1000, 10000));
  try {
    await putJson(path, { code }, false);
    return code;
  } catch (e) {
    if (!alreadyExists(e)) throw e;
    const [retry] = await readAll(path);
    return (retry && retry.code) || code;
  }
}

export async function checkCode(code, sid) {
  const expected = await getSessionCode(sid);
  if (clean(code, 20) !== expected) throw httpError(403, 'code');
}

/* ---- authentification admin : un compte par organisateur ---- */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function normUsername(u) {
  return String(u == null ? '' : u).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password || ''), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const a = scryptSync(String(password || ''), salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function getUser(username) {
  const u = normUsername(username);
  if (!u) return null;
  const [rec] = await readAll(`u/${u}.json`);
  return rec || null;
}

export async function listUsers() {
  const all = await readAll('u/');
  return all.map((u) => ({ username: u.username, createdAt: u.createdAt, createdBy: u.createdBy }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export async function createUser(username, password, createdBy) {
  const u = normUsername(username);
  if (u.length < 3) throw httpError(400, 'username');
  if (String(password || '').length < 8) throw httpError(400, 'weak_password');
  const { salt, hash } = hashPassword(password);
  const rec = { username: u, salt, hash, createdAt: new Date().toISOString(), createdBy: createdBy || u };
  try {
    await putJson(`u/${u}.json`, rec, false);
  } catch (e) {
    if (alreadyExists(e)) throw httpError(409, 'username_taken');
    throw e;
  }
  return { username: u };
}

/* Clé de signature des jetons de session : générée une fois, stockée dans le Blob
   (indépendante de tout mot de passe, pour que changer un compte n'invalide pas les autres). */
let cachedSigningKey = null;
async function signingKey() {
  if (cachedSigningKey) return cachedSigningKey;
  const [existing] = await readAll('secret.json');
  if (existing && existing.key) {
    cachedSigningKey = Buffer.from(existing.key, 'hex');
    return cachedSigningKey;
  }
  const key = randomBytes(32).toString('hex');
  try {
    await putJson('secret.json', { key }, false);
  } catch (e) {
    if (!alreadyExists(e)) throw e;
  }
  const [rec] = await readAll('secret.json');
  cachedSigningKey = Buffer.from((rec && rec.key) || key, 'hex');
  return cachedSigningKey;
}

export async function issueToken(username) {
  const key = await signingKey();
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

async function verifyToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const key = await signingKey();
  const expected = createHmac('sha256', key).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!u || typeof exp !== 'number' || Date.now() >= exp) return null;
    return u;
  } catch {
    return null;
  }
}

/* Retourne le nom d'utilisateur authentifié, pour l'historisation des actions. */
export async function requireAdmin(request) {
  const token = request.headers.get('x-admin-token') || '';
  const username = await verifyToken(token);
  if (username) return username;
  await new Promise((r) => setTimeout(r, 700));
  throw httpError(401, 'pin');
}

/* ---- historique des actions (qui a fait quoi, quand) ---- */
export async function logAction(by, action, summary) {
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  await putJson(`log/${id}.json`, { at: new Date().toISOString(), by, action, summary: summary || '' }, false);
}

/* ---- stockage : un fichier JSON privé par enregistrement ---- */
export async function putJson(pathname, data, overwrite = true) {
  return put(pathname, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: overwrite,
  });
}
export const alreadyExists = (e) => /exist/i.test(String((e && e.message) || e));

async function listAll(prefix) {
  let cursor;
  const out = [];
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}
async function readBlob(blob) {
  const r = await get(blob.url, { access: 'private' });
  if (!r || !r.stream) return null;
  try {
    return await new Response(r.stream).json();
  } catch {
    return null;
  }
}
export async function readAll(prefix) {
  const blobs = await listAll(prefix);
  const items = await Promise.all(blobs.map(readBlob));
  return items.filter(Boolean);
}
export async function removeBlob(pathname) {
  const blobs = await listAll(pathname);
  const hit = blobs.find((b) => b.pathname === pathname);
  if (hit) await del(hit.url);
  return !!hit;
}

/* ---- présence ---- */
export async function recordPresence(sid, d) {
  if (!SESSIONS[sid]) throw httpError(400, 'session');
  const name = clean(d.name, 80);
  const phone = normPhone(d.phone);
  if (name.length < 2) throw httpError(400, 'name');
  if (!phone) throw httpError(400, 'phone');
  const rec = {
    sid,
    name,
    phone,
    email: clean(d.email, 120),
    company: clean(d.company, 120),
    at: new Date().toISOString(),
  };
  try {
    await putJson(`p/${sid}/${phone}.json`, rec, false);
    return { rec, already: false };
  } catch (e) {
    if (alreadyExists(e)) return { rec, already: true };
    throw e;
  }
}
