'use strict';

// A Roamer brief kept in HubSpot as one note on the deal, which Basecamp updates in place
// each time it writes a new brief (Blake's call, 2026-11-06). The note reads cleanly for
// people in HubSpot, and it is written in a fixed layout so Basecamp can read the brief
// back exactly and reuse it when nothing new is in the record, spending no credits.
//
// Basecamp never reads this note as part of the Roamer's record: a past AI summary is not
// a conversation. It is found by its first line, MARKER.

const { isBrief, stampLine, noDashes } = require('./roamerBrief');

const MARKER = 'BASECAMP ROAMER BRIEF';
const HEADER = 'Written by AI from HubSpot; not checked against LightSpeed.';
const NO_PRICE = 'no price stated';

// What the brief was built from. A saved brief is reused only when the record still
// matches: the same Roamer, the same number of items, and the same newest item.
function briefSignature(context) {
  const items = context.items || [];
  const newest = items.map((i) => String(i.at || '')).sort().pop() || '';
  return { contactId: context.contact ? String(context.contact.id) : '', itemCount: items.length, newestAt: newest };
}

function sameSignature(a, b) {
  return Boolean(a && b) && a.contactId === b.contactId && a.itemCount === b.itemCount && a.newestAt === b.newestAt;
}

// One line of the layout: no line breaks, and no "|" inside a mod's fields.
const flat = (text) => noDashes(String(text)).replace(/\s+/g, ' ').trim();
const field = (text) => flat(text).replace(/\|/g, '/');
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function noteLines({ brief, context, now, spaceName }) {
  const sig = briefSignature(context);
  const item = (i) => `• ${flat(i.detail)} (${i.date}, ${i.channel})`;
  return [
    MARKER,
    `${HEADER} ${stampLine(context, now)}`,
    `Headline: ${flat(brief.headline)}`,
    `Tags: ${brief.tags.map(field).join(' | ')}`,
    ...brief.key_facts.map((f) => `Fact: ${field(f.label)} | ${field(f.value)}`),
    'WOW',
    ...brief.wow.map(item),
    'MODS',
    // HubSpot collapses the double space an empty price would leave, so it is spelled out.
    ...brief.mods.map((m) => `• ${field(m.name)} | ${field(m.price) || NO_PRICE} | ${m.status} (${m.date}, ${m.channel})`),
    'JOURNEY',
    ...brief.journey.map(item),
    `Basecamp key: contact ${sig.contactId}, ${sig.itemCount} items, newest ${sig.newestAt || 'none'}${spaceName ? `, space ${spaceName}` : ''}`,
  ];
}

// The note body as HubSpot stores it: one paragraph per line. `spaceName` is the deal's
// Chat space, when it has one; the note is where Basecamp remembers it.
function renderBriefNote({ brief, context, now = new Date(), spaceName = null }) {
  return noteLines({ brief, context, now, spaceName })
    .map((line, i) => (i === 0 ? `<p><strong>${escapeHtml(line)}</strong></p>` : `<p>${escapeHtml(line)}</p>`))
    .join('');
}

function isBriefNoteText(text) {
  return String(text || '').trimStart().startsWith(MARKER);
}

const ITEM_LINE = /^• (.*) \((\d{4}-\d{2}-\d{2}), (call|text|email|note)\)$/;

// Reads a brief back from a note's plain text (HTML already cleaned). Null when the note
// is not in the layout, so a hand-edited or damaged note is rewritten, never trusted.
function parseBriefNote(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines[0] !== MARKER) return null;
  const brief = { headline: '', tags: [], key_facts: [], wow: [], mods: [], journey: [] };
  let signature = null;
  let spaceName = null;
  let section = null;
  for (const line of lines.slice(1)) {
    if (line === 'WOW' || line === 'MODS' || line === 'JOURNEY') {
      section = line.toLowerCase();
      continue;
    }
    let m;
    if ((m = /^Headline: (.*)$/.exec(line))) brief.headline = m[1];
    else if ((m = /^Tags: ?(.*)$/.exec(line))) brief.tags = m[1] ? m[1].split(' | ') : [];
    else if ((m = /^Fact: (.*?) \| (.*)$/.exec(line))) brief.key_facts.push({ label: m[1], value: m[2] });
    else if ((m = /^Basecamp key: contact (\d*), (\d+) items, newest (.*?)(?:, space (spaces\/[\w-]+))?$/.exec(line))) {
      signature = { contactId: m[1], itemCount: Number(m[2]), newestAt: m[3] === 'none' ? '' : m[3] };
      spaceName = m[4] || null;
    } else if (section && (m = ITEM_LINE.exec(line))) {
      const [, body, date, channel] = m;
      if (section === 'mods') {
        const parts = /^(.*) \| (.*) \| (approved|pending|interested|declined)$/.exec(body);
        if (!parts) return null;
        brief.mods.push({ name: parts[1], price: parts[2] === NO_PRICE ? '' : parts[2], status: parts[3], date, channel });
      } else {
        brief[section].push({ detail: body, date, channel });
      }
    } else if (!line.startsWith(HEADER)) {
      return null;
    }
  }
  if (!signature || !brief.headline || !isBrief(brief)) return null;
  return { brief, signature, spaceName };
}

module.exports = { MARKER, renderBriefNote, parseBriefNote, isBriefNoteText, briefSignature, sameSignature };
