'use strict';

// Posts a message into a Chat space as the Basecamp app, for replies that take longer
// than Chat waits for (a brief takes 20 to 60 seconds). Uses app authentication: the
// Cloud Run service account with the chat.bot scope.

const { safeError } = require('../errors');
const { GoogleAuth } = require('google-auth-library');

const defaultAuth = () => new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/chat.bot'] });

function createChatSender({ auth = defaultAuth() } = {}) {
  // `message` is plain text, or a Chat message object such as { fallbackText, cardsV2 }.
  return async function sendMessage(spaceName, message) {
    if (!/^spaces\/[\w-]+$/.test(spaceName || '')) throw safeError('sendMessage: invalid space name');
    const client = await auth.getClient();
    const data = typeof message === 'string' ? { text: message } : message;
    await client.request({ url: `https://chat.googleapis.com/v1/${spaceName}/messages`, method: 'POST', data });
  };
}

// The direct message space between Basecamp and one user ("users/123"), for replies to
// events that do not say which space they came from, such as a button on App Home.
function createDirectMessageFinder({ auth = defaultAuth() } = {}) {
  return async function findDirectMessage(userName) {
    if (!/^users\/[\w-]+$/.test(userName || '')) throw safeError('findDirectMessage: invalid user name');
    const client = await auth.getClient();
    const res = await client.request({
      url: `https://chat.googleapis.com/v1/spaces:findDirectMessage?name=${encodeURIComponent(userName)}`,
      method: 'GET',
    });
    return res.data.name;
  };
}

module.exports = { createChatSender, createDirectMessageFinder };
