import {
  json, fail, readBody, getCohortBySlug, findSessionByCode, getEnrollment,
  recordFeedback, recordFeedbackByEnrollment, httpError,
} from './_lib.js';

/* Avis saisi par le participant. Un avis par personne et par séance : renvoyer le
   formulaire le remplace. L'identité vient de l'enrollmentId connu depuis la présence
   (pas de nom/téléphone à ressaisir) ; en secours, nom/téléphone comme avant. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const cohort = b.cohort ? await getCohortBySlug(b.cohort) : null;
    if (!cohort) throw httpError(400, 'cohort');
    const session = await findSessionByCode(cohort.id, b.code);
    if (!session) throw httpError(403, 'code');
    let rec;
    if (b.enrollmentId) {
      const enr = await getEnrollment(cohort.id, b.enrollmentId);
      if (!enr) throw httpError(404, 'enrollment');
      rec = await recordFeedbackByEnrollment(cohort, session, enr, b);
    } else {
      rec = await recordFeedback(cohort, session, b, 'participant');
    }
    return json({ ok: true, name: rec.name });
  } catch (e) {
    return fail(e);
  }
}
