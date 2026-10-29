'use strict';

// Basecamp's router. It verifies the request came from Google Chat, checks the sender is
// allowed, and routes the event. The one command so far is "brief <deal#> [store]",
// which answers right away and posts the Roamer brief when it is ready. App Home shows
// open deals, each with a Brief button that does the same.

const { parseEvent, replyFor, homeFor, notificationFor, shapeOf } = require('./chat/events');
const { renderNotAllowedHome } = require('./chat/homeCard');

const MESSAGES = {
  added: "Basecamp is here. I'm in shadow mode. Try \"brief 51431\" for a Roamer brief on a Utah deal.",
  help: 'Try "brief 51431" for a Roamer brief on a Utah deal.',
  notAllowed: "Basecamp isn't available to you yet.",
  working: (n, roamer) => `I'll need just a moment to read up on ${roamer ? `${roamer} (deal ${n})` : `deal ${n}`}.`,
  briefOnTheWay: (n, roamer) =>
    roamer ? `${roamer}'s brief (${n}) is on its way to your messages.` : `The brief for deal ${n} is on its way to your messages.`,
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

// buildHome({ userEmail }) returns the App Home card; see chat/homeCard.js.
function createRouter({ verify, allowedUsers, startBrief = () => {}, buildHome = async () => renderNotAllowedHome(), now = Date.now }) {
  const allowed = new Set((allowedUsers || []).map((u) => u.toLowerCase()));

  // A brief takes about a minute and Home gives no progress bar, so a second tap on the
  // same deal is common. Within this window it gets the notice but no second brief.
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

  return async function handle({ headers, body }) {
    if (!(await verify(headers.authorization))) {
      log('WARNING', 'rejected request that did not come from Google Chat');
      return { status: 401, body: { error: 'unauthorized' } };
    }

    let event;
    try {
      event = parseEvent(body);
    } catch (err) {
      log('ERROR', 'could not parse Chat event', { error: err.message });
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
      const card = isAllowed ? await buildHome({ userEmail: event.userEmail }) : renderNotAllowedHome();
      return { status: 200, body: homeFor(card) };
    }

    if (!isAllowed) {
      return { status: 200, body: replyFor(event, MESSAGES.notAllowed) };
    }

    if (event.type === 'CARD_CLICKED' && event.parameters.action === 'brief') {
      const dealNumber = String(event.parameters.dealNumber || '');
      if (!/^\d{3,8}$/.test(dealNumber)) return { status: 200, body: {} };
      if (!isRepeat(event.userEmail, dealNumber)) {
        // Home shows no sign of progress, so the brief job first posts a line in the
        // user's Basecamp messages, the same words a typed "brief" command gets back.
        startBrief({
          spaceName: event.spaceName,
          userName: event.userName,
          dealNumber,
          store: 'UT',
          userEmail: event.userEmail,
          announce: MESSAGES.working(dealNumber, event.parameters.roamer),
        });
      }
      return { status: 200, body: notificationFor(MESSAGES.briefOnTheWay(dealNumber, event.parameters.roamer)) };
    }

    if (event.type === 'ADDED_TO_SPACE') {
      return { status: 200, body: replyFor(event, MESSAGES.added) };
    }

    if (event.type === 'MESSAGE') {
      const cmd = parseCommand(event.text);
      if (!cmd) return { status: 200, body: replyFor(event, MESSAGES.help) };
      if (!STORES.has(cmd.store)) return { status: 200, body: replyFor(event, MESSAGES.unknownStore(cmd.store)) };
      // Not awaited: the brief outlives this request and posts itself when done.
      startBrief({ spaceName: event.spaceName, dealNumber: cmd.dealNumber, store: cmd.store, userEmail: event.userEmail });
      return { status: 200, body: replyFor(event, MESSAGES.working(cmd.dealNumber)) };
    }

    return { status: 200, body: {} };
  };
}

module.exports = { createRouter, parseCommand, MESSAGES };
