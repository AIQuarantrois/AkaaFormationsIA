import { put, list, get, del } from '@vercel/blob';
import { timingSafeEqual, randomInt, randomBytes, scryptSync, createHmac } from 'node:crypto';

export const MODES = ['Espèces', 'Mvola', 'Orange Money', 'Airtel Money'];
export const KINDS = ['Paiement intégral', 'Acompte', 'Solde'];
export const COHORT_STATUSES = ['brouillon', 'ouverte', 'terminee', 'annulee'];

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

function newId() {
  return Date.now().toString(36) + randomBytes(4).toString('hex');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
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

/* ---- mentions légales globales (NIF, STAT, adresse), pour les reçus ---- */
export async function getSettings() {
  const [rec] = await readAll('m/settings.json');
  return rec || {};
}
export async function saveSettingsRecord(d, by) {
  const s = { nif: clean(d.nif, 40), stat: clean(d.stat, 60), address: clean(d.address, 160), updatedBy: by };
  await putJson('m/settings.json', s, true);
  return s;
}

/* ---- cours : le programme réutilisable d'une formation (le contenu pédagogique
   lui-même reste géré sur le site Akaa ; ici on ne garde qu'un titre et un résumé) ---- */
export async function listCourses() {
  const all = await readAll('course/');
  return all.sort((a, b) => a.title.localeCompare(b.title));
}
export async function getCourse(id) {
  const [rec] = await readAll(`course/${clean(id, 40)}.json`);
  return rec || null;
}
export async function createCourse(d, by) {
  const title = clean(d.title, 120);
  if (title.length < 2) throw httpError(400, 'title');
  const id = newId();
  const rec = {
    id, title, summary: clean(d.summary, 300), location: clean(d.location, 160),
    archived: false, createdAt: new Date().toISOString(), createdBy: by,
  };
  await putJson(`course/${id}.json`, rec, false);
  return rec;
}
export async function updateCourse(id, d, by) {
  const cur = await getCourse(id);
  if (!cur) throw httpError(404, 'course');
  const next = {
    ...cur,
    title: d.title != null ? clean(d.title, 120) : cur.title,
    summary: d.summary != null ? clean(d.summary, 300) : cur.summary,
    location: d.location != null ? clean(d.location, 160) : cur.location,
    archived: d.archived != null ? !!d.archived : cur.archived,
    updatedAt: new Date().toISOString(), updatedBy: by,
  };
  await putJson(`course/${id}.json`, next, true);
  return next;
}

/* ---- cohortes : une édition programmée d'un cours, avec ses dates, son lieu,
   son tarif et ses inscrits ---- */
export async function listCohorts(courseId) {
  const all = await readAll('cohort/');
  const filtered = courseId ? all.filter((c) => c.courseId === courseId) : all;
  return filtered.sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
}
export async function getCohort(id) {
  const [rec] = await readAll(`cohort/${clean(id, 40)}.json`);
  return rec || null;
}
export async function getCohortBySlug(slug) {
  const s = slugify(slug);
  if (!s) return null;
  const all = await listCohorts();
  return all.find((c) => c.slug === s) || null;
}
export async function createCohort(d, by) {
  const course = await getCourse(d.courseId);
  if (!course) throw httpError(400, 'course');
  const name = clean(d.name, 80);
  if (name.length < 2) throw httpError(400, 'name');
  let slug = slugify(d.slug || name) || newId();
  if (await getCohortBySlug(slug)) slug = `${slug}-${randomBytes(2).toString('hex')}`;
  const id = newId();
  const rec = {
    id, courseId: course.id, name, slug,
    status: COHORT_STATUSES.includes(d.status) ? d.status : 'brouillon',
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(d.startDate || '') ? d.startDate : '',
    endDate: /^\d{4}-\d{2}-\d{2}$/.test(d.endDate || '') ? d.endDate : '',
    location: clean(d.location, 160) || course.location,
    link: clean(d.link, 300),
    price: Math.max(0, Math.round(Number(d.price) || 0)),
    currency: clean(d.currency, 10) || 'Ar',
    capacity: Number(d.capacity) > 0 ? Math.round(Number(d.capacity)) : null,
    createdAt: new Date().toISOString(), createdBy: by,
  };
  await putJson(`cohort/${id}.json`, rec, false);
  return rec;
}
export async function updateCohort(id, d, by) {
  const cur = await getCohort(id);
  if (!cur) throw httpError(404, 'cohort');
  const next = { ...cur };
  if (d.name != null) next.name = clean(d.name, 80);
  if (d.status != null && COHORT_STATUSES.includes(d.status)) next.status = d.status;
  if (d.startDate != null) next.startDate = /^\d{4}-\d{2}-\d{2}$/.test(d.startDate) ? d.startDate : cur.startDate;
  if (d.endDate != null) next.endDate = /^\d{4}-\d{2}-\d{2}$/.test(d.endDate) ? d.endDate : cur.endDate;
  if (d.location != null) next.location = clean(d.location, 160);
  if (d.link != null) next.link = clean(d.link, 300);
  if (d.price != null) next.price = Math.max(0, Math.round(Number(d.price) || 0));
  if (d.currency != null) next.currency = clean(d.currency, 10) || 'Ar';
  if (d.capacity != null) next.capacity = Number(d.capacity) > 0 ? Math.round(Number(d.capacity)) : null;
  next.updatedAt = new Date().toISOString(); next.updatedBy = by;
  await putJson(`cohort/${id}.json`, next, true);
  return next;
}

/* ---- séances : les rencontres d'une cohorte ---- */
export async function listSessions(cohortId) {
  const all = await readAll(`session/${clean(cohortId, 40)}/`);
  return all.sort((a, b) => (a.date + (a.start || '')).localeCompare(b.date + (b.start || '')));
}
export async function getSession(cohortId, id) {
  const [rec] = await readAll(`session/${clean(cohortId, 40)}/${clean(id, 40)}.json`);
  return rec || null;
}
export async function createSession(cohortId, d, by) {
  const cohort = await getCohort(cohortId);
  if (!cohort) throw httpError(400, 'cohort');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) throw httpError(400, 'date');
  const siblings = await listSessions(cohortId);
  const id = newId();
  const rec = {
    id, cohortId, index: siblings.length + 1, date: d.date,
    start: clean(d.start, 10), end: clean(d.end, 10),
    location: clean(d.location, 160) || cohort.location,
    topic: clean(d.topic, 160),
    createdAt: new Date().toISOString(), createdBy: by,
  };
  await putJson(`session/${cohortId}/${id}.json`, rec, false);
  return rec;
}
export async function updateSession(cohortId, id, d, by) {
  const cur = await getSession(cohortId, id);
  if (!cur) throw httpError(404, 'session');
  const next = { ...cur };
  if (d.date != null && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) next.date = d.date;
  if (d.start != null) next.start = clean(d.start, 10);
  if (d.end != null) next.end = clean(d.end, 10);
  if (d.location != null) next.location = clean(d.location, 160);
  if (d.topic != null) next.topic = clean(d.topic, 160);
  next.updatedAt = new Date().toISOString(); next.updatedBy = by;
  await putJson(`session/${cohortId}/${id}.json`, next, true);
  return next;
}
export async function removeSession(cohortId, id) {
  return removeBlob(`session/${clean(cohortId, 40)}/${clean(id, 40)}.json`);
}

