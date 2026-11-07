'use strict';

// Google Chat sends events in one of two shapes:
//   classic: { type, message, space, user }           (HTTP endpoint Chat apps)
//   add-on:  { chat: { user, messagePayload, ... } }  (Chat apps built as Workspace add-ons)
// parseEvent normalizes both; replyFor builds a reply in the shape the event came in.

const { safeError } = require('../errors');

function fromMessage(message) {
  if (!message) return {};
  return {
    // argumentText drops the @Basecamp mention in spaces; text is the full message.
    text: (message.argumentText || message.text || '').trim(),
    // For a message action ("Save to HubSpot" on someone's message): the whole message and
    // who wrote it, which may be someone other than the person who chose the action.
    fullText: (message.text || '').trim(),
    senderDisplayName: message.sender && message.sender.displayName ? String(message.sender.displayName) : null,
    messageName: message.name || null,
    threadName: message.thread ? message.thread.name : null,
  };
}

// userName is the resource name ("users/123"), which finds the user's direct message.
// A one-to-one conversation between a user and Basecamp. Chat names it several ways
// depending on API version and event format.
function isDirect(space) {
  return Boolean(space) && (space.spaceType === 'DIRECT_MESSAGE' || space.type === 'DM' || space.singleUserBotDm === true);
}

// The id of the slash command used ("1" for /note; see SLASH_COMMANDS in router.js), or null.
// For a slash command, the message's argumentText is what follows the command.
function commandIdOf(id) {
  return id === undefined || id === null || id === '' ? null : String(id);
}

// { name: "typed text" } from a card's form inputs ({ name: { stringInputs: { value: [...] } } }).
function formInputsOf(inputs) {
  const out = {};
  for (const [name, input] of Object.entries(inputs || {})) {
    const values = input && input.stringInputs && input.stringInputs.value;
    if (Array.isArray(values) && typeof values[0] === 'string') out[name] = values[0];
  }
  return out;
}

function userOf(user) {
  return {
    userEmail: user && user.email ? user.email.toLowerCase() : null,
    userName: user ? user.name || null : null,
    userDisplayName: user && user.displayName ? String(user.displayName) : null,
  };
}

function parseClassic(body) {
  return {
    format: 'classic',
    type: body.type || 'UNKNOWN',
    spaceName: body.space ? body.space.name : null,
    spaceType: body.space ? body.space.spaceType || body.space.type || null : null,
    spaceDisplayName: body.space ? body.space.displayName || null : null,
    isDirectMessage: isDirect(body.space),
    ...userOf(body.user),
    ...fromMessage(body.message),
    commandId: commandIdOf(body.message && body.message.slashCommand && body.message.slashCommand.commandId),
    // Card buttons are add-on events; a classic click carries no parameters Basecamp reads.
    parameters: {},
    formInputs: {},
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
  } else if (chat.appCommandPayload) {
    // A slash command such as "/note ...": read as a message, with the command's id.
    type = 'MESSAGE';
    payload = chat.appCommandPayload;
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
    spaceDisplayName: payload.space ? payload.space.displayName || null : null,
    isDirectMessage: isDirect(payload.space),
    ...userOf(chat.user),
    ...fromMessage(payload.message),
    commandId: commandIdOf(payload.appCommandMetadata && payload.appCommandMetadata.appCommandId),
    parameters: common.parameters || {},
    // What was typed into a card's text boxes, by input name (first value of each).
    formInputs: formInputsOf(common.formInputs),
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
  if (!body || typeof body !== 'object') throw safeError('parseEvent: body is not an object');
  return body.chat ? parseAddOn(body) : parseClassic(body);
}

// `reply` is text, or a Chat message object such as { cardsV2 } for a card.
const messageOf = (reply) => (typeof reply === 'string' ? { text: reply } : reply);

function replyFor(event, reply) {
  if (event.format === 'addon') {
    return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: messageOf(reply) } } } };
  }
  return messageOf(reply);
}

// Replaces the message whose button was tapped, such as the contact picker, with plain text.
function updateMessageFor(event, reply) {
  if (event.format === 'addon') {
    return { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: messageOf(reply) } } } };
  }
  return { actionResponse: { type: 'UPDATE_MESSAGE' }, ...messageOf(reply) };
}

// App Home responses are bare RenderActions; Chat rejects a "renderActions" wrapper on
// add-on apps. Opening Home pushes the card; a button tap answers with the card updated.
// (Notification pop-ups do not show on Home, so a tap's feedback lives on the card.)
function homeFor(card) {
  return { action: { navigations: [{ pushCard: card }] } };
}

function homeUpdateFor(card) {
  return { action: { navigations: [{ updateCard: card }] } };
}

module.exports = { parseEvent, replyFor, updateMessageFor, homeFor, homeUpdateFor, shapeOf };
