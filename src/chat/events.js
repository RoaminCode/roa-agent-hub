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
  const common = body.commonEventObject || {};
  let type = 'UNKNOWN';
  let payload = {};
  if (chat.type === 'APP_HOME') {
    type = 'APP_HOME';
  } else if (chat.type === 'SUBMIT_FORM' || (common.invokedFunction && !chat.messagePayload)) {
    type = 'CARD_CLICKED';
    payload = chat.buttonClickedPayload || chat.submitFormPayload || {};
  } else if (chat.messagePayload) {
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
  } else if (chat.user && chat.eventTime) {
    // App Home: the opening event carries only the user and the time, no payload.
    type = 'APP_HOME';
  }
  return {
    format: 'addon',
    type,
    spaceName: payload.space ? payload.space.name : null,
    spaceType: payload.space ? payload.space.spaceType || null : null,
    ...userOf(chat.user),
    ...fromMessage(payload.message),
    userName: chat.user ? chat.user.name || null : null,
    parameters: common.parameters || {},
  };
}

// The shape of an event with every value removed, for logs: shows which fields Chat sent
// without recording what they said.
function shapeOf(value, depth = 0) {
  if (value === null || typeof value !== 'object') return typeof value;
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.length ? [shapeOf(value[0], depth + 1)] : [];
  return Object.fromEntries(Object.keys(value).map((k) => [k, shapeOf(value[k], depth + 1)]));
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

// App Home responses are bare RenderActions; Chat rejects a "renderActions" wrapper on
// add-on apps. Opening Home pushes the card. A button tap answers with a notification
// only, so Chat shows a pop-up and leaves the card where it was instead of redrawing it.
function homeFor(card) {
  return { action: { navigations: [{ pushCard: card }] } };
}

function notificationFor(text) {
  return { action: { notification: { text } } };
}

module.exports = { parseEvent, replyFor, homeFor, notificationFor, shapeOf };
