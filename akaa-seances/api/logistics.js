import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import qrcodeGen from 'qrcode-generator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  json, fail, readBody, requireAdmin, httpError,
  getCohort, getCourse, listSessions, listEnrollments, issueBadgeToken,
} from './_lib.js';

/* Génère en PDF, à la demande, les badges (A6, QR de présence personnel) et le
   feuillet d'accueil (A4) d'une cohorte — téléchargés depuis l'onglet Logistique. */
const mm = 72 / 25.4;
const PUBLIC_DIR = join(process.cwd(), 'public');
const loadPng = (name) => readFileSync(join(PUBLIC_DIR, name));

const BLUE = rgb(0x0b / 255, 0x63 / 255, 0xff / 255);
const BLUE_INK = rgb(0x1b / 255, 0x4f / 255, 0xc8 / 255);
const INK = rgb(0x0f / 255, 0x1e / 255, 0x3c / 255);
const BODY = rgb(0x4a / 255, 0x5a / 255, 0x75 / 255);
const MUTED = rgb(0x6b / 255, 0x7a / 255, 0x93 / 255);
const LINE = rgb(0xe3 / 255, 0xea / 255, 0xf5 / 255);
const YELLOW = rgb(0xf2 / 255, 0xb4 / 255, 0);
const NOTE_BG = rgb(1, 0xf7 / 255, 0xe6 / 255);
const NOTE_INK = rgb(0x9a / 255, 0x6b / 255, 0);
const BLUE_SOFT = rgb(0xea / 255, 0xf1 / 255, 0xff / 255);
const WHITE = rgb(1, 1, 1);

const DATE_LONG = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const DATE_SHORT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtLong = (iso) => { const s = DATE_LONG.format(new Date(iso + 'T00:00:00Z')); return s.charAt(0).toUpperCase() + s.slice(1); };
const fmtShort = (iso) => DATE_SHORT.format(new Date(iso + 'T00:00:00Z'));

function wrapText(font, size, text, maxWidth) {
  const words = String(text || '').split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
function drawCentered(page, text, cx, y, size, font, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - w / 2, y, size, font, color });
}
function drawRight(page, text, rx, y, size, font, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: rx - w, y, size, font, color });
}
function drawQr(page, url, x, y, size, color) {
  const qr = qrcodeGen(0, 'M');
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const cell = size / count;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        page.drawRectangle({ x: x + col * cell, y: y + size - (row + 1) * cell, width: cell + 0.25, height: cell + 0.25, color });
      }
    }
  }
}
function roundRect(page, x, y, w, h, color) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

export async function POST(request) {
  try {
    const b = await readBody(request);
    await requireAdmin(request);
    const origin = new URL(request.url).origin;
    if (b.action === 'badges') return await badgesPdf(b, origin);
    if (b.action === 'feuillet') return await feuilletPdf(b, origin);
    throw httpError(400, 'action');
  } catch (e) {
    return fail(e);
  }
}

function pdfResponse(bytes, filename) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${filename}"`, 'cache-control': 'no-store' },
  });
}

/* ---- badges (A6, 4 par page, QR personnel) ---- */
async function badgesPdf(b, origin) {
  const cohort = await getCohort(b.cohortId);
  if (!cohort) throw httpError(400, 'cohort');
  const [course, sessions, enrollments] = await Promise.all([
    getCourse(cohort.courseId), listSessions(cohort.id), listEnrollments(cohort.id),
  ]);
  const active = enrollments.filter((e) => e.status !== 'annule');
  if (!active.length) throw httpError(400, 'empty');

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const akaaLogo = await pdfDoc.embedPng(loadPng('logo-white.png'));
  const qrtLogo = await pdfDoc.embedPng(loadPng('quarantrois-horizontal-anthracite.png'));

  const PAGE_W = 210 * mm, PAGE_H = 297 * mm;
  const QUAD_W = PAGE_W / 2, QUAD_H = PAGE_H / 2;
  const BADGE_W = 100 * mm, BADGE_H = 142 * mm;
  const positions = [[0, QUAD_H], [QUAD_W, QUAD_H], [0, 0], [QUAD_W, 0]];

  for (let i = 0; i < active.length; i += 4) {
    const chunk = active.slice(i, i + 4);
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    for (let idx = 0; idx < chunk.length; idx++) {
      const [qx, qy] = positions[idx];
      const ox = qx + (QUAD_W - BADGE_W) / 2, oy = qy + (QUAD_H - BADGE_H) / 2;
      await drawBadge(page, font, fontBold, akaaLogo, qrtLogo, ox, oy, BADGE_W, BADGE_H, chunk[idx], cohort, course, sessions, origin);
    }
    page.drawLine({ start: { x: QUAD_W, y: 0 }, end: { x: QUAD_W, y: PAGE_H }, thickness: 0.5, color: LINE, dashArray: [2, 2] });
    page.drawLine({ start: { x: 0, y: QUAD_H }, end: { x: PAGE_W, y: QUAD_H }, thickness: 0.5, color: LINE, dashArray: [2, 2] });
  }

  const bytes = await pdfDoc.save();
  return pdfResponse(bytes, `badges-${cohort.slug}.pdf`);
}

