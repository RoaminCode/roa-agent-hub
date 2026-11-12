'use strict';

// Gathers what HubSpot knows about one deal for the Roamer brief: the deal, its Roamer
// (the associated contact), and every call, text, email, and note on that contact.
// Communications live on the contact, not the deal, whichever department sent them.

const { safeError } = require('../errors');
const { isBriefNoteText, parseBriefNote } = require('../agents/briefNote');

// The first lines of Basecamp's own notes: its Q&A topics, WOW plans, and texts sent
// (hubspot/qaNotes.js, wowJob.js, textJob.js). Like the brief note, they are Basecamp's
// output, not the conversation, so they are never part of the record a brief reads (Blake's
// call, 2026-11-07). Reading them back made every answered question look like an edit and
// forced a full reread. A Team Member's note saved from a space is their own words and stays.
const BASECAMP_NOTE_MARKERS = ['Basecamp Q&A:', 'Basecamp WOW plan', 'Basecamp text sent'];
const isBasecampNoteText = (text) => isBriefNoteText(text) || BASECAMP_NOTE_MARKERS.some((m) => String(text || '').trimStart().startsWith(m));

// LightSpeed store CMF numbers as HubSpot stores them in `ls_cmf`.
const STORE_CMF = { UT: '76218125' };

const DEAL_PROPS = ['dealname', 'ls_deal_number', 'ls_cmf', 'dealstage', 'projected_delivery_date', 'hubspot_owner_id'];
const CONTACT_PROPS = ['firstname', 'lastname'];

// Per-type HubSpot properties and how much of each item's text to keep.
const SOURCES = {
  calls: {
    channel: 'call',
    props: ['hs_timestamp', 'hs_lastmodifieddate', 'hs_call_direction', 'hs_call_title', 'hs_call_summary', 'hs_call_body', 'hs_call_duration', 'hubspot_owner_id'],
    maxChars: 6000,
  },
  communications: { channel: 'text', props: ['hs_timestamp', 'hs_lastmodifieddate', 'hs_communication_channel_type', 'hs_communication_body'], maxChars: 1500 },
  emails: { channel: 'email', props: ['hs_timestamp', 'hs_lastmodifieddate', 'hs_email_direction', 'hs_email_subject', 'hs_email_text', 'hubspot_owner_id'], maxChars: 3000 },
  notes: { channel: 'note', props: ['hs_timestamp', 'hs_lastmodifieddate', 'hs_note_body', 'hubspot_owner_id'], maxChars: 3000 },
};

// Buttons offered when a deal has several contacts and Basecamp asks which is the Roamer.
const MAX_CHOICES = 6;

// About 100K tokens of record. Past this, the oldest items are left out and the brief says so.
const MAX_TOTAL_CHARS = 400000;

function cleanText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// A text sent through Aloware's API as the company has a blank sender.
const COMPANY_SENDER = 'Basecamp or the company';

// Aloware logs a text as "<sender> has sent an SMS to <number> | Line: ... | From: ... |
// Creator Type: ... | Message: | <text>". Keep who sent it and the message itself.
// Texts sent from HubSpot's conversations inbox carry the same header, ending in "Source:
// HubSpot Conversation", but no "Message:" line; the sender is still read from the header.
// `sender` is null when the record does not say.
function parseAlowareText(body) {
  const text = cleanText(body);
  const marker = text.search(/Message:\s*/i);
  const header = marker === -1 ? text : text.slice(0, marker);
  const message = marker === -1 ? text : text.slice(marker).replace(/^Message:\s*/i, '').trim();
  // A company send has no name, so after cleaning its header starts at "has sent an SMS".
  const sentBy = header.match(/^(.*?)\s*has sent an SMS/i);
  if (sentBy) return { sender: sentBy[1].trim() || COMPANY_SENDER, message };
  // A third format: a "Name (Rvs of America):" line, then the message. Only a named sender
  // from Rvs of America is read; no name, or another name in the brackets, is left unknown
  // rather than guessed.
  const named = text.match(/^\s*([^\n(]*?)\s*\(([^)\n]+)\):\s*\n?([\s\S]*)$/);
  if (named && /^rvs of america$/i.test(named[2].trim()) && named[1].trim()) return { sender: named[1].trim(), message: named[3].trim() };
  if (named) return { sender: null, message: named[3].trim() };
  return { sender: null, message };
}

