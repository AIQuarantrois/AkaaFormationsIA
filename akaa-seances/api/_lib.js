import { put, list, get, del } from '@vercel/blob';
import { timingSafeEqual, randomInt } from 'node:crypto';

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

export async function requireAdmin(request) {
  const pin = process.env.ADMIN_PIN || '';
  const got = request.headers.get('x-admin-pin') || '';
  const a = Buffer.from(got);
  const b = Buffer.from(pin);
  const ok = pin.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 700));
    throw httpError(401, 'pin');
  }
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
