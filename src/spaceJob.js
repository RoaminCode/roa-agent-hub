'use strict';

// Deal spaces: a Google Chat space for one open deal, with the Roamer brief as its first
// post, for a person to pin (Chat apps cannot pin). Two ways in:
//   openSpace: Basecamp creates the space and adds the person who asked (needs the admin-
//              approved scopes for creating spaces and adding people).
//   useSpace:  a person creates the space, adds Basecamp, and says "use this space for
//              <deal#>" in it. Needs no approval.
// Either way the space is recorded in Basecamp's database (db.js), so a deal gets one
// space, and written on the deal's brief note in HubSpot for people to see. Logs steps
// and timing, never Roamer details.

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
  busy: (n) => `The space for deal ${n} is being created right now. I'll post the link when it's ready.`,
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

// `ensureDelivery` (hubspot/deliveries.js) finds or creates the deal's Delivery record once
// as the space opens, before the brief is posted, so the brief card links to it and a new
// brief note is created on it. A failure there is logged and the space still opens.
function createSpaceJob({ loadContext, getBrief, keepNote, spaces, db, sendMessage, log, avatarUrl, ensureDelivery = null }) {
  // The context with the deal's Delivery record id, once found or created.
  async function withDelivery(context, dealNumber) {
    if (!ensureDelivery) return context;
    const found = await ensureDelivery({ dealId: context.deal.id, dealNumber, dealname: context.deal.properties.dealname || '', contactId: context.contact ? context.contact.id : null }).catch((err) => {
      log('ERROR', 'could not find or create Delivery record', { dealNumber, error: errorFields(err) });
      return null;
    });
    return found ? { ...context, deliveryId: found.id } : context;
  }

  // The deal's context when it may get a space, else the reply that says why not. A deal
  // whose recorded space still exists (and is not `here`) gets that space's link, with the
  // space as `existing`; one whose space is gone from Chat has it marked gone, and may get
  // a new one.
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
    const recorded = context.spaceName;
    if (recorded && recorded !== here) {
      const existing = await spaces.findSpace(recorded);
      if (existing) return { say: SAY.exists(dealNumber, existing.uri), existing, context };
      await db.markSpaceGone({ dealId: context.deal.id, spaceName: recorded });
      log('INFO', 'recorded deal space is gone', { dealNumber, space: recorded });
    }
    return { context };
  }

  // The brief card and the pin reminder in the space, then the space saved on the note.
  // `saved` is true when this brief was already saved (and its history counted) before.
  async function postBrief({ space, context, got, dealNumber, setStep, saved = false }) {
    setStep('post brief');
    await sendMessage(space, renderBriefCard({ dealNumber, context, brief: got.brief, avatarUrl }));
    await sendMessage(space, SAY.pinIt);
    setStep('save note');
    await keepNote({ context, brief: got.brief, dealNumber, spaceName: space, mode: saved || got.reused ? 'reuse' : got.mode });
    await db.markBriefPosted(context.deal.id);
  }

  // A space Basecamp created for this person whose opening stopped part way (adding them or
  // posting the brief failed): finishes it, so they are not left with a link to a space
  // they can't open. Anyone else gets the link, and Request access from Home.
  async function resume({ context, existing, dealNumber, userName, userEmail, started, setStep }) {
    const record = (await db.getDeal(context.deal.id)) || {};
    if (record.spaceHow !== 'created' || !userEmail || record.spaceLinkedBy !== userEmail) return SAY.exists(dealNumber, existing.uri);
    let finished = false;
    setStep('add member');
    if (!(await spaces.isMember(existing.name, userName))) {
      await spaces.addMember(existing.name, userName);
      finished = true;
    }
    if (record.spaceBriefPosted === false) {
      setStep('brief');
      const got = await getBrief({ context, dealNumber, started });
      if (!got) return SAY.failed(dealNumber);
      setStep('delivery record');
      const withRecord = await withDelivery(context, dealNumber);
      await postBrief({ space: existing.name, context: withRecord, got, dealNumber, setStep });
      finished = true;
    }
    if (!finished) return SAY.exists(dealNumber, existing.uri);
    log('INFO', 'deal space finished opening', { dealNumber, space: existing.name, ms: Date.now() - started });
    return SAY.opened(dealNumber, roamerName(context), existing.uri);
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
  async function openSpace({ spaceName, userName, userEmail, dealNumber, store = 'UT' }) {
    const started = Date.now();
    let step = 'load';
    let claimed = null;
    const reply = (text) => sendMessage(spaceName, text);
    try {
      const checked = await check({ dealNumber, store });
      if (checked.existing) return await reply(await resume({ ...checked, dealNumber, userName, userEmail, started, setStep: (s) => (step = s) }));
      if (checked.say) return await reply(checked.say);
      let context = checked.context;

      // One run creates a deal's space at a time; a second tap waits for the first.
      step = 'claim';
      if ((await db.claimSpace({ dealId: context.deal.id, by: userEmail || null })).busy) return await reply(SAY.busy(dealNumber));
      claimed = context.deal.id;

      step = 'brief';
      const got = await getBrief({ context, dealNumber, started });
      if (!got) {
        await db.releaseClaim(claimed);
        return await reply(SAY.failed(dealNumber));
      }
      // A new brief is saved now, so it is not lost if Google refuses the space; the next
      // try reuses it instead of writing it again. The save after posting updates this note.
      let saved = false;
      if (!got.reused) {
        const note = await keepNote({ context, brief: got.brief, dealNumber, mode: got.mode });
        if (note) context = { ...context, briefNote: { ...(context.briefNote || {}), id: note.id } };
        saved = Boolean(note);
      }

      step = 'create space';
      const roamer = roamerName(context);
      const space = await spaces.createSpace({ displayName: [dealNumber, roamer].filter(Boolean).join(' · '), description: describe(dealNumber, context) });
      // Recorded before anything else can fail, so a retry finds this space instead of
      // creating another.
      step = 'record space';
      await db.linkSpace({ dealId: context.deal.id, dealNumber, store, spaceName: space.name, spaceUri: space.uri, how: 'created', by: userEmail || null });
      claimed = null;
      step = 'add member';
      await spaces.addMember(space.name, userName);
      step = 'delivery record';
      context = await withDelivery(context, dealNumber);
      await postBrief({ space: space.name, context, got, dealNumber, saved, setStep: (s) => (step = s) });
      log('INFO', 'deal space opened', { dealNumber, space: space.name, reusedBrief: got.reused, ms: Date.now() - started });
      await reply(SAY.opened(dealNumber, roamer, space.uri));
    } catch (err) {
      if (claimed) await db.releaseClaim(claimed).catch((e) => log('ERROR', 'could not release space claim', { dealNumber, error: errorFields(e) }));
      await failed(err, { dealNumber, step, started, reply });
    }
  }

  // "use this space for <deal#>", said in the space itself (`spaceName`), named
  // `spaceDisplayName`. Replies go to that space.
  async function useSpace({ spaceName, userEmail, dealNumber, store = 'UT' }) {
    const started = Date.now();
    let step = 'load';
    const reply = (text) => sendMessage(spaceName, text);
    try {
      const checked = await check({ dealNumber, store, here: spaceName });
      if (checked.say) return await reply(checked.say);
      let context = checked.context;

      step = 'record space';
      const space = await spaces.findSpace(spaceName);
      await db.linkSpace({ dealId: context.deal.id, dealNumber, store, spaceName, spaceUri: space ? space.uri : null, how: 'adopted', by: userEmail || null });

      step = 'brief';
      const got = await getBrief({ context, dealNumber, started });
      if (!got) return await reply(SAY.failed(dealNumber));

      step = 'delivery record';
      context = await withDelivery(context, dealNumber);
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
// add the person, tells the person in their direct message with Basecamp, and records the
// request. `findDirectMessage(userName)` finds that direct message.
function createAccessRequests({ findDealSpace, spaces, db, sendMessage, findDirectMessage, log }) {
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
      await db.recordAccessRequest({ dealId: found.deal.id, spaceName: space.name, user: userEmail });
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

// Which open deals have a deal space, for Home, from Basecamp's records; whether the
// viewer is in each space is checked with Chat on each Home open.
// Returns spacesFor(userName): Map(dealNumber -> { uri, member }).
// One space that cannot be read never hides the others. Chat answers 403 for a space that
// was deleted or that Basecamp was removed from: that deal is left out, so its tile offers
// "Create space" (which opens or adopts one). Any other failure leaves that one deal with
// no space button for this open of Home.
// Every tap on Home redraws it, and each draw asked Chat once per deal space, so one
// person's answer is kept for a minute (`freshMs`). A space opened in that minute shows on
// Home after it; its link is posted in the person's direct message at once either way.
function createDealSpaceIndex({ spaces, db, store = 'UT', log = () => {}, freshMs = 60 * 1000, now = Date.now }) {
  const kept = new Map();
  return async function spacesFor(userName) {
    const hit = kept.get(userName);
    if (hit && now() - hit.at < freshMs) return hit.map;
    for (const [k, v] of kept) if (now() - v.at >= freshMs) kept.delete(k);
    const map = await read(userName);
    kept.set(userName, { at: now(), map });
    return map;
  };
  async function read(userName) {
    const list = await db.listDealSpaces(store);
    const entries = await Promise.all(
      list.map(async (sp) => {
        try {
          return [sp.dealNumber, { uri: sp.uri, member: await spaces.isMember(sp.spaceName, userName) }];
        } catch (err) {
          const status = err.status || (err.response && err.response.status);
          if (status === 403) {
            log('INFO', 'recorded deal space cannot be read; home offers a new one', { dealNumber: sp.dealNumber });
            return null;
          }
          log('WARNING', 'deal space membership unavailable for home', { dealNumber: sp.dealNumber, status: status || null });
          return [sp.dealNumber, { uri: null, member: true }];
        }
      }),
    );
    return new Map(entries.filter(Boolean));
  }
}

module.exports = { createSpaceJob, createAccessRequests, createDealSpaceIndex, SAY, ACCESS };
