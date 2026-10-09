import { json, fail, readBody, checkCode, getCohortBySlug, listSessions, pickCurrentSession, recordAttendance, httpError } from './_lib.js';

/* Présence saisie par le participant (code de séance exigé). */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const cohort = b.cohort ? await getCohortBySlug(b.cohort) : null;
    if (!cohort) throw httpError(400, 'cohort');
    const sessions = await listSessions(cohort.id);
    const session = pickCurrentSession(sessions);
    if (!session) throw httpError(400, 'session');
    await checkCode(b.code, session.id);
    const { rec, already } = await recordAttendance(cohort, session, b, 'participant', 'checkin');
    return json({ ok: true, already, name: rec.name });
  } catch (e) {
    return fail(e);
  }
}
