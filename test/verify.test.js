'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createVerifier, CHAT_ISSUER_EMAIL, addOnIssuerEmail } = require('../src/chat/verify');

const AUDIENCE = 'https://basecamp.example.run.app';
const PROJECT = '123456789';

// Stands in for Google's token check: accepts any token and returns the given claims.
function fakeClient(claims) {
  return {
    verifyIdToken: async ({ audience }) => {
      if (!audience.includes(claims.aud)) throw new Error('Wrong recipient');
      return { getPayload: () => claims };
    },
  };
}

function verifierFor(claims, rejections = []) {
  return createVerifier({
    audience: AUDIENCE,
    projectNumber: PROJECT,
    client: fakeClient(claims),
    onReject: (d) => rejections.push(d),
  });
}

const token = 'header.' + Buffer.from(JSON.stringify({ iss: 'x', aud: AUDIENCE })).toString('base64url') + '.sig';

test('accepts a classic Chat app signer', async () => {
  const verify = verifierFor({ aud: AUDIENCE, email: CHAT_ISSUER_EMAIL, email_verified: true });
  assert.strictEqual(await verify(`Bearer ${token}`), true);
});

test('accepts this project\'s Workspace add-on signer', async () => {
  const verify = verifierFor({ aud: AUDIENCE, email: addOnIssuerEmail(PROJECT), email_verified: true });
  assert.strictEqual(await verify(`Bearer ${token}`), true);
});

test('accepts the endpoint with a trailing slash', async () => {
  const verify = verifierFor({ aud: `${AUDIENCE}/`, email: CHAT_ISSUER_EMAIL, email_verified: true });
  assert.strictEqual(await verify(`Bearer ${token}`), true);
});

test('rejects another project\'s add-on signer and reports why', async () => {
  const rejections = [];
  const verify = verifierFor({ aud: AUDIENCE, email: addOnIssuerEmail('999'), email_verified: true }, rejections);
  assert.strictEqual(await verify(`Bearer ${token}`), false);
  assert.strictEqual(rejections[0].reason, 'unexpected signer');
});

test('rejects a request with no bearer token', async () => {
  const verify = verifierFor({ aud: AUDIENCE, email: CHAT_ISSUER_EMAIL, email_verified: true });
  assert.strictEqual(await verify(undefined), false);
});