// Aloware logs a call as a header ("<who> has made an outbound call to <number>", "Line:",
// "From:" or "Destination:", "Creator Type:") and then, when it has one, its own summary of
// the call. The header says nothing the item's date, direction, and owner do not.
function splitCallBody(body) {
  const lines = cleanText(body).split('\n');
  const end = lines.findIndex((l) => /^Creator Type:/i.test(l.trim()));
  if (end < 0) return { header: '', rest: lines.join('\n').trim() };
  // A line Aloware adds about its own bookkeeping is not part of the conversation.
  const rest = lines.slice(end + 1).filter((l) => !/^Agent .+ added the ".*" tag to this communication\.?$/i.test(l.trim()));
  return { header: lines.slice(0, end + 1).join('\n'), rest: rest.join('\n').trim() };
}

// What a call adds to the record. HubSpot and Aloware each write their own summary of the
// same call, so a call with both was read, and paid for, twice. Aloware's is kept when it
// is there: on real Utah calls (checked 2026-11-11) it names the Team Member and the Roamer
// from its own records, where HubSpot's summary guesses names from the audio and gets them
// wrong. HubSpot's is used when Aloware wrote none. A call nobody summarized (most are
// missed or unanswered) is kept as one short line, so the contact still shows.
function callText(p) {
  const { header, rest } = splitCallBody(p.hs_call_body);
  const hubspot = cleanText(p.hs_call_summary);
  // Every call is titled "Call with <name>"; only a title that says more is kept.
  const title = p.hs_call_title && !/^Call with\b/i.test(String(p.hs_call_title).trim()) ? `Title: ${p.hs_call_title}` : null;
  let said;
  if (/^Call Summary\b/i.test(rest)) said = [`Summary: ${rest.replace(/^Call Summary\s*/i, '')}`];
  else said = [hubspot && `Summary: ${hubspot}`, rest && `Notes: ${rest}`].filter(Boolean);
  if (said.length) return [title, ...said].filter(Boolean).join('\n');
  if (title) return title;
  if (/missed an incoming call/i.test(header)) return 'Missed call from the Roamer; not answered.';
  if (/missed an outbound call/i.test(header)) return 'ROA called; the Roamer did not answer.';
  if (/callback pending/i.test(header)) return 'The Roamer asked for a callback.';
  const seconds = Math.round(Number(p.hs_call_duration || 0) / 1000);
  if (!header && !seconds) return '';
  return seconds >= 60 ? `Call of ${Math.round(seconds / 60)} min; no summary recorded.` : 'Call of under a minute; no summary recorded.';
}

// Texts Aloware sends on its own, word for word the same to everyone (found on real Utah
// records, 2026-11-11). A Roamer's reply to one is its own item and is kept.
const AUTOMATED_TEXTS = [
  /^thanks for reaching out to roa off-road, you have reached us after business hours/i,
  /^hey there, thanks for reaching out to rvs of america! we.re sorry we missed your call/i,
];
const TEXT_HEADER_LINE = /has sent an SMS|^(Line|From|Destination|Creator Type|Source):|^Click here to respond$/i;

// What a text adds to the record: its message, without the "Click here to respond" link
// Aloware puts after it. Empty (so the item is left out) for a log entry with no message
// at all (a header only, as a picture message leaves), a message that is just "null", and
// Aloware's own automated replies.
function textMessage(body, message) {
  const raw = cleanText(body);
  if (!/Message:/i.test(raw) && /has sent an SMS/i.test(raw) && raw.split('\n').every((l) => !l.trim() || TEXT_HEADER_LINE.test(l.trim()))) return '';
  const text = String(message || '').replace(/\s*Click here to respond\s*$/i, '').trim();
  if (!text || /^null$/i.test(text) || AUTOMATED_TEXTS.some((re) => re.test(text))) return '';
  return text;
}

// Drop quoted earlier messages from an email reply so each email is counted once.
function stripQuotedReply(text) {
  const lines = text.split('\n');
  const cut = lines.findIndex((l) => /^On .+wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => !l.trim().startsWith('>'));
  return kept.join('\n').trim();
}

function clip(text, max) {
  return text.length > max ? { text: `${text.slice(0, max)} [cut]`, clipped: true } : { text, clipped: false };
}

