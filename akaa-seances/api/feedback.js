import {
  json, fail, readBody, getCohortBySlug, findSessionByCode, getEnrollment,
  recordFeedbackByEnrollment, httpError,
} from './_lib.js';

/* Avis saisi par le participant. Un avis par personne et par séance : renvoyer le
   formulaire le remplace. L'identité (enrollmentId) vient de la présence déjà confirmée
   par le QR du badge : jamais de nom/téléphone à ressaisir ici. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const cohort = b.cohort ? await getCohortBySlug(b.cohort) : null;
    if (!cohort) throw httpError(400, 'cohort');
    const session = await findSessionByCode(cohort.id, b.code);
    if (!session) throw httpError(403, 'code');
    const enr = await getEnrollment(cohort.id, b.enrollmentId);
    if (!enr) throw httpError(404, 'enrollment');
    const rec = await recordFeedbackByEnrollment(cohort, session, enr, b);
    return json({ ok: true, name: rec.name });
  } catch (e) {
    return fail(e);
  }
}
