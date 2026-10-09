import {
  json, fail, readBody, requireAdmin, checkPassword, issueToken, readAll, putJson, removeBlob,
  recordPresence, alreadyExists, clean, normPhone, httpError, today, currentSession, getSessionCode,
  SESSIONS, MODES, KINDS, OBJET,
} from './_lib.js';

/* Espace organisateur : login par mot de passe, puis toutes les actions exigent le
   jeton de session qui en résulte (en-tête x-admin-token). */
export async function POST(request) {
  try {
    const b = await readBody(request);
    if (b.action === 'login') return json(await login(b));
    await requireAdmin(request);
    switch (b.action) {
      case 'overview': return json(await overview());
      case 'addPresence': return json(await addPresence(b));
      case 'removePresence': return json(await removePresence(b));
      case 'issueReceipt': return json(await issueReceipt(b));
      case 'voidReceipt': return json(await voidReceipt(b));
      case 'saveSettings': return json(await saveSettings(b));
      default: throw httpError(400, 'action');
    }
  } catch (e) {
    return fail(e);
  }
}

async function login(b) {
  if (!checkPassword(b.password)) {
    await new Promise((r) => setTimeout(r, 700));
    throw httpError(401, 'pin');
  }
  return { token: issueToken() };
}

async function overview() {
  const current = currentSession();
  const [p1, p2, f1, f2, receipts, st, code] = await Promise.all([
    readAll('p/s1/'), readAll('p/s2/'), readAll('f/s1/'), readAll('f/s2/'), readAll('r/'), readAll('m/'),
    getSessionCode(current),
  ]);
  return {
    sessions: { s1: { presence: p1, feedback: f1 }, s2: { presence: p2, feedback: f2 } },
    receipts,
    settings: st[0] || {},
    code,
    current,
  };
}

async function addPresence(b) {
  const sid = SESSIONS[b.sid] ? b.sid : currentSession();
  const { rec, already } = await recordPresence(sid, b);
  return { ok: true, already, name: rec.name };
}

async function removePresence(b) {
  if (!SESSIONS[b.sid]) throw httpError(400, 'session');
  const phone = normPhone(b.phone);
  if (!phone) throw httpError(400, 'phone');
  await removeBlob(`p/${b.sid}/${phone}.json`);
  return { ok: true };
}

async function issueReceipt(b) {
  const name = clean(b.name, 80);
  const phone = normPhone(b.phone);
  const amount = Math.round(Number(b.amount));
  const mode = MODES.includes(b.mode) ? b.mode : '';
  const kind = KINDS.includes(b.kind) ? b.kind : KINDS[0];
  if (name.length < 2) throw httpError(400, 'name');
  if (!(amount > 0) || amount > 100000000) throw httpError(400, 'amount');
  if (!mode) throw httpError(400, 'mode');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : today();
  const year = date.slice(0, 4);
  const existing = await readAll('r/');
  let seq = existing
    .filter((r) => String(r.number || '').startsWith(`REC-${year}-`))
    .reduce((m, r) => Math.max(m, r.seq || 0), 0) + 1;
  for (let i = 0; i < 8; i++) {
    const number = `REC-${year}-${String(seq).padStart(4, '0')}`;
    const receipt = {
      number, seq, name, phone, email: clean(b.email, 120), amount, mode, kind,
      ref: mode === 'Espèces' ? '' : clean(b.ref, 80),
      date, objet: clean(b.objet, 200) || OBJET, status: 'valide', createdAt: new Date().toISOString(),
    };
    try {
      await putJson(`r/${number}.json`, receipt, false);
      return { ok: true, receipt };
    } catch (e) {
      if (!alreadyExists(e)) throw e;
      seq++;
    }
  }
  throw httpError(409, 'numbering');
}

async function voidReceipt(b) {
  const number = clean(b.number, 30);
  const all = await readAll('r/');
  const r = all.find((x) => x.number === number);
  if (!r) throw httpError(404, 'receipt');
  const next = { ...r, status: 'annulé', voidedAt: new Date().toISOString() };
  await putJson(`r/${number}.json`, next, true);
  return { ok: true, receipt: next };
}

async function saveSettings(b) {
  const s = { nif: clean(b.nif, 40), stat: clean(b.stat, 60), address: clean(b.address, 160) };
  await putJson('m/settings.json', s, true);
  return { ok: true, settings: s };
}