function toItem(type, record, ownerName) {
  const p = record.properties || {};
  const { channel, maxChars } = SOURCES[type];
  const at = p.hs_timestamp || null;
  let who = null;
  let text = '';

  if (type === 'calls') {
    who = [p.hs_call_direction === 'INBOUND' ? 'inbound' : 'outbound', ownerName(p.hubspot_owner_id)].filter(Boolean).join(', ');
    text = callText(p);
  } else if (type === 'communications') {
    if (p.hs_communication_channel_type && p.hs_communication_channel_type !== 'SMS') return null;
    const parsed = parseAlowareText(p.hs_communication_body);
    who = parsed.sender && /^\+?\d[\d\s()-]+$/.test(parsed.sender) ? 'from the Roamer' : parsed.sender;
    text = textMessage(p.hs_communication_body, parsed.message);
  } else if (type === 'emails') {
    who = [p.hs_email_direction === 'INCOMING_EMAIL' ? 'from the Roamer' : 'to the Roamer', ownerName(p.hubspot_owner_id)].filter(Boolean).join(', ');
    text = [p.hs_email_subject && `Subject: ${p.hs_email_subject}`, stripQuotedReply(cleanText(p.hs_email_text))].filter(Boolean).join('\n');
  } else if (type === 'notes') {
    who = ownerName(p.hubspot_owner_id);
    text = cleanText(p.hs_note_body);
    // Basecamp's own notes are never part of the record: a past AI summary is not a
    // conversation, and reading it back would repeat its mistakes as fact.
    if (isBasecampNoteText(text)) return null;
  }

  if (!text) return null;
  // `modified` is when the item was last changed, such as a call summary filled in after the
  // call; an incremental brief update checks it (see briefJob.js).
  return { id: record.id, channel, at, modified: p.hs_lastmodifieddate || null, who, ...clip(text, maxChars) };
}

