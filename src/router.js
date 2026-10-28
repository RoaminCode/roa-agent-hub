'use strict';

// Basecamp's router. For now (Slice 0) it only proves the plumbing: it verifies the
// request came from Google Chat, checks the sender is allowed, and replies. No AI yet.

const { parseEvent, replyFor } = require('./chat/events');

const MESSAGES = {
  added: "Basecamp is here. I'm in shadow mode, so for now I'm only listening.",
  listening: 'Basecamp is listening.',
  notAllowed: "Basecamp isn't available to you yet.",
};

function log(severity, message, fields = {}) {
  // One JSON line per entry so Cloud Logging picks up severity and fields.
  console.log(JSON.stringify({ severity, message, ...fields }));
}

function createRouter({ verify, allowedUsers }) {
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
      return { status: 200, body: replyFor(event, MESSAGES.listening) };
    }

    return { status: 200, body: {} };
  };
}

module.exports = { createRouter, MESSAGES };
