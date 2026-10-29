'use strict';

// Gathers what HubSpot knows about one deal for the Roamer brief: the deal, its Roamer
// (the associated contact), and every call, text, email, and note on that contact.
// Communications live on the contact, not the deal, whichever department sent them.

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

// Aloware logs a text as "<sender> has sent an SMS to <number> | Line: ... | From: ... |
// Creator Type: ... | Message: | <text>". Keep who sent it and the message itself.
function parseAlowareText(body) {
  const text = cleanText(body);
  const marker = text.search(/Message:\s*/i);
  if (marker === -1) return { sender: null, message: text };
  const header = text.slice(0, marker);
  const message = text.slice(marker).replace(/^Message:\s*/i, '').trim();
  const sentBy = header.match(/^(.*?) has sent an SMS/i);
  const sender = sentBy && sentBy[1].trim() ? sentBy[1].trim() : 'Basecamp or the company';
  return { sender, message };
}

// Drop quoted earlier messages from an email reply so each email is counted once.
function stripQuotedReply(text) {
  const lines = text.split('\n');
  const cut = lines.findIndex((l) => /^On .+wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => !l.trim().startsWith('>'));
  return kept.join('\n').trim();
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)} [cut]` : text;
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
  return { id: record.id, channel, at, who, text: clip(text, maxChars) };
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

  async function ownerNames(ids) {
    for (const id of new Set(ids.filter(Boolean))) {
      if (owners.has(id)) continue;
      try {
        const o = await hubspot.get(`/crm/v3/owners/${id}`);
        owners.set(id, [o.firstName, o.lastName].filter(Boolean).join(' ') || null);
      } catch {
        owners.set(id, null);
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

  async function batchRead(type, ids, properties) {
    const records = [];
    for (let i = 0; i < ids.length; i += 100) {
      const page = await hubspot.post(`/crm/v3/objects/${type}/batch/read`, {
        properties,
        inputs: ids.slice(i, i + 100).map((id) => ({ id })),
      });
      records.push(...(page.results || []));
    }
    return records;
  }

  async function findDeal(store, dealNumber) {
    const cmf = STORE_CMF[store];
    if (!cmf) throw new Error(`unknown store ${store}`);
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
    return found.results && found.results[0] ? found.results[0] : null;
  }

  return async function load({ store = 'UT', dealNumber }) {
    const deal = await findDeal(store, dealNumber);
    if (!deal) return { found: false };

    const contactIds = await associatedIds('deals', deal.id, 'contacts');
    if (contactIds.length === 0) return { found: true, deal, contact: null, items: [], omitted: 0, counts: {} };

    // The first associated contact is the Roamer; co-buyers come later and are not read yet.
    const [contact] = await batchRead('contacts', [contactIds[0]], CONTACT_PROPS);

    const records = {};
    for (const [type, source] of Object.entries(SOURCES)) {
      const ids = await associatedIds('contacts', contact.id, type);
      records[type] = await batchRead(type, ids, source.props);
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
      counts,
    };
  };
}

module.exports = { createDealContext, cleanText, parseAlowareText, stripQuotedReply, fitBudget, STORE_CMF };
