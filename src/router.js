'use strict';

// Basecamp's router. It verifies the request came from Google Chat, checks the sender is
// allowed, and routes the message. The one command so far is "brief <deal#> [store]",
// which answers right away and posts the Roamer brief when it is ready.

const { parseEvent, replyFor } = require('./chat/events');

const MESSAGES = {
  added: "Basecamp is here. I'm in shadow mode. Try \"brief 51431\" for a Roamer brief on a Utah deal.",
  help: 'Try "brief 51431" for a Roamer brief on a Utah deal.',
  notAllowed: "Basecamp isn't available to you yet.",
  working: (n) => `On it. Reading everything in HubSpot for deal ${n}; the brief takes about a minute.`,
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

function createRouter({ verify, allowedUsers, startBrief = () => {} }) {
  const allowed = new Set((allowedUsers || []).map((u) => u.toLowerCase()));

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

    if (!event.userEmail || !allowed.has(event.userEmail)) {
      return { status: 200, body: replyFor(event, MESSAGES.notAllowed) };
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
