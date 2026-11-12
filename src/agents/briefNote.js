'use strict';

// A Roamer brief kept in HubSpot as one note on the Roamer (and the Delivery record), which Basecamp updates in place
// each time it writes a new brief (Blake's call, 2026-11-06). The note reads cleanly for
// people in HubSpot, and it is written in a fixed layout so Basecamp can read the brief
// back exactly and reuse it when nothing new is in the record, spending no credits.
//
// Basecamp never reads this note as part of the Roamer's record: a past AI summary is not
// a conversation. It is found by its first line, MARKER.

const { createHash } = require('crypto');
const { isBrief, stampLine, noDashes } = require('./roamerBrief');

const MARKER = 'BASECAMP ROAMER BRIEF';
const HEADER = 'Written by AI from HubSpot; not checked against LightSpeed.';
const NO_PRICE = 'no price stated';

// What the brief was built from. A saved brief is reused only when the record still
// matches: the same Roamer, the same number of items, the same newest item, the same items
// (`ids`, a short hash of their ids, kept in Basecamp's records), so an old item removed
// and another added in its place is not mistaken for no change, and the same words
// (`content`, a hash of what each item says), so an item edited later is caught by what
// changed in it, not by HubSpot moving its "last modified" date for some other reason.
function contentHash(items) {
  const each = (items || []).map((i) => `${i.id}\u0000${i.who || ''}\u0000${i.text || ''}`).sort();
  return createHash('sha1').update(each.join('\u0001')).digest('hex').slice(0, 16);
}

function briefSignature(context) {
  const items = context.items || [];
  const newest = items.map((i) => String(i.at || '')).sort().pop() || '';
  const ids = createHash('sha1').update(items.map((i) => String(i.id)).sort().join(',')).digest('hex').slice(0, 16);
  return { contactId: context.contact ? String(context.contact.id) : '', itemCount: items.length, newestAt: newest, ids, content: contentHash(items) };
}

// `a` is the saved signature; one saved before `ids` or `content` existed is compared without it.
function sameSignature(a, b) {
  return Boolean(a && b) && a.contactId === b.contactId && a.itemCount === b.itemCount && a.newestAt === b.newestAt && (!a.ids || a.ids === b.ids) && (!a.content || a.content === b.content);
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
    `Who they are: ${flat(brief.who)}`,
    ...brief.excites.map((e) => `Excites: ${flat(e)}`),
    `Journey so far: ${flat(brief.journey_summary)}`,
    ...brief.open_questions.map((q) => `Open question: ${flat(q)}`),
    `Tags: ${brief.tags.map(field).join(' | ')}`,
    ...brief.key_facts.map((f) => `Fact: ${field(f.label)} | ${field(f.value)}`),
    'WOW',
    ...brief.wow.map(item),
    'MODS',
    // HubSpot collapses the double space an empty price would leave, so it is spelled out.
    ...brief.mods.map((m) => `• ${field(m.name)} | ${field(m.price) || NO_PRICE} | ${m.status} (${m.date}, ${m.channel})`),
    'COMMITMENTS AND NEXT STEPS',
    ...brief.commitments.map(item),
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

const SECTIONS = { WOW: 'wow', MODS: 'mods', 'COMMITMENTS AND NEXT STEPS': 'commitments' };
const ITEM_LINE = /^• (.*) \((\d{4}-\d{2}-\d{2}), (call|text|email|note)\)$/;

// Reads a brief back from a note's plain text (HTML already cleaned). Null when the note
// is not in the layout, so a hand-edited or damaged note is rewritten, never trusted.
function parseBriefNote(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines[0] !== MARKER) return null;
  // The card's pieces start unset, so a note written before they existed fails isBrief and
  // the deal gets a full read.
  const brief = { headline: '', tags: [], key_facts: [], wow: [], mods: [], commitments: [], who: null, excites: [], journey_summary: null, open_questions: [] };
  let signature = null;
  let spaceName = null;
  let section = null;
  for (const line of lines.slice(1)) {
    // A note written when the last list was JOURNEY has no heading here, so it is not
    // read back and the deal gets a full read under the current rules.
    if (SECTIONS[line]) {
      section = SECTIONS[line];
      continue;
    }
    let m;
    if ((m = /^Headline: (.*)$/.exec(line))) brief.headline = m[1];
    else if ((m = /^Who they are: ?(.*)$/.exec(line))) brief.who = m[1];
    else if ((m = /^Excites: (.*)$/.exec(line))) brief.excites.push(m[1]);
    else if ((m = /^Journey so far: ?(.*)$/.exec(line))) brief.journey_summary = m[1];
    else if ((m = /^Open question: (.*)$/.exec(line))) brief.open_questions.push(m[1]);
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
  // Read back from a saved note: a part added since it was written may be missing.
  if (!signature || !brief.headline || !isBrief(brief, { saved: true })) return null;
  return { brief, signature, spaceName };
}

module.exports = { MARKER, renderBriefNote, parseBriefNote, isBriefNoteText, briefSignature, sameSignature, contentHash };
