import { json, fail, readBody, checkCode, getCohortBySlug, listSessions, pickCurrentSession, recordFeedback, httpError } from './_lib.js';

/* Retour saisi par le participant. Un retour par personne et par séance : renvoyer le formulaire le remplace. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const cohort = b.cohort ? await getCohortBySlug(b.cohort) : null;
    if (!cohort) throw httpError(400, 'cohort');
    const sessions = await listSessions(cohort.id);
    const session = pickCurrentSession(sessions);
    if (!session) throw httpError(400, 'session');
    await checkCode(b.code, session.id);
    const rec = await recordFeedback(cohort, session, b);
    return json({ ok: true, name: rec.name });
  } catch (e) {
    return fail(e);
  }
}