export function pickCurrentSession(sessions) {
  if (!sessions.length) return null;
  const t = today();
  const sorted = sessions.slice().sort((a, b) => a.date.localeCompare(b.date));
  return sorted.find((s) => s.date === t) || sorted.find((s) => s.date > t) || sorted[sorted.length - 1];
}

/* ---- code de séance : généré automatiquement au premier accès, un par séance ---- */
export async function getSessionCode(sessionId) {
  const path = `code/${sessionId}.json`;
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
export async function checkCode(code, sessionId) {
  const expected = await getSessionCode(sessionId);
  if (clean(code, 20) !== expected) throw httpError(403, 'code');
}
/* Retrouve la séance correspondant à un code saisi, sans deviner par la date : utile
   quand une cohorte peut avoir plusieurs séances le même jour, et seul le code sait laquelle. */
export async function findSessionByCode(cohortId, code) {
  const c = clean(code, 20);
  if (!c) return null;
  const sessions = await listSessions(cohortId);
  for (const s of sessions) {
    if ((await getSessionCode(s.id)) === c) return s;
  }
  return null;
}

/* ---- inscriptions : un participant rattaché à une cohorte ---- */
export async function listEnrollments(cohortId) {
  const all = await readAll(`enr/${clean(cohortId, 40)}/`);
  return all.sort((a, b) => a.name.localeCompare(b.name));
}
export async function getEnrollment(cohortId, id) {
  const [rec] = await readAll(`enr/${clean(cohortId, 40)}/${clean(id, 40)}.json`);
  return rec || null;
}
export async function findEnrollmentByPhone(cohortId, phone) {
  if (!phone) return null;
  const all = await listEnrollments(cohortId);
  return all.find((e) => e.phone === phone) || null;
}
export async function createEnrollment(cohortId, d, by, source, requirePhone = true) {
  const cohort = await getCohort(cohortId);
  if (!cohort) throw httpError(400, 'cohort');
  const name = clean(d.name, 80);
  const phone = normPhone(d.phone);
  if (name.length < 2) throw httpError(400, 'name');
  if (requirePhone && !phone) throw httpError(400, 'phone');
  if (phone && await findEnrollmentByPhone(cohortId, phone)) throw httpError(409, 'already_enrolled');
  const id = newId();
  const rec = {
    id, cohortId, name, phone,
    email: clean(d.email, 120), company: clean(d.company, 120),
    status: 'inscrit', newsletter: !!d.newsletter, completed: false, completedAt: null,
    source: source || 'manuel', enrolledAt: new Date().toISOString(), enrolledBy: by,
  };
  await putJson(`enr/${cohortId}/${id}.json`, rec, false);
  return rec;
}
export async function updateEnrollment(cohortId, id, d, by) {
  const cur = await getEnrollment(cohortId, id);
  if (!cur) throw httpError(404, 'enrollment');
  const next = { ...cur };
  if (d.name != null) next.name = clean(d.name, 80);
  if (d.phone != null) {
    const p = normPhone(d.phone);
    if (d.phone && !p) throw httpError(400, 'phone');
    if (p && p !== cur.phone) {
      const existing = await findEnrollmentByPhone(cohortId, p);
      if (existing && existing.id !== id) throw httpError(409, 'already_enrolled');
    }
    next.phone = p;
  }
  if (d.email != null) next.email = clean(d.email, 120);
  if (d.company != null) next.company = clean(d.company, 120);
  if (d.status != null) next.status = d.status === 'annule' ? 'annule' : 'inscrit';
  if (d.newsletter != null) next.newsletter = !!d.newsletter;
  if (d.completed != null) {
    next.completed = !!d.completed;
    next.completedAt = next.completed ? (cur.completedAt || new Date().toISOString()) : null;
  }
  next.updatedAt = new Date().toISOString(); next.updatedBy = by;
  await putJson(`enr/${cohortId}/${id}.json`, next, true);
  return next;
}
export async function removeEnrollment(cohortId, id) {
  return removeBlob(`enr/${clean(cohortId, 40)}/${clean(id, 40)}.json`);
}
export async function listNewsletterOptins() {
  const all = await readAll('enr/');
  return all.filter((e) => e.newsletter && e.status !== 'annule')
    .map((e) => ({ name: e.name, phone: e.phone, email: e.email, cohortId: e.cohortId }));
}

/* ---- présence : un enregistrement par séance et par inscription (clé = enrollmentId,
   pas le téléphone, pour fonctionner même sans numéro et unifier badge-QR + auto-déclaration) ---- */
export async function recordAttendanceByEnrollment(cohort, session, enr) {
  const rec = {
    sessionId: session.id, cohortId: cohort.id, enrollmentId: enr.id,
    name: enr.name, phone: enr.phone, email: enr.email, company: enr.company, at: new Date().toISOString(),
  };
  try {
    await putJson(`att/${session.id}/${enr.id}.json`, rec, false);
    return { rec, already: false };
  } catch (e) {
    if (alreadyExists(e)) return { rec, already: true };
    throw e;
  }
}
export async function recordAttendance(cohort, session, d, by, source) {
  const name = clean(d.name, 80);
  const phone = normPhone(d.phone);
  if (name.length < 2) throw httpError(400, 'name');
  if (!phone) throw httpError(400, 'phone');
  let enr = await findEnrollmentByPhone(cohort.id, phone);
  if (!enr) enr = await createEnrollment(cohort.id, { name, phone, email: d.email, company: d.company }, by, source || 'checkin');
  return recordAttendanceByEnrollment(cohort, session, enr);
}
export async function listAttendance(sessionId) {
  return readAll(`att/${clean(sessionId, 40)}/`);
}
export async function removeAttendance(sessionId, enrollmentId) {
  return removeBlob(`att/${clean(sessionId, 40)}/${clean(enrollmentId, 40)}.json`);
}

/* ---- jetons de badge : liens personnels (QR) pour confirmer sa présence sans ressaisir
   nom/téléphone/code — signés avec la même clé que les sessions admin, mais domaine séparé. ---- */
export async function issueBadgeToken(cohortId, enrollmentId) {
  const key = await signingKey();
  const payload = Buffer.from(JSON.stringify({ c: cohortId, e: enrollmentId })).toString('base64url');
  const sig = createHmac('sha256', key).update('badge:' + payload).digest('base64url');
  return `${payload}.${sig}`;
}
export async function verifyBadgeToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const key = await signingKey();
  const expected = createHmac('sha256', key).update('badge:' + payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { c, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!c || !e) return null;
    return { cohortId: c, enrollmentId: e };
  } catch {
    return null;
  }
}

