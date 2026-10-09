import {
  json, fail, readBody, getCohortBySlug, findSessionByCode, getEnrollment,
  recordAttendance, recordAttendanceByEnrollment, httpError,
} from './_lib.js';

/* Présence saisie par le participant : le code identifie la séance (il peut y en avoir
   plusieurs le même jour), puis soit il choisit son nom dans la liste des inscrits
   (enrollmentId), soit il n'y est pas et saisit ses coordonnées (nom/téléphone). */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const cohort = b.cohort ? await getCohortBySlug(b.cohort) : null;
    if (!cohort) throw httpError(400, 'cohort');
    const session = await findSessionByCode(cohort.id, b.code);
    if (!session) throw httpError(403, 'code');
    let result;
    if (b.enrollmentId) {
      const enr = await getEnrollment(cohort.id, b.enrollmentId);
      if (!enr) throw httpError(404, 'enrollment');
      result = await recordAttendanceByEnrollment(cohort, session, enr);
    } else {
      result = await recordAttendance(cohort, session, b, 'participant', 'checkin');
    }
    const { rec, already } = result;
    return json({ ok: true, already, name: rec.name, enrollmentId: rec.enrollmentId, sessionId: session.id });
  } catch (e) {
    return fail(e);
  }
}
