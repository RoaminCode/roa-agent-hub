'use strict';

// What a call and a text contribute to the record a brief reads. The shapes here are the
// ones found on real Utah records (2026-11-11), with made-up names and numbers.

const test = require('node:test');
const assert = require('node:assert');
const { callText, textMessage, splitCallBody } = require('../src/hubspot/dealContext');

const HEADER = 'Casey Coach (Browser / Apps) has made an outbound call to +1 555-010-0000<br>Line: UT - Sales - (555) 010-0001<br>From: Casey Coach (Browser / Apps)<br>Creator Type: Manual';
const ALOWARE = `${HEADER}<br>Call Summary<br>Casey Coach from ROA called Pat Sample about the hitch.<br>Reason for the Call<br>To confirm the hitch height.`;
const HUBSPOT = 'SummaryKasey and Pat talked about a hitch.';

test('a call both systems summarized is read once, from Aloware, without its header or title', () => {
  const text = callText({ hs_call_title: 'Call with Pat Sample', hs_call_summary: HUBSPOT, hs_call_body: ALOWARE });
  assert.strictEqual(text, 'Summary: Casey Coach from ROA called Pat Sample about the hitch.\nReason for the Call\nTo confirm the hitch height.');
  assert.ok(!/Kasey|Creator Type|Line:|Call with/.test(text));
});

test('a call only HubSpot summarized keeps that summary; hand-written notes are kept beside it', () => {
  assert.strictEqual(callText({ hs_call_title: 'Call with Pat Sample', hs_call_summary: 'Talked about the Lake Test trip.', hs_call_body: HEADER }), 'Summary: Talked about the Lake Test trip.');
  assert.strictEqual(callText({ hs_call_summary: 'Talked about the trip.', hs_call_body: 'Pat wants Saturday.' }), 'Summary: Talked about the trip.\nNotes: Pat wants Saturday.');
  // A title someone wrote says something; the one every call gets does not.
  assert.strictEqual(callText({ hs_call_title: 'Walkthrough scheduling', hs_call_summary: 'Set for Friday.' }), 'Title: Walkthrough scheduling\nSummary: Set for Friday.');
  // Aloware's bookkeeping line is not a summary.
  const tagged = callText({ hs_call_summary: 'A short call.', hs_call_body: `${HEADER}<br>Agent Casey Coach added the "Follow up" tag to this communication.` });
  assert.strictEqual(tagged, 'Summary: A short call.');
});

test('a call nobody summarized is one short line, so the contact still shows', () => {
  const body = (first) => `${first}<br>Line: UT - Sales<br>Creator Type: Manual`;
  assert.strictEqual(callText({ hs_call_title: 'Call with Pat Sample', hs_call_body: body('We have missed an incoming call from +1 555-010-0000') }), 'Missed call from the Roamer; not answered.');
  assert.strictEqual(callText({ hs_call_body: body('+1 555-010-0000 has missed an outbound call from Casey Coach') }), 'ROA called; the Roamer did not answer.');
  assert.strictEqual(callText({ hs_call_body: body('We have a callback pending call from +1 555-010-0000') }), 'The Roamer asked for a callback.');
  assert.strictEqual(callText({ hs_call_body: HEADER, hs_call_duration: '185000' }), 'Call of 3 min; no summary recorded.');
  assert.strictEqual(callText({ hs_call_body: HEADER, hs_call_duration: '12000' }), 'Call of under a minute; no summary recorded.');
  assert.strictEqual(callText({}), '', 'nothing at all is left out');
  assert.deepStrictEqual(splitCallBody('Pat wants Saturday.'), { header: '', rest: 'Pat wants Saturday.' });
});

test('a text keeps its message and loses what Aloware adds around it', () => {
  const body = (m) => `+1 555-010-0000 has sent an SMS<br>Line: UT - Sales<br>Creator Type: Manual<br>Message:<br>${m}`;
  assert.strictEqual(textMessage(body('Can not wait!<br>Click here to respond'), 'Can not wait!\nClick here to respond'), 'Can not wait!');
  // A bare link is kept: its address often names the trailer or the page.
  assert.strictEqual(textMessage(body('https://example.com/xt16'), 'https://example.com/xt16'), 'https://example.com/xt16');
  // A log entry with no message (a picture message leaves one), "null", and automated replies are left out.
  const headerOnly = '+1 555-010-0000 has sent an SMS<br>Line: UT - Sales - (555) 010-0001<br>Creator Type: Manual<br>Click here to respond';
  assert.strictEqual(textMessage(headerOnly, 'whatever the parser made of it'), '');
  const inbox = 'Sam Sample (Browser / Apps) has sent an SMS to +1 555-010-0000<br>Line: UT - Sales<br>From: Sam Sample (Browser / Apps)<br>Source: HubSpot Conversation';
  assert.strictEqual(textMessage(inbox, inbox), '');
  assert.strictEqual(textMessage(body('null'), 'null'), '');
  const afterHours = 'Thanks for reaching out to ROA Off-Road, you have reached us after business hours. Our hours of operation are monday-friday 9am-5pm.';
  assert.strictEqual(textMessage(body(afterHours), afterHours), '');
  const missed = 'Hey there, thanks for reaching out to Rvs of America! We’re sorry we missed your call today. Please send us a text.';
  assert.strictEqual(textMessage(body(missed), missed), '');
  // The third format, a name line then the message, has no header to mistake.
  assert.strictEqual(textMessage('Sam Sample (Rvs of America):<br>See you Tuesday!', 'See you Tuesday!'), 'See you Tuesday!');
});
