'use strict';

// Google Chat sends events in one of two shapes:
//   classic: { type, message, space, user }           (HTTP endpoint Chat apps)
//   add-on:  { chat: { user, messagePayload, ... } }  (Chat apps built as Workspace add-ons)
// parseEvent normalizes both; replyFor builds a reply in the shape the event came in.

function fromMessage(message) {
  if (!message) return {};
  return {
    // argumentText drops the @Basecamp mention in spaces; text is the full message.
    text: (message.argumentText || message.text || '').trim(),
    messageName: message.name || null,
    threadName: message.thread ? message.thread.name : null,
  };
}

function userOf(user) {
  return {
    userEmail: user && user.email ? user.email.toLowerCase() : null,
    userName: user ? user.displayName || null : null,
  };
}

function parseClassic(body) {
  return {
    format: 'classic',
    type: body.type || 'UNKNOWN',
    spaceName: body.space ? body.space.name : null,
    spaceType: body.space ? body.space.spaceType || body.space.type || null : null,
    ...userOf(body.user),
    ...fromMessage(body.message),
  };
}

function parseAddOn(body) {
  const chat = body.chat;
  let type = 'UNKNOWN';
  let payload = {};
  if (chat.messagePayload) {
    type = 'MESSAGE';
    payload = chat.messagePayload;
  } else if (chat.addedToSpacePayload) {
    type = 'ADDED_TO_SPACE';
    payload = chat.addedToSpacePayload;
  } else if (chat.removedFromSpacePayload) {
    type = 'REMOVED_FROM_SPACE';
    payload = chat.removedFromSpacePayload;
  } else if (chat.buttonClickedPayload) {
    type = 'CARD_CLICKED';
    payload = chat.buttonClickedPayload;
  }
  return {
    format: 'addon',
    type,
    spaceName: payload.space ? payload.space.name : null,
    spaceType: payload.space ? payload.space.spaceType || null : null,
    ...userOf(chat.user),
    ...fromMessage(payload.message),
  };
}

function parseEvent(body) {
  if (!body || typeof body !== 'object') throw new Error('parseEvent: body is not an object');
  return body.chat ? parseAddOn(body) : parseClassic(body);
}

function replyFor(event, text) {
  if (event.format === 'addon') {
    return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text } } } } };
  }
  return { text };
}

module.exports = { parseEvent, replyFor };
