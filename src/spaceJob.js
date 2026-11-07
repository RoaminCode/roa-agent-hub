'use strict';

// Deal spaces: a Google Chat space for one open deal, with the Roamer brief as its first
// post, for a person to pin (Chat apps cannot pin). Two ways in:
//   openSpace: Basecamp creates the space and adds the person who asked (needs the admin-
//              approved scopes for creating spaces and adding people).
//   useSpace:  a person creates the space, names it with the deal number first, adds
//              Basecamp, and says "use this space for <deal#>" in it. Needs no approval.
// Either way the space is remembered on the deal's brief note in HubSpot, so a deal gets
// one space. Logs steps and timing, never Roamer details.

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
  // Notes find their deal by the number at the start of the space's name.
  rename: (n) => `Name this space starting with the deal number, such as "${n} · Roamer name", then ask me again.`,
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

// Whether a space's name starts with the deal number.
const namedFor = (displayName, dealNumber) => new RegExp(`^#?${dealNumber}\\b`).test(String(displayName || '').trim());

function createSpaceJob({ loadContext, getBrief, keepNote, spaces, sendMessage, log, avatarUrl }) {
  // The deal's context when it may get a space, else the reply that says why not. A deal
  // whose recorded space still exists (and is not `here`) gets that space's link.
  async function check({ dealNumber, store, here = null }) {
    const context = await loadContext({ store, dealNumber, rememberPick: true });
    if (context.duplicate) return { say: SAY.duplicate(dealNumber, store) };
    if (!context.found) return { say: SAY.notFound(dealNumber, store) };
    if (context.choices) return { say: SAY.severalContacts(dealNumber) };
    if (!context.contact) {
      log('WARNING', 'deal has no Roamer contact', { dealNumber, store });
      return { say: SAY.noContact(dealNumber) };
    }
    if (context.deal.properties.dealstage !== OPEN_STAGE) return { say: SAY.closed(dealNumber) };
    const recorded = context.briefNote && context.briefNote.spaceName;
    if (recorded && recorded !== here) {
      const existing = await spaces.findSpace(recorded);
      if (existing) return { say: SAY.exists(dealNumber, existing.uri) };
    }
    return { context };
  }

  // The brief card and the pin reminder in the space, then the space saved on the note.
  async function postBrief({ space, context, got, dealNumber, setStep }) {
    setStep('post brief');
    await sendMessage(space, renderBriefCard({ dealNumber, context, brief: got.brief, avatarUrl }));
    await sendMessage(space, SAY.pinIt);
    setStep('save note');
    await keepNote({ context, brief: got.brief, dealNumber, spaceName: space });
  }

  function failed(err, { dealNumber, step, started, reply }) {
    const noCredits = isOutOfCredits(err);
    const status = err.status || (err.response && err.response.status);
    const notApproved = (step === 'create space' || step === 'add member') && (status === 403 || status === 401);
    log('ERROR', noCredits ? 'open space failed: out of AI credits' : 'open space failed', { dealNumber, step, error: errorFields(err), ms: Date.now() - started });
    const text = noCredits ? SAY.noCredits : notApproved ? SAY.notApproved : SAY.failed(dealNumber);
    return reply(text).catch((e) => log('ERROR', 'could not post open space failure', { dealNumber, error: errorFields(e) }));
  }

  // `spaceName` is where the request came from (a direct message), for replies. `userName`
  // ("users/123") is who asked, and becomes the space's member.
  async function openSpace({ spaceName, userName, dealNumber, store = 'UT' }) {
    const started = Date.now();
    let step = 'load';
    const reply = (text) => sendMessage(spaceName, text);
    try {
      const { say, context } = await check({ dealNumber, store });
      if (say) return await reply(say);

      step = 'brief';
      const got = await getBrief({ context, dealNumber, started });
      if (!got) return await reply(SAY.failed(dealNumber));

      step = 'create space';
      const roamer = roamerName(context);
      const space = await spaces.createSpace({ displayName: [dealNumber, roamer].filter(Boolean).join(' · '), description: describe(dealNumber, context) });
      step = 'add member';
      await spaces.addMember(space.name, userName);
      await postBrief({ space: space.name, context, got, dealNumber, setStep: (s) => (step = s) });
      log('INFO', 'deal space opened', { dealNumber, space: space.name, reusedBrief: got.reused, ms: Date.now() - started });
      await reply(SAY.opened(dealNumber, roamer, space.uri));
    } catch (err) {
      await failed(err, { dealNumber, step, started, reply });
    }
  }

  // "use this space for <deal#>", said in the space itself (`spaceName`), named
  // `spaceDisplayName`. Replies go to that space.
  async function useSpace({ spaceName, spaceDisplayName, dealNumber, store = 'UT' }) {
    const started = Date.now();
    let step = 'load';
    const reply = (text) => sendMessage(spaceName, text);
    try {
      if (!namedFor(spaceDisplayName, dealNumber)) return await reply(SAY.rename(dealNumber));
      const { say, context } = await check({ dealNumber, store, here: spaceName });
      if (say) return await reply(say);

      step = 'brief';
      const got = await getBrief({ context, dealNumber, started });
      if (!got) return await reply(SAY.failed(dealNumber));

      await postBrief({ space: spaceName, context, got, dealNumber, setStep: (s) => (step = s) });
      log('INFO', 'deal space adopted', { dealNumber, space: spaceName, reusedBrief: got.reused, ms: Date.now() - started });
    } catch (err) {
      await failed(err, { dealNumber, step, started, reply });
    }
  }

  return { openSpace, useSpace };
}

