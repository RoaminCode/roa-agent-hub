'use strict';

// Basecamp's router. It verifies the request came from Google Chat, checks the sender is
// allowed, and routes the event. The one command so far is "brief <deal#> [store]",
// which answers right away and posts the Roamer brief when it is ready. App Home shows
// open deals, each with a Brief button that does the same.

const { errorFields } = require('./errors');
const { parseEvent, replyFor, updateMessageFor, homeFor, homeUpdateFor, shapeOf } = require('./chat/events');
const { renderNotAllowedHome } = require('./chat/homeCard');

const MESSAGES = {
  added: "Basecamp is here. I'm in shadow mode. Try \"brief 51431\" for a Roamer brief on a Utah deal.",
  help: 'Try "brief 51431" for a Roamer brief on a Utah deal.',
  notAllowed: "Basecamp isn't available to you yet.",
  working: (n, roamer) => `I'll need just a moment to read up on ${roamer ? `${roamer} (deal ${n})` : `deal ${n}`}.`,
  paused: "Roamer briefs are paused for now while Basecamp's AI funding is sorted out. Home still shows every deal, delivery, and last contact.",
  directOnly: (n) => `Roamer briefs stay private for now: ask me for deal ${n} in a direct message with me.`,
  unknownStore: (s) => `I only know the Utah Experience Center (UT) so far, not ${s}.`,
};

const STORES = new Set(['UT']);

// "brief 51431" or "brief 51431 UT". Deal numbers are digits only.
function parseCommand(text) {
  const m = /^brief\s+#?(\d{3,8})(?:\s+([A-Za-z]{2}))?\s*$/i.exec(text || '');
  return m ? { command: 'brief', dealNumber: m[1], store: (m[2] || 'UT').toUpperCase() } : null;
}

function log(severity, message, fields = {}) {
  // One JSON line per entry so Cloud Logging picks up severity and fields.
  console.log(JSON.stringify({ severity, message, ...fields }));
}

