import {
  json, fail, readBody, requireAdmin, getUser, verifyPassword, createUser, listUsers, issueToken,
  logAction, readAll, putJson, removeBlob, recordPresence, alreadyExists, clean, normPhone, httpError,
  today, currentSession, getSessionCode, SESSIONS, MODES, KINDS, OBJET,
} from './_lib.js';

/* Espace organisateur : un compte par personne. Le premier compte créé ('setup') ouvre
   l'espace ; ensuite chaque organisateur se connecte avec son propre identifiant et peut
   en inviter d'autres. Toutes les actions qui modifient des données sont historisées
   (qui, quoi, quand) et visibles dans l'onglet Équipe. */
export async function POST(request) {
  try {
    const b = await readBody(request);
    if (b.action === 'status') return json(await status());
    if (b.action === 'setup') return json(await setup(b));
    if (b.action === 'login') return json(await login(b));
    const by = await requireAdmin(request);
    switch (b.action) {
      case 'overview': return json(await overview());
      case 'addUser': return json(await addUser(by, b));
      case 'addPresence': return json(await addPresence(by, b));
      case 'removePresence': return json(await removePresence(by, b));
      case 'issueReceipt': return json(await issueReceipt(by, b));
      case 'voidReceipt': return json(await voidReceipt(by, b));
      case 'saveSettings': return json(await saveSettings(by, b));
      default: throw httpError(400, 'action');
    }
  } catch (e) {
    return fail(e);
  }
}

async function status() {
  const users = await listUsers();
  return { hasUsers: users.length > 0 };
}

async function setup(b) {
  const existing = await listUsers();
  if (existing.length > 0) throw httpError(409, 'already_setup');
  const { username } = await createUser(b.username, b.password);
  await logAction(username, 'setup', 'Création du premier compte organisateur');
  return { token: await issueToken(username) };
}

async function login(b) {
  const user = await getUser(b.username);
  if (!user || !verifyPassword(b.password, user.salt, user.hash)) {
    await new Promise((r) => setTimeout(r, 700));
    throw httpError(401, 'pin');
  }
  return { token: await issueToken(user.username) };
}

async function addUser(by, b) {
  const { username } = await createUser(b.username, b.password, by);
  await logAction(by, 'addUser', `Ajout de l'organisateur « ${username} »`);
  return { ok: true, username };
}

async function overview() {
  const current = currentSession();
  const [p1, p2, f1, f2, receipts, st, code, users, logs] = await Promise.all([
    readAll('p/s1/'), readAll('p/s2/'), readAll('f/s1/'), readAll('f/s2/'), readAll('r/'), readAll('m/'),
    getSessionCode(current), listUsers(), readAll('log/'),
  ]);
  return {
    sessions: { s1: { presence: p1, feedback: f1 }, s2: { presence: p2, feedback: f2 } },
    receipts,
    settings: st[0] || {},
    code,
    current,
    users,
    logs: logs.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 300),
  };
}

async function addPresence(by, b) {
  const sid = SESSIONS[b.sid] ? b.sid : currentSession();
  const { rec, already } = await recordPresence(sid, b);
  if (!already) await logAction(by, 'addPresence', `${rec.name} · ${sid}`);
  return { ok: true, already, name: rec.name };
}

async function removePresence(by, b) {
  if (!SESSIONS[b.sid]) throw httpError(400, 'session');
  const phone = normPhone(b.phone);
  if (!phone) throw httpError(400, 'phone');
  const removed = await removeBlob(`p/${b.sid}/${phone}.json`);
  if (removed) await logAction(by, 'removePresence', `${b.sid} · ${phone}`);
  return { ok: true };
}

async function issueReceipt(by, b) {
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
      date, objet: clean(b.objet, 200) || OBJET, status: 'valide', createdAt: new Date().toISOString(), issuedBy: by,
    };
    try {
      await putJson(`r/${number}.json`, receipt, false);
      await logAction(by, 'issueReceipt', `${number} · ${name} · ${amount} Ar`);
      return { ok: true, receipt };
    } catch (e) {
      if (!alreadyExists(e)) throw e;
      seq++;
    }
  }
  throw httpError(409, 'numbering');
}

async function voidReceipt(by, b) {
  const number = clean(b.number, 30);
  const all = await readAll('r/');
  const r = all.find((x) => x.number === number);
  if (!r) throw httpError(404, 'receipt');
  const next = { ...r, status: 'annulé', voidedAt: new Date().toISOString(), voidedBy: by };
  await putJson(`r/${number}.json`, next, true);
  await logAction(by, 'voidReceipt', number);
  return { ok: true, receipt: next };
}

async function saveSettings(by, b) {
  const s = { nif: clean(b.nif, 40), stat: clean(b.stat, 60), address: clean(b.address, 160) };
  await putJson('m/settings.json', s, true);
  await logAction(by, 'saveSettings', '');
  return { ok: true, settings: s };
}
