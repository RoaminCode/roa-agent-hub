'use strict';

// Lists a store's open deals for App Home: deals in the "Deals" stage (deposit received,
// not yet Finalized or Lost), soonest projected delivery first. No per-deal lookups: the
// Roamer and trailer come from the deal name, and last contact comes from batch reads and
// a few searches across all deals together.

const { safeError, errorFields } = require('../errors');
const { STORE_CMF, parseAlowareText, COMPANY_SENDER } = require('./dealContext');

// The engagement types that move Last Contacted, and what to read from each to say who
// made the contact.
const CONTACT_TYPES = {
  calls: { channel: 'call', props: ['hs_timestamp', 'hubspot_owner_id', 'hs_call_direction'] },
  communications: { channel: 'text', props: ['hs_timestamp', 'hs_communication_channel_type', 'hs_communication_body'] },
  emails: { channel: 'email', props: ['hs_timestamp', 'hubspot_owner_id', 'hs_email_direction'] },
};
// HubSpot allows five filter groups per search: one per Last Contacted moment.
const MOMENTS_PER_SEARCH = 5;

// Sales Pipeline stage "Deals". Finalized and Lost Deal are the closed stages.
const OPEN_STAGE = '85341732';

const PROPS = ['dealname', 'ls_deal_number', 'projected_delivery_date', 'hubspot_owner_id'];

// Deal names read "51436 - Scott Henderson - 2026 Pause PETRE19.6-AR".
function parseDealName(dealname) {
  const parts = String(dealname || '').split(/\s+-\s+/);
  if (parts.length >= 3 && /^\d+$/.test(parts[0])) return { roamer: parts[1], trailer: parts.slice(2).join(' - ') };
  if (parts.length === 2 && /^\d+$/.test(parts[0])) return { roamer: parts[1], trailer: null };
  return { roamer: dealname || null, trailer: null };
}