async function drawBadge(page, font, fontBold, akaaLogo, qrtLogo, ox, oy, W, H, enr, cohort, course, sessions, origin) {
  page.drawRectangle({ x: ox, y: oy, width: W, height: H, color: WHITE, borderColor: LINE, borderWidth: 0.6 });

  const bandH = 28 * mm;
  page.drawRectangle({ x: ox, y: oy + H - bandH, width: W, height: bandH, color: BLUE });
  const alw = 28 * mm, alh = alw * (akaaLogo.height / akaaLogo.width);
  page.drawImage(akaaLogo, { x: ox + (W - alw) / 2, y: oy + H - bandH + (bandH - alh) / 2, width: alw, height: alh });

  const pad = 8 * mm, usableW = W - 2 * pad;
  let y = oy + H - bandH - 9 * mm;

  page.drawText('PARTICIPANT', { x: ox + pad, y, size: 7.5, font: fontBold, color: BLUE });
  y -= 8.5 * mm;

  const nameLines = wrapText(fontBold, 14.5, enr.name, usableW).slice(0, 2);
  nameLines.forEach((ln, i) => page.drawText(ln, { x: ox + pad, y: y - i * 6 * mm, size: 14.5, font: fontBold, color: INK }));
  y -= nameLines.length * 6 * mm + 4.5 * mm;

  const courseLines = wrapText(font, 10, (course ? course.title : cohort.name), usableW).slice(0, 2);
  courseLines.forEach((ln, i) => page.drawText(ln, { x: ox + pad, y: y - i * 4.4 * mm, size: 10, font, color: INK }));
  y -= courseLines.length * 4.4 * mm + 4.5 * mm;

  page.drawLine({ start: { x: ox + pad, y }, end: { x: ox + W - pad, y }, thickness: 0.7, color: LINE });
  y -= 5.5 * mm;

  sessions.forEach((s, i) => {
    const ly = y - i * 8.3 * mm;
    page.drawText(`Séance ${s.index} · ${fmtShort(s.date)}`, { x: ox + pad, y: ly, size: 8.3, font, color: MUTED });
    page.drawText(`${s.start || ''}${s.end ? ' – ' + s.end : ''}`, { x: ox + pad, y: ly - 3.8 * mm, size: 7.6, font, color: MUTED });
  });

  const qrSize = 24 * mm;
  const qrY = oy + 24 * mm;
  const token = await issueBadgeToken(cohort.id, enr.id);
  const url = `${origin}/badge.html?t=${token}`;
  drawQr(page, url, ox + (W - qrSize) / 2, qrY, qrSize, INK);
  drawCentered(page, 'Scanner pour confirmer sa présence', ox + W / 2, qrY - 5 * mm, 6.3, font, MUTED);

  page.drawLine({ start: { x: ox + pad, y: oy + 15.5 * mm }, end: { x: ox + pad + 12 * mm, y: oy + 15.5 * mm }, thickness: 1.4, color: YELLOW });
  const qw = 22 * mm, qh = qw * (qrtLogo.height / qrtLogo.width);
  page.drawImage(qrtLogo, { x: ox + pad, y: oy + 7 * mm, width: qw, height: qh });
  page.drawText('en partenariat avec Quarantrois', { x: ox + pad, y: oy + 3.2 * mm, size: 6, font, color: MUTED });
}

