import {
  json, fail, readBody, httpError, today,
  getCohortBySlug, getCourse, listCohorts, listSessions, pickCurrentSession,
  findSessionByCode, listEnrollmentRoster,
} from './_lib.js';

/* Résolution publique d'une cohorte pour la page participant. Sans code : juste de quoi
   afficher l'en-tête (séance "probable" du jour, pour l'affichage, pas pour enregistrer
   quoi que ce soit). Avec code : la vraie séance qu'il désigne (il peut y en avoir
   plusieurs le même jour, seul le code sait laquelle) + la liste des inscrits à choisir,
   pour éviter de ressaisir nom/téléphone et de créer des doublons. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    const cohort = b.cohort ? await getCohortBySlug(b.cohort) : await pickDefaultCohort();
    if (!cohort || cohort.status === 'brouillon') throw httpError(404, 'cohort');
    const course = await getCourse(cohort.courseId);

    if (b.code) {
      const session = await findSessionByCode(cohort.id, b.code);
      if (!session) throw httpError(403, 'code');
      const sessions = await listSessions(cohort.id);
      const roster = await listEnrollmentRoster(cohort.id, session.id);
      return json({
        ok: true,
        cohort: { name: cohort.name, slug: cohort.slug },
        session: {
          id: session.id, index: session.index, date: session.date, start: session.start, end: session.end,
          location: session.location || cohort.location, topic: session.topic, total: sessions.length,
        },
        roster,
      });
    }

    const sessions = await listSessions(cohort.id);
    const session = pickCurrentSession(sessions);
    return json({
      ok: true,
      course: course ? { title: course.title } : null,
      cohort: { name: cohort.name, slug: cohort.slug, location: cohort.location, link: cohort.link },
      session: session ? {
        id: session.id, index: session.index, date: session.date, start: session.start, end: session.end,
        location: session.location || cohort.location, topic: session.topic, total: sessions.length,
      } : null,
    });
  } catch (e) {
    return fail(e);
  }
}

/* Sans slug explicite (lien générique) : la seule cohorte ouverte s'il n'y en a qu'une,
   sinon celle dont une séance tombe aujourd'hui, sinon la plus proche. */
async function pickDefaultCohort() {
  const open = (await listCohorts()).filter((c) => c.status === 'ouverte');
  if (open.length <= 1) return open[0] || null;
  const t = today();
  const scored = await Promise.all(open.map(async (c) => {
    const sessions = await listSessions(c.id);
    const s = pickCurrentSession(sessions);
    return { c, key: s ? s.date : '9999-99-99', isToday: !!s && s.date === t };
  }));
  scored.sort((a, b) => a.key.localeCompare(b.key));
  return (scored.find((x) => x.isToday) || scored[0]).c;
}
