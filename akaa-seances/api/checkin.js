import { json, fail, readBody, checkCode, currentSession, recordPresence } from './_lib.js';

/* Présence saisie par le participant (code de séance exigé). */
export async function POST(request) {
  try {
    const b = await readBody(request);
    checkCode(b.code);
    const sid = currentSession();
    const { rec, already } = await recordPresence(sid, b);
    return json({ ok: true, sid, already, name: rec.name });
  } catch (e) {
    return fail(e);
  }
}