/* ---- avis : un par séance et par inscription (clé = enrollmentId, comme la présence,
   pour ne plus jamais redemander le nom/téléphone une fois l'identité connue) ---- */
export async function recordFeedbackByEnrollment(cohort, session, enr, d) {
  const score = Number(d.score);
  const recommend = ['oui', 'peut-etre', 'non'].includes(d.recommend) ? d.recommend : '';
  if (!Number.isInteger(score) || score < 1 || score > 10) throw httpError(400, 'score');
  if (!recommend) throw httpError(400, 'recommend');
  const rec = {
    sessionId: session.id, cohortId: cohort.id, enrollmentId: enr.id, name: enr.name, phone: enr.phone, score,
    helped: cleanLong(d.helped), missing: cleanLong(d.missing), recommend,
    next: clean(d.next, 300), quote: cleanLong(d.quote, 800),
    consentCite: d.consentCite === true, consentContact: d.consentContact === true,
    at: new Date().toISOString(),
  };
  await putJson(`fb/${session.id}/${enr.id}.json`, rec, true);
  return rec;
}
export async function listFeedback(sessionId) {
  return readAll(`fb/${clean(sessionId, 40)}/`);
}

/* ---- reçus de paiement : liés à une cohorte et, si connue, à une inscription ---- */
export async function listReceipts(cohortId) {
  return readAll(cohortId ? `r/${clean(cohortId, 40)}/` : 'r/');
}