// HubSpot often holds the same text twice under two ids: same words, same second, same
// sender. The model would read and pay for it twice, so only the copy with the lowest id is
// kept. Anything that differs at all (the time, a word, the sender) stays.
function dropDuplicates(items) {
  const seen = new Set();
  const kept = [];
  const byId = [...items].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  for (const item of byId) {
    const key = JSON.stringify([item.channel, item.at, item.who, item.text.replace(/\s+/g, ' ').trim()]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  const keep = new Set(kept);
  return { items: items.filter((i) => keep.has(i)), duplicates: items.length - kept.length };
}

// Keep the newest items that fit the budget; report how many older ones were left out.
function fitBudget(items, maxChars = MAX_TOTAL_CHARS) {
  const newestFirst = [...items].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const kept = [];
  let used = 0;
  for (const item of newestFirst) {
    if (used + item.text.length > maxChars) break;
    kept.push(item);
    used += item.text.length;
  }
  kept.reverse();
  return { items: kept, omitted: items.length - kept.length };
}

// `db` is Basecamp's own records (db.js); without it, everything comes from HubSpot.
function createDealContext({ hubspot, db = null }) {
  const owners = new Map();

  // Names are cached for the life of the instance; a failed lookup is not, so the next
  // brief tries again.
  async function ownerNames(ids) {
    for (const id of new Set(ids.filter(Boolean))) {
      if (owners.has(id)) continue;
      try {
        const o = await hubspot.get(`/crm/v3/owners/${id}`);
        owners.set(id, [o.firstName, o.lastName].filter(Boolean).join(' ') || null);
      } catch {
        // Left out of the cache; this brief shows no name for this owner.
      }
    }
    return (id) => (id ? owners.get(id) || null : null);
  }

  async function associatedIds(fromType, fromId, toType) {
    const ids = [];
    let after;
    do {
      const page = await hubspot.get(
        `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}?limit=500${after ? `&after=${after}` : ''}`,
      );
      for (const r of page.results || []) ids.push(String(r.toObjectId));
      after = page.paging && page.paging.next ? page.paging.next.after : undefined;
    } while (after);
    return ids;
  }

  // A batch read can answer with some records and errors for the rest (HTTP 207), so
  // `missing` counts what was asked for and not returned.
  async function batchRead(type, ids, properties) {
    const records = [];
    for (let i = 0; i < ids.length; i += 100) {
      const page = await hubspot.post(`/crm/v3/objects/${type}/batch/read`, {
        properties,
        inputs: ids.slice(i, i + 100).map((id) => ({ id })),
      });
      records.push(...(page.results || []));
    }
    return { records, missing: Math.max(0, ids.length - records.length) };
  }

  // Null when no deal matches; { duplicate: true } when more than one does, rather than guessing.
  async function findDeal(store, dealNumber) {
    const cmf = STORE_CMF[store];
    if (!cmf) throw safeError(`unknown store ${store}`);
    const found = await hubspot.post('/crm/v3/objects/deals/search', {
      filterGroups: [
        {
          filters: [
            { propertyName: 'ls_deal_number', operator: 'EQ', value: String(dealNumber) },
            { propertyName: 'ls_cmf', operator: 'EQ', value: cmf },
          ],
        },
      ],
      properties: DEAL_PROPS,
      limit: 2,
    });
    const results = found.results || [];
    if (results.length > 1) return { duplicate: true };
    return results[0] || null;
  }

  // Basecamp's brief note on the deal, if there is one: { id, brief, signature }, with
  // brief and signature null when the note is not in Basecamp's layout (it is then
  // rewritten, never trusted). The newest wins if there is ever more than one.
  // With Basecamp's record of the deal (`record`, from the database), the note is read
  // directly by its id, and what the brief was built from comes from the record, which
  // no one edits by hand. Without one, or if that note is gone, the Roamer's notes are
  // searched. Never the deal's: a brief note from before 2026-11-07 still on a deal is left
  // alone, and a new one is written on the Roamer, since Basecamp never writes on a deal.
  async function findBriefNote(dealId, record = null, contactId = null) {
    if (record && record.briefNoteId) {
      const direct = await readBriefNote(record.briefNoteId);
      if (direct) return { ...direct, signature: record.briefSignature || direct.signature };
    }
    const ids = contactId ? await associatedIds('contacts', contactId, 'notes') : [];
    if (!ids.length) return null;
    const { records } = await batchRead('notes', ids, ['hs_note_body', 'hs_timestamp']);
    const ours = records
      .map((r) => ({ id: String(r.id), at: String((r.properties || {}).hs_timestamp || ''), text: cleanText((r.properties || {}).hs_note_body) }))
      .filter((n) => isBriefNoteText(n.text))
      .sort((a, b) => b.at.localeCompare(a.at));
    if (!ours.length) return null;
    const parsed = parseBriefNote(ours[0].text);
    return { id: ours[0].id, brief: parsed ? parsed.brief : null, signature: parsed ? parsed.signature : null, spaceName: parsed ? parsed.spaceName : null };
  }

  // One note by id, when it is Basecamp's brief note; null when it is gone, not ours, or on a
  // deal (from before 2026-11-07), so it is never updated there.
  async function readBriefNote(noteId) {
    if (!/^\d+$/.test(String(noteId))) return null;
    let note;
    try {
      note = await hubspot.get(`/crm/v3/objects/notes/${noteId}?properties=hs_note_body&associations=deals`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
    const onDeal = ((((note.associations || {}).deals || {}).results) || []).length > 0;
    const text = cleanText((note.properties || {}).hs_note_body);
    if (onDeal || !isBriefNoteText(text)) return null;
    const parsed = parseBriefNote(text);
    return { id: String(noteId), brief: parsed ? parsed.brief : null, signature: parsed ? parsed.signature : null, spaceName: parsed ? parsed.spaceName : null };
  }

  // The deal's space: Basecamp's record when there is one (the authority); otherwise the
  // space written on the brief note, from before the database.
  const spaceOf = (record, note) => (record ? record.spaceName || null : note ? note.spaceName : null);
  const recordOf = (dealId) => (db ? db.getDeal(dealId) : null);

  // The contact the deal's brief note was written for, if still on the deal; null otherwise.
  async function pickedBefore(dealId, contactIds) {
    const record = await recordOf(dealId);
    const note = await findBriefNote(dealId, record, record && record.contactId);
    const id = note && note.signature ? note.signature.contactId : null;
    return id && contactIds.includes(id) ? id : null;
  }

  // `contactId` is the Roamer someone picked when the deal has more than one contact.
  // `rememberPick`: with several contacts and none picked, use the Roamer the deal's brief
  // note was written for, if still on the deal. Opening a space uses it, so the Roamer
  // already picked for the brief is not asked for again.
  // Without it, a deal with several contacts returns `choices` instead of a context, so
  // Basecamp can ask which one is the Roamer rather than guess.
  async function load({ store = 'UT', dealNumber, contactId, rememberPick = false }) {
    const deal = await findDeal(store, dealNumber);
    if (!deal) return { found: false };
    if (deal.duplicate) return { found: false, duplicate: true };

    const contactIds = await associatedIds('deals', deal.id, 'contacts');
    if (contactIds.length === 0) return { found: true, deal, contact: null, items: [], omitted: 0, clipped: 0, missing: 0, counts: {} };

    let roamerId = contactIds[0];
    if (contactId) {
      // A picked contact must still be on this deal; an old button must not read someone else.
      if (!contactIds.includes(String(contactId))) return { found: true, deal, notOnDeal: true };
      roamerId = String(contactId);
    } else if (contactIds.length > 1 && rememberPick && (roamerId = await pickedBefore(deal.id, contactIds))) {
      // The Roamer picked for this deal's brief.
    } else if (contactIds.length > 1) {
      const { records: people } = await batchRead('contacts', contactIds.slice(0, MAX_CHOICES), CONTACT_PROPS);
      const choices = people.map((p) => ({ id: String(p.id), name: [p.properties.firstname, p.properties.lastname].filter(Boolean).join(' ') || `Contact ${p.id}` }));
      return { found: true, deal, choices, contactCount: contactIds.length };
    }

    const contact = (await batchRead('contacts', [roamerId], CONTACT_PROPS)).records[0];
    if (!contact) throw safeError('the Roamer contact could not be read');

    const records = {};
    let missing = 0;
    // Calls, texts, emails, and notes are read side by side: four waits become one.
    const reads = await Promise.all(
      Object.entries(SOURCES).map(async ([type, source]) => [type, await batchRead(type, await associatedIds('contacts', contact.id, type), source.props)]),
    );
    for (const [type, read] of reads) {
      records[type] = read.records;
      missing += read.missing;
    }

    const ownerIds = [deal.properties.hubspot_owner_id];
    for (const list of Object.values(records)) for (const r of list) ownerIds.push(r.properties.hubspot_owner_id);
    const ownerName = await ownerNames(ownerIds);

    const all = [];
    const counts = {};
    let duplicates = 0;
    // Records read but left out of the record the model sees: Basecamp's own notes, automated
    // texts, and entries with nothing in them.
    let filtered = 0;
    for (const [type, list] of Object.entries(records)) {
      const kept = list.map((r) => toItem(type, r, ownerName)).filter(Boolean);
      filtered += list.length - kept.length;
      const once = dropDuplicates(kept);
      counts[SOURCES[type].channel] = once.items.length;
      duplicates += once.duplicates;
      all.push(...once.items);
    }
    const { items, omitted } = fitBudget(all);
    const record = await recordOf(deal.id);
    const briefNote = await findBriefNote(deal.id, record, contact.id);

    return {
      found: true,
      store,
      deal,
      salesCoach: ownerName(deal.properties.hubspot_owner_id),
      contact,
      items,
      omitted,
      briefNote,
      // The deal's Chat space, or null.
      spaceName: spaceOf(record, briefNote),
      // The deal's Delivery record, once it has one; Basecamp's notes go there.
      deliveryId: (record && record.deliveryId) || null,
      // When the saved brief was written, how many updates since its last full read, and
      // when that was; null without Basecamp's records. Decides update or full rebuild.
      briefMeta: record && record.briefWrittenAt ? { writtenAt: record.briefWrittenAt, updates: record.briefUpdates || 0, fullAt: record.briefFullAt || null } : null,
      // Items kept but shortened to fit, and records HubSpot did not return.
      clipped: items.filter((i) => i.clipped).length,
      missing,
      // Copies of an item HubSpot holds twice, left out (dropDuplicates).
      duplicates,
      filtered,
      counts,
    };
  }

  // Just the deal, its Chat space, and its Roamer, without reading the Roamer's record. The
  // Roamer is the one the brief was written for; on a deal Basecamp has no record of yet
  // (never briefed), it is the deal's one contact. With several contacts and none picked,
  // `contactId` is null and `contactCount` says how many, so the caller can say so
  // instead of guessing.
  load.findDealSpace = async function findDealSpace({ store = 'UT', dealNumber }) {
    const deal = await findDeal(store, dealNumber);
    if (!deal || deal.duplicate) return null;
    const record = await recordOf(deal.id);
    // Basecamp's record already names the Roamer and the space; the note is read only without it.
    const note = record && record.contactId ? null : await findBriefNote(deal.id, record, record && record.contactId);
    let contactId = (record && record.contactId) || (note && note.signature && note.signature.contactId) || null;
    let contactCount = null;
    if (!contactId) {
      const onDeal = await associatedIds('deals', deal.id, 'contacts');
      contactCount = onDeal.length;
      if (onDeal.length === 1) [contactId] = onDeal;
    }
    return { deal, spaceName: spaceOf(record, note), contactId, contactCount, deliveryId: (record && record.deliveryId) || null };
  };

  load.readBriefNote = readBriefNote;
  return load;
}

module.exports = { callText, textMessage, splitCallBody, isBasecampNoteText, BASECAMP_NOTE_MARKERS, createDealContext, cleanText, parseAlowareText, stripQuotedReply, dropDuplicates, fitBudget, STORE_CMF, COMPANY_SENDER };
