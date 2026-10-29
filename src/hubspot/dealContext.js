'use strict';

// Gathers what HubSpot knows about one deal for the Roamer brief: the deal, its Roamer
// (the associated contact), and every call, text, email, and note on that contact.
// Communications live on the contact, not the deal, whichever department sent them.

const { safeError } = require('../errors');

// LightSpeed store CMF numbers as HubSpot stores them in `ls_cmf`.
const STORE_CMF = { UT: '76218125' };

const DEAL_PROPS = ['dealname', 'ls_deal_number', 'ls_cmf', 'dealstage', 'projected_delivery_date', 'hubspot_owner_id'];
const CONTACT_PROPS = ['firstname', 'lastname'];

// Per-type HubSpot properties and how much of each item's text to keep.
const SOURCES = {
  calls: {
    channel: 'call',
    props: ['hs_timestamp', 'hs_call_direction', 'hs_call_title', 'hs_call_summary', 'hs_call_body', 'hs_call_duration', 'hubspot_owner_id'],
    maxChars: 6000,
  },
  communications: { channel: 'text', props: ['hs_timestamp', 'hs_communication_channel_type', 'hs_communication_body'], maxChars: 1500 },
  emails: { channel: 'email', props: ['hs_timestamp', 'hs_email_direction', 'hs_email_subject', 'hs_email_text', 'hubspot_owner_id'], maxChars: 3000 },
  notes: { channel: 'note', props: ['hs_timestamp', 'hs_note_body', 'hubspot_owner_id'], maxChars: 3000 },
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
  if (!sentBy) return { sender: null, message };
  return { sender: sentBy[1].trim() || COMPANY_SENDER, message };
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
    text = [
      p.hs_call_title && `Title: ${p.hs_call_title}`,
      p.hs_call_summary && `Summary: ${cleanText(p.hs_call_summary)}`,
      p.hs_call_body && `Notes: ${cleanText(p.hs_call_body)}`,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (type === 'communications') {
    if (p.hs_communication_channel_type && p.hs_communication_channel_type !== 'SMS') return null;
    const parsed = parseAlowareText(p.hs_communication_body);
    who = parsed.sender && /^\+?\d[\d\s()-]+$/.test(parsed.sender) ? 'from the Roamer' : parsed.sender;
    text = parsed.message;
  } else if (type === 'emails') {
    who = [p.hs_email_direction === 'INCOMING_EMAIL' ? 'from the Roamer' : 'to the Roamer', ownerName(p.hubspot_owner_id)].filter(Boolean).join(', ');
    text = [p.hs_email_subject && `Subject: ${p.hs_email_subject}`, stripQuotedReply(cleanText(p.hs_email_text))].filter(Boolean).join('\n');
  } else if (type === 'notes') {
    who = ownerName(p.hubspot_owner_id);
    text = cleanText(p.hs_note_body);
  }

  if (!text) return null;
  return { id: record.id, channel, at, who, ...clip(text, maxChars) };
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

function createDealContext({ hubspot }) {
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

  // `contactId` is the Roamer someone picked when the deal has more than one contact.
  // Without it, a deal with several contacts returns `choices` instead of a context, so
  // Basecamp can ask which one is the Roamer rather than guess.
  return async function load({ store = 'UT', dealNumber, contactId }) {
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
    } else if (contactIds.length > 1) {
      const { records: people } = await batchRead('contacts', contactIds.slice(0, MAX_CHOICES), CONTACT_PROPS);
      const choices = people.map((p) => ({ id: String(p.id), name: [p.properties.firstname, p.properties.lastname].filter(Boolean).join(' ') || `Contact ${p.id}` }));
      return { found: true, deal, choices, contactCount: contactIds.length };
    }

    const contact = (await batchRead('contacts', [roamerId], CONTACT_PROPS)).records[0];
    if (!contact) throw safeError('the Roamer contact could not be read');

    const records = {};
    let missing = 0;
    for (const [type, source] of Object.entries(SOURCES)) {
      const ids = await associatedIds('contacts', contact.id, type);
      const read = await batchRead(type, ids, source.props);
      records[type] = read.records;
      missing += read.missing;
    }

    const ownerIds = [deal.properties.hubspot_owner_id];
    for (const list of Object.values(records)) for (const r of list) ownerIds.push(r.properties.hubspot_owner_id);
    const ownerName = await ownerNames(ownerIds);

    const all = [];
    const counts = {};
    for (const [type, list] of Object.entries(records)) {
      const items = list.map((r) => toItem(type, r, ownerName)).filter(Boolean);
      counts[SOURCES[type].channel] = items.length;
      all.push(...items);
    }
    const { items, omitted } = fitBudget(all);

    return {
      found: true,
      deal,
      salesCoach: ownerName(deal.properties.hubspot_owner_id),
      contact,
      items,
      omitted,
      // Items kept but shortened to fit, and records HubSpot did not return.
      clipped: items.filter((i) => i.clipped).length,
      missing,
      counts,
    };
  };
}

module.exports = { createDealContext, cleanText, parseAlowareText, stripQuotedReply, fitBudget, STORE_CMF, COMPANY_SENDER };