// buildHome({ userEmail, sent }) returns the App Home card; `sent` is the set of deal
// numbers whose brief this user started recently. See chat/homeCard.js.
// `briefsPaused` turns briefs off without a deploy (BRIEFS_PAUSED in server.js): a typed
// "brief" gets a short answer and starts nothing, and Home shows no Brief buttons.
function createRouter({ verify, allowedUsers, startBrief = () => {}, buildHome = async () => renderNotAllowedHome(), now = Date.now, briefsPaused = false }) {
  const allowed = new Set((allowedUsers || []).map((u) => u.toLowerCase()));

  // A brief takes about a minute and Home gives no progress bar, so a second tap on the
  // same deal is common. Within this window it starts no second brief. A typed "brief" is
  // not checked: it gets a visible reply, and may be a deliberate retry or another space.
  // The memory is per instance; with two instances a repeat tap can slip through.
  const REPEAT_MS = 2 * 60 * 1000;
  const recentBriefs = new Map();
  function isRepeat(userEmail, dealNumber) {
    const key = `${userEmail}|${dealNumber}`;
    const last = recentBriefs.get(key);
    for (const [k, t] of recentBriefs) if (now() - t > REPEAT_MS) recentBriefs.delete(k);
    if (last && now() - last <= REPEAT_MS) return true;
    recentBriefs.set(key, now());
    return false;
  }
  // Deals whose brief this user started within the window, so Home can mark them sent.
  function sentDeals(userEmail) {
    const sent = new Set();
    for (const [k, t] of recentBriefs) {
      const [user, deal] = k.split('|');
      if (user === userEmail && now() - t <= REPEAT_MS) sent.add(deal);
    }
    return sent;
  }

  return async function handle({ headers, body }) {
    if (!(await verify(headers.authorization))) {
      log('WARNING', 'rejected request that did not come from Google Chat');
      return { status: 401, body: { error: 'unauthorized' } };
    }

    let event;
    try {
      event = parseEvent(body);
    } catch (err) {
      log('ERROR', 'could not parse Chat event', { error: errorFields(err) });
      return { status: 400, body: { error: 'bad event' } };
    }

    // Message text is not logged: it can hold Roamer details.
    log('INFO', 'chat event', {
      format: event.format,
      type: event.type,
      space: event.spaceName,
      user: event.userEmail,
      messageName: event.messageName,
      textLength: event.text ? event.text.length : 0,
    });

    if (event.type === 'REMOVED_FROM_SPACE') return { status: 200, body: {} };

    // Home and card clicks are new to this router; log their shape (keys only) so the
    // real event format can be checked against what we expect.
    if (event.type === 'APP_HOME' || event.type === 'CARD_CLICKED') {
      log('INFO', 'chat event shape', { type: event.type, shape: shapeOf(body) });
    }

    const isAllowed = Boolean(event.userEmail && allowed.has(event.userEmail));

    if (event.type === 'APP_HOME') {
      const card = isAllowed ? await buildHome({ userEmail: event.userEmail, sent: sentDeals(event.userEmail) }) : renderNotAllowedHome();
      return { status: 200, body: homeFor(card) };
    }

    if (!isAllowed) {
      return { status: 200, body: replyFor(event, MESSAGES.notAllowed) };
    }

    if (event.type === 'CARD_CLICKED' && event.parameters.action === 'brief') {
      // A button drawn before the pause (an old Home or contact picker) starts nothing.
      if (briefsPaused) {
        if (event.parameters.from === 'picker') return { status: 200, body: updateMessageFor(event, MESSAGES.paused) };
        return { status: 200, body: homeUpdateFor(await buildHome({ userEmail: event.userEmail, sent: new Set() })) };
      }
      const dealNumber = String(event.parameters.dealNumber || '');
      if (!/^\d{3,8}$/.test(dealNumber)) return { status: 200, body: {} };

      // A tap on the contact picker: that contact is the Roamer. It always starts the brief
      // (it is the answer to a question Basecamp asked), and the picker is replaced by the
      // usual "reading up" line so it cannot be tapped twice.
      if (event.parameters.from === 'picker') {
        const contactId = String(event.parameters.contactId || '');
        const store = String(event.parameters.store || 'UT');
        if (!/^\d{1,20}$/.test(contactId) || !STORES.has(store) || !event.isDirectMessage) return { status: 200, body: {} };
        isRepeat(event.userEmail, dealNumber);
        startBrief({ spaceName: event.spaceName, userName: event.userName, dealNumber, store, contactId, userEmail: event.userEmail });
        return { status: 200, body: updateMessageFor(event, MESSAGES.working(dealNumber, event.parameters.roamer)) };
      }

      if (!isRepeat(event.userEmail, dealNumber)) {
        // The brief job first posts a line in the user's Basecamp messages, the same words
        // a typed "brief" command gets back, for anyone viewing Home and Messages side by side.
        startBrief({
          // Home has no space of its own; the brief goes to the user's direct message.
          spaceName: event.isDirectMessage ? event.spaceName : null,
          userName: event.userName,
          dealNumber,
          store: 'UT',
          userEmail: event.userEmail,
          announce: MESSAGES.working(dealNumber, event.parameters.roamer),
        });
      }
      // On a phone or full screen Messages is out of sight, so Home itself changes: the
      // tapped deal's button now reads "In Messages" and cannot be tapped again.
      const card = await buildHome({ userEmail: event.userEmail, sent: sentDeals(event.userEmail) });
      return { status: 200, body: homeUpdateFor(card) };
    }

    if (event.type === 'ADDED_TO_SPACE') {
      return { status: 200, body: replyFor(event, MESSAGES.added) };
    }

    if (event.type === 'MESSAGE') {
      const cmd = parseCommand(event.text);
      if (!cmd) return { status: 200, body: replyFor(event, MESSAGES.help) };
      if (briefsPaused) return { status: 200, body: replyFor(event, MESSAGES.paused) };
      if (!STORES.has(cmd.store)) return { status: 200, body: replyFor(event, MESSAGES.unknownStore(cmd.store)) };
      // A brief holds a Roamer's personal details, so it is posted only where the reader
      // should see them: a direct message with Basecamp. When deal spaces exist, a deal's
      // space will also get briefs for that deal, and only that deal.
      if (!event.isDirectMessage) return { status: 200, body: replyFor(event, MESSAGES.directOnly(cmd.dealNumber)) };
      // Not awaited: the brief outlives this request and posts itself when done.
      startBrief({ spaceName: event.spaceName, dealNumber: cmd.dealNumber, store: cmd.store, userEmail: event.userEmail });
      return { status: 200, body: replyFor(event, MESSAGES.working(cmd.dealNumber)) };
    }

    return { status: 200, body: {} };
  };
}

module.exports = { createRouter, parseCommand, MESSAGES };
