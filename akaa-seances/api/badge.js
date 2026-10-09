import {
  json, fail, readBody, httpError, verifyBadgeToken,
  getCohort, getCourse, getEnrollment, listSessions, pickCurrentSession,
  listAttendance, recordAttendanceByEnrollment,
} from './_lib.js';

/* Confirmation de présence par le QR personnel imprimé sur le badge : pas de code de
   séance à ressaisir, le jeton lui-même (connu seulement du badge) fait foi. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const resolved = await verifyBadgeToken(b.token);
    if (!resolved) throw httpError(404, 'badge');
    const cohort = await getCohort(resolved.cohortId);
    const enr = cohort ? await getEnrollment(resolved.cohortId, resolved.enrollmentId) : null;
    if (!cohort || !enr) throw httpError(404, 'badge');
    const course = await getCourse(cohort.courseId);
    const sessions = await listSessions(cohort.id);
    const session = pickCurrentSession(sessions);
    if (!session) throw httpError(400, 'session');
    const att = await listAttendance(session.id);
    let already = att.some((a) => a.enrollmentId === enr.id);
    if (b.action === 'confirm' && !already) {
      await recordAttendanceByEnrollment(cohort, session, enr);
      already = true;
    }
    return json({
      ok: true, name: enr.name, course: course ? course.title : '', cohort: cohort.name,
      session: { index: session.index, date: session.date, total: sessions.length },
      already,
    });
  } catch (e) {
    return fail(e);
  }
}
