import {
  json, fail, readBody, httpError, verifyBadgeToken,
  getCohort, getCourse, getEnrollment, updateEnrollment,
  listSessions, findSessionByCode, recordAttendanceByEnrollment,
} from './_lib.js';

/* Confirmation de présence par le QR personnel imprimé sur le badge : le jeton (connu
   seulement du badge) fait foi de l'identité, jamais un enrollmentId envoyé tel quel par
   le navigateur. Le code de séance ne sert qu'à choisir la bonne séance (il peut y en
   avoir plusieurs le même jour) ; les coordonnées pré-remplies restent modifiables. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const resolved = await verifyBadgeToken(b.token);
    if (!resolved) throw httpError(404, 'badge');
    const cohort = await getCohort(resolved.cohortId);
    let enr = cohort ? await getEnrollment(resolved.cohortId, resolved.enrollmentId) : null;
    if (!cohort || !enr) throw httpError(404, 'badge');
    const course = await getCourse(cohort.courseId);

    if (b.action === 'confirm') {
      const session = await findSessionByCode(cohort.id, b.code);
      if (!session) throw httpError(403, 'code');
      if (b.phone != null || b.email != null) {
        enr = await updateEnrollment(cohort.id, enr.id, { phone: b.phone, email: b.email }, 'participant');
      }
      const sessions = await listSessions(cohort.id);
      const { already } = await recordAttendanceByEnrollment(cohort, session, enr);
      return json({
        ok: true, already, name: enr.name, phone: enr.phone, email: enr.email, enrollmentId: enr.id,
        cohortSlug: cohort.slug, course: course ? course.title : '', cohort: cohort.name,
        session: { id: session.id, index: session.index, total: sessions.length },
      });
    }

    return json({
      ok: true, name: enr.name, phone: enr.phone, email: enr.email, enrollmentId: enr.id,
      cohortSlug: cohort.slug, course: course ? course.title : '', cohort: cohort.name,
    });
  } catch (e) {
    return fail(e);
  }
}