function createOpenDeals({ hubspot }) {
  const owners = new Map();

  // Names are cached for the life of the instance; a failed lookup is not, so it is tried
  // again next time instead of hiding the name until a restart.
  async function ownerName(id) {
    if (!id) return null;
    if (!owners.has(id)) {
      try {
        const o = await hubspot.get(`/crm/v3/owners/${id}`);
        owners.set(id, o.firstName || [o.firstName, o.lastName].filter(Boolean).join(' ') || null);
      } catch {
        return null;
      }
    }
    return owners.get(id);
  }

  return async function listOpenDeals({ store = 'UT' } = {}) {
    const cmf = STORE_CMF[store];
    if (!cmf) throw safeError(`unknown store ${store}`);
    const deals = [];
    let after;
    do {
      const page = await hubspot.post('/crm/v3/objects/deals/search', {
        filterGroups: [
          {
            filters: [
              { propertyName: 'ls_cmf', operator: 'EQ', value: cmf },
              { propertyName: 'dealstage', operator: 'EQ', value: OPEN_STAGE },
            ],
          },
        ],
        properties: PROPS,
        sorts: [{ propertyName: 'projected_delivery_date', direction: 'ASCENDING' }],
        limit: 100,
        ...(after ? { after } : {}),
      });
      deals.push(...(page.results || []));
      after = page.paging && page.paging.next ? page.paging.next.after : undefined;
    } while (after);

    const contactLast = await contactLastContacted(deals.map((d) => d.id));
    // Who made the last contact is extra: if finding it fails, Home still shows the deals.
    const by = await lastContactBy([...contactLast.values()]).catch((err) => {
      console.log(JSON.stringify({ severity: 'WARNING', message: 'last contact names unavailable', error: errorFields(err) }));
      return new Map();
    });

    const out = [];
    for (const d of deals) {
      const p = d.properties || {};
      const { roamer, trailer } = parseDealName(p.dealname);
      // Only the Roamer's own Last Contacted counts; the deal's copy lags and is never used.
      const fromContact = contactLast.get(d.id);
      const last = fromContact ? fromContact.at : null;
      const who = fromContact ? by.get(fromContact.contactId) : null;
      out.push({
        id: d.id,
        dealNumber: p.ls_deal_number || null,
        roamer,
        trailer,
        projectedDelivery: p.projected_delivery_date ? String(p.projected_delivery_date).slice(0, 10) : null,
        // The full timestamp: Home turns it into a date in the Experience Center's time zone.
        lastContacted: last ? String(last) : null,
        lastContactBy: who ? who.who : null,
        lastContactChannel: who ? who.channel : null,
        // More than one means Basecamp will ask which is the Roamer when a brief is asked for.
        contacts: fromContact ? fromContact.contacts : 0,
        salesCoach: await ownerName(p.hubspot_owner_id),
      });
    }
    return out;
  };

  // Who made each Roamer's last contact. HubSpot gives the moment (Last Contacted); this
  // finds the call, text, or email logged at that moment, checks it belongs to that Roamer,
  // and reads who it was. A few searches for all deals, not a read of every history.
  // `entries` are { contactId, at }. Returns Map(contactId -> { who, channel }).
  async function lastContactBy(entries) {
    const found = new Map();
    const wanted = entries.filter((e) => e.at && !Number.isNaN(Date.parse(e.at)));
    if (!wanted.length) return found;
    const moments = [...new Set(wanted.map((e) => Date.parse(e.at)))];

    // The three types are searched in parallel; the client's 429 retry covers a burst.
    const byType = await Promise.all(Object.entries(CONTACT_TYPES).map(([type, spec]) => findAt(type, spec, moments)));
    for (const { type, spec, candidates, contactsOf } of byType) {
      for (const e of wanted) {
        if (found.has(e.contactId)) continue;
        const at = Date.parse(e.at);
        const matches = candidates.filter(
          (c) => Math.abs(Date.parse(c.properties.hs_timestamp) - at) <= 1000 && (contactsOf.get(String(c.id)) || new Set()).has(e.contactId),
        );
        // The first match that shows who made it; one that does not is skipped, not guessed.
        for (const match of matches) {
          const who = await contactMaker(type, match.properties);
          if (who) {
            found.set(e.contactId, { who, channel: spec.channel });
            break;
          }
        }
      }
    }
    return found;
  }

  // Engagements of one type logged at any of the given moments, with their contacts.
  async function findAt(type, spec, moments) {
    const candidates = [];
    for (let i = 0; i < moments.length; i += MOMENTS_PER_SEARCH) {
      const page = await hubspot.post(`/crm/v3/objects/${type}/search`, {
        // Within a second either side: Last Contacted and the engagement can differ in milliseconds.
        filterGroups: moments.slice(i, i + MOMENTS_PER_SEARCH).map((t) => ({
          filters: [
            { propertyName: 'hs_timestamp', operator: 'GTE', value: String(t - 1000) },
            { propertyName: 'hs_timestamp', operator: 'LTE', value: String(t + 1000) },
          ],
        })),
        properties: spec.props,
        limit: 100,
      });
      candidates.push(...(page.results || []));
    }
    const contactsOf = new Map();
    for (let i = 0; i < candidates.length; i += 100) {
      const page = await hubspot.post(`/crm/v4/associations/${type}/contacts/batch/read`, {
        inputs: candidates.slice(i, i + 100).map((c) => ({ id: c.id })),
      });
      for (const r of page.results || []) contactsOf.set(String(r.from.id), new Set((r.to || []).map((t) => String(t.toObjectId))));
    }
    return { type, spec, candidates, contactsOf };
  }

  // Who made one contact: the Roamer, Basecamp (texts sent through the API), or the Team
  // Member, by first name.
  // Null when the record does not show who it was.
  async function contactMaker(type, p) {
    if (type === 'emails') return p.hs_email_direction === 'INCOMING_EMAIL' ? 'the Roamer' : (await ownerName(p.hubspot_owner_id)) || 'a Team Member';
    if (type === 'calls') return (await ownerName(p.hubspot_owner_id)) || (p.hs_call_direction === 'INBOUND' ? 'the Roamer' : 'a Team Member');
    if (p.hs_communication_channel_type && p.hs_communication_channel_type !== 'SMS') return null;
    const { sender } = parseAlowareText(p.hs_communication_body);
    if (!sender) return null;
    if (sender === COMPANY_SENDER) return 'Basecamp';
    if (/^\+?\d[\d\s()-]+$/.test(sender)) return 'the Roamer';
    return sender.replace(/\s*\(.*\)\s*$/, '').split(/\s+/)[0];
  }

  // Last Contacted from each deal's Roamer, not the deal. Texts and calls are logged on
  // the contact, and the deal's own copy can lag by weeks (seen on a Utah deal, 2026-10-29).
  // Two batch calls for all deals. Returns Map(dealId -> { contactId, at, contacts }), where
  // `contacts` is how many contacts the deal has and `at` is null when there is no contact yet.
  async function contactLastContacted(dealIds) {
    const byDeal = new Map();
    if (!dealIds.length) return byDeal;
    const firstContact = new Map();
    const contactCount = new Map();
    for (let i = 0; i < dealIds.length; i += 100) {
      const page = await hubspot.post('/crm/v4/associations/deals/contacts/batch/read', {
        inputs: dealIds.slice(i, i + 100).map((id) => ({ id })),
      });
      for (const r of page.results || []) {
        if (r.to && r.to[0]) {
          firstContact.set(String(r.from.id), String(r.to[0].toObjectId));
          contactCount.set(String(r.from.id), r.to.length);
        }
      }
    }
    const contactIds = [...new Set(firstContact.values())];
    const lastByContact = new Map();
    for (let i = 0; i < contactIds.length; i += 100) {
      const page = await hubspot.post('/crm/v3/objects/contacts/batch/read', {
        properties: ['notes_last_contacted'],
        inputs: contactIds.slice(i, i + 100).map((id) => ({ id })),
      });
      for (const c of page.results || []) lastByContact.set(String(c.id), c.properties && c.properties.notes_last_contacted);
    }
    for (const [dealId, contactId] of firstContact) {
      byDeal.set(dealId, { contactId, at: lastByContact.get(contactId) || null, contacts: contactCount.get(dealId) });
    }
    return byDeal;
  }
}

module.exports = { createOpenDeals, parseDealName, OPEN_STAGE };
