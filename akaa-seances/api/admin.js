import {
  json, fail, readBody, requireAdmin, getUser, verifyPassword, createUser, listUsers, issueToken, logAction,
  readAll, putJson, alreadyExists, clean, normPhone, httpError, today,
  listCourses, getCourse, createCourse, updateCourse,
  listCohorts, getCohort, createCohort, updateCohort,
  listSessions, getSession, createSession, updateSession, removeSession, pickCurrentSession, getSessionCode,
  listEnrollments, getEnrollment, createEnrollment, updateEnrollment, removeEnrollment,
  findEnrollmentByPhone, listNewsletterOptins,
  recordAttendance, recordAttendanceByEnrollment, listAttendance, removeAttendance,
  listFeedback, listReceipts, getSettings, saveSettingsRecord,
  MODES, KINDS,
} from './_lib.js';

/* Espace organisateur : un compte par personne, toute action authentifiée est historisée.
   Modèle : Cours (programme réutilisable) -> Cohortes (éditions programmées) -> Séances,
   avec Inscriptions, Présences, Avis et Reçus rattachés à chaque cohorte. Le contenu
   pédagogique lui-même reste géré sur le site Akaa : ici, seulement la logistique. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    if (b.action === 'status') return json(await status());
    if (b.action === 'setup') return json(await setup(b));
    if (b.action === 'login') return json(await login(b));
    const by = await requireAdmin(request);
    switch (b.action) {
      case 'overview': return json(await overview());
      case 'addUser': return json(await addUser(by, b));

      case 'createCourse': return json(await doCreateCourse(by, b));
      case 'updateCourse': return json(await doUpdateCourse(by, b));

      case 'createCohort': return json(await doCreateCohort(by, b));
      case 'updateCohort': return json(await doUpdateCohort(by, b));
      case 'cohortDetail': return json(await cohortDetail(b));

      case 'createSession': return json(await doCreateSession(by, b));
      case 'updateSession': return json(await doUpdateSession(by, b));
      case 'removeSession': return json(await doRemoveSession(by, b));

      case 'addEnrollment': return json(await addEnrollment(by, b));
      case 'updateEnrollment': return json(await doUpdateEnrollment(by, b));
      case 'removeEnrollment': return json(await doRemoveEnrollment(by, b));

      case 'addAttendance': return json(await addAttendance(by, b));
      case 'markPresent': return json(await markPresent(by, b));
      case 'removeAttendance': return json(await doRemoveAttendance(by, b));

      case 'issueReceipt': return json(await issueReceipt(by, b));
      case 'voidReceipt': return json(await voidReceipt(by, b));

      case 'saveSettings': return json(await saveSettings(by, b));
      default: throw httpError(400, 'action');
    }
  } catch (e) {
    return fail(e);
  }
}

/* ---- accès ---- */
async function status() {
  const users = await listUsers();
  return { hasUsers: users.length > 0 };
}
async function setup(b) {
  const existing = await listUsers();
  if (existing.length > 0) throw httpError(409, 'already_setup');
  const { username } = await createUser(b.username, b.password);
  await logAction(username, 'setup', 'Création du premier compte organisateur');
  return { token: await issueToken(username) };
}
async function login(b) {
  const user = await getUser(b.username);
  if (!user || !verifyPassword(b.password, user.salt, user.hash)) {
    await new Promise((r) => setTimeout(r, 700));
    throw httpError(401, 'pin');
  }
  return { token: await issueToken(user.username) };
}
async function addUser(by, b) {
  const { username } = await createUser(b.username, b.password, by);
  await logAction(by, 'addUser', `Ajout de l'organisateur « ${username} »`);
  return { ok: true, username };
}