/* ---- feuillet d'accueil (A4, une page) ---- */
async function feuilletPdf(b, origin) {
  const cohort = await getCohort(b.cohortId);
  if (!cohort) throw httpError(400, 'cohort');
  const [course, sessions] = await Promise.all([getCourse(cohort.courseId), listSessions(cohort.id)]);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const akaaLogo = await pdfDoc.embedPng(loadPng('logo-white.png'));
  const qrtLogo = await pdfDoc.embedPng(loadPng('quarantrois-horizontal-blanc.png'));

  const PAGE_W = 210 * mm, PAGE_H = 297 * mm;
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  const margin = 18 * mm, contentW = PAGE_W - 2 * margin;

  const bandH = 40 * mm;
  page.drawRectangle({ x: 0, y: PAGE_H - bandH, width: PAGE_W, height: bandH, color: BLUE });
  const alw = 42 * mm, alh = alw * (akaaLogo.height / akaaLogo.width);
  page.drawImage(akaaLogo, { x: margin, y: PAGE_H - bandH + (bandH - alh) / 2, width: alw, height: alh });
  drawRight(page, 'EN PARTENARIAT AVEC', PAGE_W - margin, PAGE_H - bandH / 2 + 7 * mm, 8, fontBold, WHITE);
  const qw = 34 * mm, qh = qw * (qrtLogo.height / qrtLogo.width);
  page.drawImage(qrtLogo, { x: PAGE_W - margin - qw, y: PAGE_H - bandH / 2 - qh - 2 * mm, width: qw, height: qh });

  let y = PAGE_H - bandH - 16 * mm;
  page.drawText('BIENVENUE', { x: margin, y, size: 9, font: fontBold, color: BLUE_INK });
  y -= 10 * mm;
  const title = course ? course.title : cohort.name;
  const titleLines = wrapText(fontBold, 22, title, contentW);
  titleLines.forEach((ln, i) => page.drawText(ln, { x: margin, y: y - i * 9 * mm, size: 22, font: fontBold, color: INK }));
  y -= titleLines.length * 9 * mm + 2 * mm;

  const welcome = "Merci de nous rejoindre. Cette journée est pensée pour comprendre, expérimenter et appliquer l'IA concrètement.";
  wrapText(font, 11, welcome, contentW).forEach((ln, i) => page.drawText(ln, { x: margin, y: y - i * 5.5 * mm, size: 11, font, color: BODY }));
  y -= wrapText(font, 11, welcome, contentW).length * 5.5 * mm + 8 * mm;

  page.drawText('PROGRAMME', { x: margin, y, size: 9, font: fontBold, color: BLUE_INK });
  y -= 9 * mm;
  const gap = 6 * mm;
  const cardW = (contentW - gap * Math.max(0, sessions.length - 1)) / Math.max(1, sessions.length);
  const cardH = 24 * mm;
  sessions.forEach((s, i) => {
    const cx = margin + i * (cardW + gap);
    roundRect(page, cx, y - cardH, cardW, cardH, BLUE_SOFT);
    page.drawText(`Séance ${s.index}`, { x: cx + 6 * mm, y: y - 7 * mm, size: 10, font: fontBold, color: BLUE_INK });
    page.drawText(fmtLong(s.date), { x: cx + 6 * mm, y: y - 13 * mm, size: 10.5, font: fontBold, color: INK });
    page.drawText(`${s.start || ''}${s.end ? ' – ' + s.end : ''}`, { x: cx + 6 * mm, y: y - 18 * mm, size: 9, font, color: MUTED });
    const sub = i === sessions.length - 1 && sessions.length > 1 ? 'Avis global sur la formation' : 'Présence + avis sur la séance';
    page.drawText(sub, { x: cx + 6 * mm, y: y - 22.5 * mm, size: 7.5, font, color: BLUE_INK });
  });
  y -= cardH + 10 * mm;

  page.drawText('INFOS PRATIQUES', { x: margin, y, size: 9, font: fontBold, color: BLUE_INK });
  y -= 9 * mm;
  page.drawText('Lieu', { x: margin, y, size: 11, font: fontBold, color: INK });
  page.drawText(cohort.location || '', { x: margin + 28 * mm, y, size: 11, font, color: BODY });
  y -= 10 * mm;

  const noteH = 15 * mm;
  roundRect(page, margin, y - noteH, contentW, noteH, NOTE_BG);
  page.drawText('WIFI', { x: margin + 7 * mm, y: y - 6.5 * mm, size: 9, font: fontBold, color: NOTE_INK });
  page.drawText('Demander le code wifi au formateur sur place.', { x: margin + 28 * mm, y: y - 6.5 * mm, size: 10, font, color: NOTE_INK });
  y -= noteH + 12 * mm;

  const noteH2 = 15 * mm;
  roundRect(page, margin, y - noteH2, contentW, noteH2, BLUE_SOFT);
  page.drawText('À NE PAS OUBLIER', { x: margin + 7 * mm, y: y - 6.5 * mm, size: 9, font: fontBold, color: BLUE_INK });
  page.drawText('Remplis ta fiche de présence et donne ton avis sur la séance, depuis le lien ci-dessous.', { x: margin + 7 * mm, y: y - 11.5 * mm, size: 9, font, color: INK });
  y -= noteH2 + 12 * mm;

  const qrSize = 26 * mm;
  const presenceUrl = `${origin}/?c=${cohort.slug}`;
  drawQr(page, presenceUrl, margin, y - qrSize, qrSize, INK);
  page.drawText('Fiche de présence en ligne', { x: margin + qrSize + 8 * mm, y: y - 8 * mm, size: 10.5, font: fontBold, color: INK });
  page.drawText('(lien temporaire — pourra changer)', { x: margin + qrSize + 8 * mm, y: y - 13 * mm, size: 8.5, font, color: MUTED });
  page.drawText(presenceUrl, { x: margin + qrSize + 8 * mm, y: y - 18 * mm, size: 8, font, color: BLUE_INK });

  const footY = 20 * mm;
  page.drawLine({ start: { x: margin, y: footY + 6 * mm }, end: { x: PAGE_W - margin, y: footY + 6 * mm }, thickness: 0.8, color: LINE });
  page.drawText('Comprendre. Expérimenter. Appliquer.', { x: margin, y: footY, size: 9, font, color: MUTED });

  const bytes = await pdfDoc.save();
  return pdfResponse(bytes, `feuillet-${cohort.slug}.pdf`);
}
