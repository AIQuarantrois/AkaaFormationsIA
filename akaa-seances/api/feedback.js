import { json, fail, readBody, checkCode, currentSession, putJson, clean, cleanLong, normPhone, httpError } from './_lib.js';

/* Retour saisi par le participant. Un retour par personne et par séance : renvoyer le formulaire le remplace. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    checkCode(b.code);
    const sid = currentSession();
    const name = clean(b.name, 80);
    const phone = normPhone(b.phone);
    const score = Number(b.score);
    const recommend = ['oui', 'peut-etre', 'non'].includes(b.recommend) ? b.recommend : '';
    if (name.length < 2) throw httpError(400, 'name');
    if (!phone) throw httpError(400, 'phone');
    if (!Number.isInteger(score) || score < 1 || score > 10) throw httpError(400, 'score');
    if (!recommend) throw httpError(400, 'recommend');
    const rec = {
      sid,
      name,
      phone,
      score,
      helped: cleanLong(b.helped),
      missing: cleanLong(b.missing),
      recommend,
      next: clean(b.next, 300),
      quote: cleanLong(b.quote, 800),
      consentCite: b.consentCite === true,
      consentContact: b.consentContact === true,
      at: new Date().toISOString(),
    };
    await putJson(`f/${sid}/${phone}.json`, rec, true);
    return json({ ok: true, sid, name });
  } catch (e) {
    return fail(e);
  }
}