/* ---- tableau de bord ---- */
async function overview() {
  const [courses, cohorts, users, logs, newsletter, settings] = await Promise.all([
    listCourses(), listCohorts(), listUsers(), readAll('log/'), listNewsletterOptins(), getSettings(),
  ]);
  const counts = {};
  await Promise.all(cohorts.map(async (c) => {
    const enr = await listEnrollments(c.id);
    counts[c.id] = enr.filter((e) => e.status !== 'annule').length;
  }));
  return {
    courses, cohorts, enrollmentCounts: counts, users, newsletterCount: newsletter.length, settings,
    logs: logs.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 300),
  };
}

/* ---- cours ---- */
async function doCreateCourse(by, b) {
  const course = await createCourse(b, by);
  await logAction(by, 'createCourse', course.title);
  return { ok: true, course };
}
async function doUpdateCourse(by, b) {
  const course = await updateCourse(b.id, b, by);
  await logAction(by, 'updateCourse', course.title);
  return { ok: true, course };
}

/* ---- cohortes ---- */
async function doCreateCohort(by, b) {
  const cohort = await createCohort(b, by);
  await logAction(by, 'createCohort', cohort.name);
  return { ok: true, cohort };
}
async function doUpdateCohort(by, b) {
  const cohort = await updateCohort(b.id, b, by);
  await logAction(by, 'updateCohort', cohort.name);
  return { ok: true, cohort };
}
async function cohortDetail(b) {
  const cohort = await getCohort(b.id);
  if (!cohort) throw httpError(404, 'cohort');
  const [course, sessions, enrollments, receipts] = await Promise.all([
    getCourse(cohort.courseId), listSessions(cohort.id), listEnrollments(cohort.id), listReceipts(cohort.id),
  ]);
  const attendance = {}, feedback = {};
  await Promise.all(sessions.map(async (s) => {
    attendance[s.id] = await listAttendance(s.id);
    feedback[s.id] = await listFeedback(s.id);
  }));
  const codes = {};
  await Promise.all(sessions.map(async (s) => { codes[s.id] = await getSessionCode(s.id); }));
  const paid = receipts.filter((r) => r.status !== 'annulé').reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return {
    cohort, course, sessions, enrollments, receipts, attendance, feedback, codes,
    current: (pickCurrentSession(sessions) || {}).id || null,
    totals: { paid, enrolled: enrollments.filter((e) => e.status !== 'annule').length },
  };
}

/* ---- séances ---- */
async function doCreateSession(by, b) {
  const session = await createSession(b.cohortId, b, by);
  await logAction(by, 'createSession', `${session.date} (cohorte ${b.cohortId})`);
  return { ok: true, session };
}
async function doUpdateSession(by, b) {
  const session = await updateSession(b.cohortId, b.id, b, by);
  await logAction(by, 'updateSession', session.date);
  return { ok: true, session };
}
async function doRemoveSession(by, b) {
  await removeSession(b.cohortId, b.id);
  await logAction(by, 'removeSession', b.id);
  return { ok: true };
}

/* ---- inscriptions ---- */
async function addEnrollment(by, b) {
  const enr = await createEnrollment(b.cohortId, b, by, 'manuel', false);
  await logAction(by, 'addEnrollment', enr.name);
  return { ok: true, enrollment: enr };
}
async function doUpdateEnrollment(by, b) {
  const enr = await updateEnrollment(b.cohortId, b.id, b, by);
  await logAction(by, 'updateEnrollment', enr.name);
  return { ok: true, enrollment: enr };
}
async function doRemoveEnrollment(by, b) {
  await removeEnrollment(b.cohortId, b.id);
  await logAction(by, 'removeEnrollment', b.id);
  return { ok: true };
}

/* ---- présence ajoutée à la main par l'organisateur ---- */
async function addAttendance(by, b) {
  const cohort = await getCohort(b.cohortId);
  if (!cohort) throw httpError(400, 'cohort');
  const session = await getSession(b.cohortId, b.sessionId);
  if (!session) throw httpError(400, 'session');
  const { rec, already } = await recordAttendance(cohort, session, b, by, 'manuel');
  if (!already) await logAction(by, 'addAttendance', `${rec.name} · ${session.date}`);
  return { ok: true, already, name: rec.name };
}
/* Marquer présent un inscrit déjà existant (sans ressaisir nom/téléphone) — pratique pour
   les participants ajoutés à l'avance sans numéro. */
