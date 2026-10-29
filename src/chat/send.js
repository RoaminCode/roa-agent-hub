'use strict';

// Posts a message into a Chat space as the Basecamp app, for replies that take longer
// than Chat waits for (a brief takes 20 to 60 seconds). Uses app authentication: the
// Cloud Run service account with the chat.bot scope.

const { GoogleAuth } = require('google-auth-library');

function createChatSender({ auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/chat.bot'] }) } = {}) {
  return async function sendMessage(spaceName, text) {
    if (!/^spaces\/[\w-]+$/.test(spaceName || '')) throw new Error('sendMessage: invalid space name');
    const client = await auth.getClient();
    await client.request({ url: `https://chat.googleapis.com/v1/${spaceName}/messages`, method: 'POST', data: { text } });
  };
}

module.exports = { createChatSender };