const ACCESS = {
  noSpace: (n) => `Deal ${n} doesn't have a space yet.`,
  already: (n, uri) => `You're already in the space for deal ${n}${uri ? `: ${uri}` : '.'}`,
  // Posted in the deal space. Basecamp cannot add people without the admin approval, so a member does.
  asked: (who) => `${who} asked to join this deal space. Anyone here can add them: open the space's name at the top, then Add people.`,
  sent: (n) => `I asked the deal ${n} space to add you. It will show up in your Chat once someone does.`,
  failed: (n) => `I couldn't ask the deal ${n} space to add you. Blake can see what happened in the logs.`,
};

// "Request access" from Home: posts a request in the deal's space, where any member can
// add the person, and tells the person in their direct message with Basecamp.
// `findDirectMessage(userName)` finds that direct message.
function createAccessRequests({ findDealSpace, spaces, sendMessage, findDirectMessage, log }) {
  return async function requestAccess({ dealNumber, userName, userEmail, userDisplayName, store = 'UT' }) {
    let step = 'find space';
    try {
      const tell = async (text) => sendMessage(await findDirectMessage(userName), text);
      const found = await findDealSpace({ store, dealNumber });
      const space = found && found.spaceName ? await spaces.findSpace(found.spaceName) : null;
      if (!space) return await tell(ACCESS.noSpace(dealNumber));
      if (await spaces.isMember(space.name, userName)) return await tell(ACCESS.already(dealNumber, space.uri));
      step = 'post request';
      await sendMessage(space.name, ACCESS.asked(userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail));
      log('INFO', 'deal space access requested', { dealNumber, space: space.name, user: userEmail });
      await tell(ACCESS.sent(dealNumber));
    } catch (err) {
      log('ERROR', 'deal space access request failed', { dealNumber, step, user: userEmail, error: errorFields(err) });
      await findDirectMessage(userName)
        .then((dm) => sendMessage(dm, ACCESS.failed(dealNumber)))
        .catch((e) => log('ERROR', 'could not post access request failure', { dealNumber, error: errorFields(e) }));
    }
  };
}

// Which open deals have a deal space, for Home: every space Basecamp is in whose name
// starts with a deal number, kept only when that deal's brief note records the same space.
// The list is reused for `freshMs`; whether the viewer is in each space is checked per Home.
// Returns spacesFor(userName): Map(dealNumber -> { uri, member }).
function createDealSpaceIndex({ spaces, findDealSpace, freshMs = 90 * 1000, clock = Date.now }) {
  let cache = null;
  async function dealSpaces() {
    if (cache && clock() - cache.at < freshMs) return cache.map;
    const map = new Map();
    for (const sp of await spaces.listSpaces()) {
      const m = /^#?(\d{3,8})\b/.exec(sp.displayName.trim());
      if (!m || map.has(m[1])) continue;
      const found = await findDealSpace({ dealNumber: m[1] });
      if (found && found.spaceName === sp.name) map.set(m[1], { name: sp.name, uri: sp.uri });
    }
    cache = { at: clock(), map };
    return map;
  }
  return async function spacesFor(userName) {
    const out = new Map();
    for (const [n, sp] of await dealSpaces()) out.set(n, { uri: sp.uri, member: await spaces.isMember(sp.name, userName) });
    return out;
  };
}

module.exports = { createSpaceJob, createAccessRequests, createDealSpaceIndex, namedFor, SAY, ACCESS };
