'use strict';

// Confirms a request really came from Google Chat. Chat signs each request with an
// ID token whose audience is this app's endpoint URL. The signer depends on how the
// Chat app is configured:
//   classic HTTP Chat app:          chat@system.gserviceaccount.com
//   Chat app as a Workspace add-on: service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com
// Anything else is rejected.

const { OAuth2Client } = require('google-auth-library');

const CHAT_ISSUER_EMAIL = 'chat@system.gserviceaccount.com';

function addOnIssuerEmail(projectNumber) {
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
}

// Reads a JWT's claims without trusting them, for diagnosing rejections only.
function peekClaims(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { iss: payload.iss, aud: payload.aud, email: payload.email };
  } catch {
    return { unreadable: true };
  }
}

function createVerifier({ audience, projectNumber, client = new OAuth2Client(), onReject = () => {} }) {
  if (!audience) throw new Error('createVerifier: audience (the endpoint URL) is required');
  // The Chat console may save the endpoint with or without a trailing slash; accept either.
  const base = audience.replace(/\/+$/, '');
  const audiences = [base, `${base}/`];
  const signers = new Set([CHAT_ISSUER_EMAIL]);
  if (projectNumber) signers.add(addOnIssuerEmail(projectNumber));

  return async function verify(authorizationHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader || '');
    if (!match) {
      onReject({ reason: 'no bearer token' });
      return false;
    }
    try {
      const ticket = await client.verifyIdToken({ idToken: match[1], audience: audiences });
      const payload = ticket.getPayload();
      if (signers.has(payload.email) && payload.email_verified === true) return true;
      onReject({ reason: 'unexpected signer', ...peekClaims(match[1]) });
      return false;
    } catch (err) {
      onReject({ reason: err.message, ...peekClaims(match[1]) });
      return false;
    }
  };
}

module.exports = { createVerifier, CHAT_ISSUER_EMAIL, addOnIssuerEmail };
