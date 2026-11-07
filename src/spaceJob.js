'use strict';

// Opens a deal space: a Google Chat space for one open deal, with the person who asked as
// its member and the Roamer brief as its first post, for a person to pin (Chat apps cannot
// pin). The space is remembered on the deal's brief note in HubSpot, so a deal gets one
// space. Logs steps and timing, never Roamer details.

const { errorFields, isOutOfCredits } = require('./errors');
const { renderBriefCard } = require('./chat/briefCard');
const { shortDate } = require('./agents/roamerBrief');
const { OPEN_STAGE } = require('./hubspot/openDeals');
const { SORRY: BRIEF_SORRY } = require('./briefJob');

const SAY = {
  ...BRIEF_SORRY,
  severalContacts: (n) => `Deal ${n} has more than one contact in HubSpot. Ask me for "brief ${n}" first and pick the Roamer, then open the space.`,
  closed: (n) => `Deal ${n} isn't open in HubSpot (it is finalized or lost), so it doesn't get a space.`,
  exists: (n, uri) => `Deal ${n} already has a space${uri ? `: ${uri}` : '.'}`,
  opened: (n, roamer, uri) => `Opened the space for deal ${n}${roamer ? `, ${roamer}` : ''}${uri ? `: ${uri}` : '.'}`,
  pinIt: 'This is the deal space. Pin the brief above so it stays at hand: open its menu and choose Pin.',
  // Google refuses until a Workspace admin approves Basecamp creating spaces and adding people.
  notApproved: "I couldn't create the space: Google hasn't approved Basecamp creating spaces yet. Blake can see which permission is missing in the logs.",
  failed: (n) => `I couldn't open the space for deal ${n}. Blake can see what happened in the logs.`,
};

function roamerName(context) {
  const c = (context.contact && context.contact.properties) || {};
  return [c.firstname, c.lastname].filter(Boolean).join(' ');
}

// "Deal 90001 · Delivery Nov 14 · Sales Coach Casey Coach", shown in the space's details.
function describe(dealNumber, context) {
  const d = context.deal.properties;
  return [
    `Deal ${dealNumber}`,
    d.projected_delivery_date ? `Delivery ${shortDate(String(d.projected_delivery_date))}` : null,
    context.salesCoach ? `Sales Coach ${context.salesCoach}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function createSpaceJob({ loadContext, getBrief, keepNote, spaces, sendMessage, log, avatarUrl }) {
  // `spaceName` is where the request came from (a direct message), for replies. `userName`
  // ("users/123") is who asked, and becomes the space's member.
  return async function openSpace({ spaceName, userName, dealNumber, store = 'UT' }) {
    const started = Date.now();
    let step = 'load';
    const reply = (text) => sendMessage(spaceName, text);
    try {
      const context = await loadContext({ store, dealNumber, rememberPick: true });
      if (context.duplicate) return await reply(SAY.duplicate(dealNumber, store));
      if (!context.found) return await reply(SAY.notFound(dealNumber, store));
      if (context.choices) return await reply(SAY.severalContacts(dealNumber));
      if (!context.contact) {
        log('WARNING', 'deal has no Roamer contact', { dealNumber, store });
        return await reply(SAY.noContact(dealNumber));
      }
      if (context.deal.properties.dealstage !== OPEN_STAGE) return await reply(SAY.closed(dealNumber));

      step = 'check existing';
      const recorded = context.briefNote && context.briefNote.spaceName;
      if (recorded) {
        const existing = await spaces.findSpace(recorded);
        if (existing) return await reply(SAY.exists(dealNumber, existing.uri));
      }

      step = 'brief';
      const got = await getBrief({ context, dealNumber, started });
      if (!got) return await reply(SAY.failed(dealNumber));

      step = 'create space';
      const roamer = roamerName(context);
      const space = await spaces.createSpace({ displayName: [dealNumber, roamer].filter(Boolean).join(' · '), description: describe(dealNumber, context) });
      step = 'add member';
      await spaces.addMember(space.name, userName);
      step = 'post brief';
      await sendMessage(space.name, renderBriefCard({ dealNumber, context, brief: got.brief, avatarUrl }));
      await sendMessage(space.name, SAY.pinIt);

      step = 'save note';
      await keepNote({ context, brief: got.brief, dealNumber, spaceName: space.name });
      log('INFO', 'deal space opened', { dealNumber, space: space.name, reusedBrief: got.reused, ms: Date.now() - started });
      await reply(SAY.opened(dealNumber, roamer, space.uri));
    } catch (err) {
      const noCredits = isOutOfCredits(err);
      const status = err.status || (err.response && err.response.status);
      const notApproved = (step === 'create space' || step === 'add member') && (status === 403 || status === 401);
      log('ERROR', noCredits ? 'open space failed: out of AI credits' : 'open space failed', { dealNumber, step, error: errorFields(err), ms: Date.now() - started });
      const text = noCredits ? SAY.noCredits : notApproved ? SAY.notApproved : SAY.failed(dealNumber);
      await reply(text).catch((e) => log('ERROR', 'could not post open space failure', { dealNumber, error: errorFields(e) }));
    }
  };
}

module.exports = { createSpaceJob, SAY };