async function markPresent(by, b) {
  const cohort = await getCohort(b.cohortId);
  if (!cohort) throw httpError(400, 'cohort');
  const session = await getSession(b.cohortId, b.sessionId);
  if (!session) throw httpError(400, 'session');
  const enr = await getEnrollment(b.cohortId, b.enrollmentId);
  if (!enr) throw httpError(404, 'enrollment');
  const { rec, already } = await recordAttendanceByEnrollment(cohort, session, enr);
  if (!already) await logAction(by, 'addAttendance', `${rec.name} · ${session.date}`);
  return { ok: true, already, name: rec.name };
}
async function doRemoveAttendance(by, b) {
  await removeAttendance(b.sessionId, b.enrollmentId);
  await logAction(by, 'removeAttendance', `${b.sessionId} · ${b.enrollmentId}`);
  return { ok: true };
}

/* ---- reçus de paiement, saisis manuellement ---- */
async function issueReceipt(by, b) {
  const cohort = await getCohort(b.cohortId);
  if (!cohort) throw httpError(400, 'cohort');
  const course = await getCourse(cohort.courseId);
  const name = clean(b.name, 80);
  const phone = normPhone(b.phone);
  const amount = Math.round(Number(b.amount));
  const mode = MODES.includes(b.mode) ? b.mode : '';
  const kind = KINDS.includes(b.kind) ? b.kind : KINDS[0];
  if (name.length < 2) throw httpError(400, 'name');
  if (!(amount > 0) || amount > 100000000) throw httpError(400, 'amount');
  if (!mode) throw httpError(400, 'mode');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
  const year = date.slice(0, 4);
  const existing = await listReceipts();
  let seq = existing
    .filter((r) => String(r.number || '').startsWith(`REC-${year}-`))
    .reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
  const linked = phone ? await findEnrollmentByPhone(cohort.id, phone) : null;
  const defaultObjet = course ? `${course.title} · ${cohort.name}` : cohort.name;
  for (let i = 0; i < 8; i++) {
    const number = `REC-${year}-${String(seq).padStart(4, '0')}`;
    const receipt = {
      number, seq, cohortId: cohort.id, enrollmentId: linked ? linked.id : null,
      name, phone, email: clean(b.email, 120), amount, mode, kind,
      ref: mode === 'Espèces' ? '' : clean(b.ref, 80),
      date, objet: clean(b.objet, 200) || defaultObjet, status: 'valide',
      createdAt: new Date().toISOString(), issuedBy: by,
    };
    try {
      await putJson(`r/${cohort.id}/${number}.json`, receipt, false);
      await logAction(by, 'issueReceipt', `${number} · ${name} · ${amount} Ar`);
      return { ok: true, receipt };
    } catch (e) {
      if (!alreadyExists(e)) throw e;
      seq++;
    }
  }
  throw httpError(409, 'numbering');
}
async function voidReceipt(by, b) {
  const all = await listReceipts(b.cohortId);
  const r = all.find((x) => x.number === b.number);
  if (!r) throw httpError(404, 'receipt');
  const next = { ...r, status: 'annulé', voidedAt: new Date().toISOString(), voidedBy: by };
  await putJson(`r/${r.cohortId}/${r.number}.json`, next, true);
  await logAction(by, 'voidReceipt', r.number);
  return { ok: true, receipt: next };
}

/* ---- mentions légales ---- */
async function saveSettings(by, b) {
  const s = await saveSettingsRecord(b, by);
  await logAction(by, 'saveSettings', '');
  return { ok: true, settings: s };
}
