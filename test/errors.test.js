'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { safeError, errorFields } = require('../src/errors');

const SECRET = /Pat Sample|gate code|4471/;

test("logs a library error's type, status, and code, never its message", () => {
  const err = new Error('request failed for "Pat Sample, gate code 4471"');
  err.status = 503;
  err.code = 'ECONNRESET';
  const fields = errorFields(err);
  assert.strictEqual(fields.type, 'Error');
  assert.strictEqual(fields.status, 503);
  assert.strictEqual(fields.code, 'ECONNRESET');
  assert.ok(!('message' in fields));
  assert.ok(!SECRET.test(JSON.stringify(fields)));
});

test("logs the hub's own safe errors in full", () => {
  const fields = errorFields(safeError('HubSpot GET /crm/v3/owners failed: HTTP 500'));
  assert.strictEqual(fields.message, 'HubSpot GET /crm/v3/owners failed: HTTP 500');
});

test('a JSON parse error, which quotes its input, logs only its type and where it happened', () => {
  let err;
  try {
    JSON.parse('{"text": "Pat Sample, gate code 4471"');
  } catch (e) {
    err = e;
  }
  const fields = errorFields(err);
  assert.strictEqual(fields.type, 'SyntaxError');
  assert.ok(fields.stack.length > 0);
  assert.ok(fields.stack.every((frame) => /\(([^\\/()]+):(\d+)\)$/.test(frame)), JSON.stringify(fields.stack));
  assert.ok(!SECRET.test(JSON.stringify(fields)));
});

test("keeps Anthropic's error type and request ID, for support", () => {
  const err = new Error('Overloaded');
  err.status = 529;
  err.error = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
  err.requestID = 'req_123';
  const fields = errorFields(err);
  assert.deepStrictEqual([fields.status, fields.providerType, fields.requestId], [529, 'overloaded_error', 'req_123']);
});

test('reads a Google library status from the response', () => {
  const err = new Error('x');
  err.response = { status: 403 };
  assert.strictEqual(errorFields(err).status, 403);
});

test('describes something thrown that is not an error', () => {
  assert.deepStrictEqual(errorFields('Pat Sample'), { type: 'string' });
});
