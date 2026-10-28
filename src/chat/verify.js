'use strict';

// Confirms a request really came from Google Chat. Chat signs each request with an
// ID token whose audience is this app's endpoint URL and whose email is Chat's own
// service account. Anything else is rejected.

const { OAuth2Client } = require('google-auth-library');

const CHAT_ISSUER_EMAIL = 'chat@system.gserviceaccount.com';

function createVerifier({ audience, client = new OAuth2Client() }) {
  if (!audience) throw new Error('createVerifier: audience (the endpoint URL) is required');

  return async function verify(authorizationHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader || '');
    if (!match) return false;
    try {
      const ticket = await client.verifyIdToken({ idToken: match[1], audience });
      const payload = ticket.getPayload();
      return payload.email === CHAT_ISSUER_EMAIL && payload.email_verified === true;
    } catch {
      return false;
    }
  };
}

module.exports = { createVerifier, CHAT_ISSUER_EMAIL };
