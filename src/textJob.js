'use strict';

// "/text <what to say>": Basecamp drafts a text to the deal's Roamer; a Team Member reviews
// it in a dialog and only "Approve and send" sends it, through Aloware, as the company.
// Texts are live (Blake's call, 2026-11-07, TEXTS_LIVE): an approved text goes to the Roamer.
// So the dialog says so plainly, shows which HubSpot field each number came from, asks which
// number when the contact has two, and will not send until the approver ticks that they
// checked the number. One approval covers one draft and is logged (line, recipient, time,
// approver, text), and a note on the Delivery record and the Roamer names the approver
// ("Sent by Basecamp, approved by ..."). The recipient is always read fresh from HubSpot,
// never taken from the card. Logs steps, never the text or a number.
//
// Test mode (`testTo`, from TEXT_TEST_TO, Blake's call 2026-11-08): while testing, every
// approved text goes to that one test phone instead of the Roamer. The whole flow still
// runs (dialog, number check, Aloware, log, note), but the dialog says it is a test, the note
// goes on the Delivery record only (never the Roamer's contact or history), and Aloware is
// locked to the test number (server.js). Removing TEXT_TEST_TO makes texts live.

const { errorFields, isOutOfCredits } = require('./errors');
const { draftText } = require('./agents/textDraft');
const { writtenAt, noDashes } = require('./agents/roamerBrief');
const { MAX_CHARS, toE164 } = require('./aloware');
const { primary, secondary } = require('./chat/style');

const SAY = {
  empty: 'Say what the text should tell them, for example: /text let them know the awning arm arrives Tuesday',
  dealFirst: 'In a direct message, name the deal first, for example: /text 51455 let them know the awning arm arrives Tuesday',
  notDealSpace: "This space isn't linked to a deal. Link it with \"use this space for <deal#>\", or send /text 51455 ... in a direct message with me.",
  noDeal: (n) => `I couldn't find deal ${n} in HubSpot.`,
  noRoamer: (n) => `Deal ${n} has no Roamer on record with Basecamp yet. Ask me for "brief ${n}" first.`,
  noNumber: (name) => `${name} has no phone number in HubSpot, so there's no one to text.`,
  failed: "I couldn't draft that text. Blake can see what happened in the logs.",
  noCredits: "I couldn't draft that text: Basecamp's AI credits have run out.",
  sent: ({ approver, name, number, line }) => `Sent to ${name} at ${number} from ${line}, approved by ${approver}. Noted on the Delivery record and the Roamer in HubSpot.`,
  sentTest: ({ approver, name, number, line, testTo }) => `Test: sent to the test phone ${testTo} from ${line}, approved by ${approver}. Live, it would have gone to ${name} at ${number}. Noted on the Delivery record as a test.`,
  notConfirmed: 'Not sent: tick that you checked the number, then approve again. Tap "Review and send" on the draft to reopen it.',
  alreadySent: 'Not sent: a text has already been sent from this draft. Start a new one with /text if you need another.',
  wrongNumber: "Not sent: that number isn't on the Roamer's HubSpot record anymore. Tap \"Review and send\" to reopen it with the current number.",
  sendFailed: "I couldn't send that text. Nothing was sent; Blake can see what happened in the logs.",
  tooLong: `Not sent: that text is over ${MAX_CHARS} characters. Tap "Review and send" to shorten it.`,
};

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// "(801) 555-0100" for showing a number.
function pretty(number) {
  const e = toE164(number);
  return e ? `(${e.slice(2, 5)}) ${e.slice(5, 8)}-${e.slice(8)}` : String(number || '');
}

// The Roamer's phone numbers in HubSpot, each with the field it came from, the same number
// listed once: [{ field: 'Mobile', number: '+1...' }].
function numbersOf(p) {
  const out = [];
  for (const [field, raw] of [
    ['Mobile', p.mobilephone],
    ['Phone', p.phone],
  ]) {
    const number = toE164(raw);
    if (number && !out.some((n) => n.number === number)) out.push({ field, number });
  }
  return out;
}

// The draft in the thread, with "Review and send", which opens the approval dialog.
function draftCard({ dealId, dealNumber, name, draft, endpoint }) {
  return {
    fallbackText: `Draft text to ${name}`,
    cardsV2: [
      {
        cardId: `text-${dealNumber}`,
        card: {
          header: { title: `Draft text to ${name}`, subtitle: `Deal ${dealNumber}` },
          sections: [
            {
              widgets: [
                { textParagraph: { text: escapeHtml(draft) } },
                { textParagraph: { text: `<i>${draft.length} of ${MAX_CHARS} characters. Nothing is sent until someone reviews and approves it.</i>` } },
                {
                  buttonList: {
                    buttons: [
                      primary('Review and send', { action: { function: endpoint, interaction: 'OPEN_DIALOG', parameters: [{ key: 'action', value: 'textReview' }, { key: 'd', value: String(dealId) }, { key: 'n', value: String(dealNumber) }, { key: 'm', value: draft }] } }),
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

// The approval dialog: a live warning, the recipient and which number, the line, the exact
// words (editable), and the number check that must be ticked before it sends.
// `card` is the draft card's message name, carried through so a send is tied to its draft.
function reviewDialog({ dealId, dealNumber, name, numbers, line, draft, endpoint, testTo = null, card = '' }) {
  const action = (value) => ({ action: { function: endpoint, parameters: [{ key: 'action', value }, { key: 'd', value: String(dealId) }, { key: 'n', value: String(dealNumber) }, { key: 'c', value: String(card || '') }] } });
  const only = numbers.length === 1 ? numbers[0] : null;
  const at = only ? ` at ${escapeHtml(pretty(only.number))}` : '';
  // Bold in Chat's own text color, no warning color (Blake, 2026-11-07): it reads in light
  // and dark mode, and the icon marks it.
  const widgets = [
    {
      decoratedText: {
        startIcon: { materialIcon: { name: 'info' } },
        text: testTo
          ? `<b>TESTING: this goes to your test phone, ${escapeHtml(pretty(testTo))}, not to ${escapeHtml(name)}${at}.</b>`
          : `<b>LIVE: this sends to ${escapeHtml(name)}${at} as soon as you approve. It can't be unsent.</b>`,
        wrapText: true,
      },
    },
  ];
  if (only) {
    widgets.push({ decoratedText: { topLabel: `To (${only.field} in HubSpot)`, text: `<b>${escapeHtml(name)}</b> · ${escapeHtml(pretty(only.number))}` } });
  } else {
    // Two different numbers: the approver picks; none is chosen for them.
    widgets.push({
      selectionInput: {
        name: 'to',
        label: `Which number for ${name}? HubSpot has two.`,
        type: 'RADIO_BUTTON',
        items: numbers.map((n) => ({ text: `${n.field}: ${pretty(n.number)}`, value: n.number, selected: false })),
      },
    });
  }
  widgets.push({ decoratedText: { topLabel: 'From line', text: escapeHtml(line.label) } });
  widgets.push({ textInput: { name: 'message', label: `Message (${MAX_CHARS} characters max)`, type: 'MULTIPLE_LINE', value: draft } });
  widgets.push({
    selectionInput: {
      name: 'confirm',
      type: 'CHECK_BOX',
      items: [{ text: `I checked this is the right number for ${name}`, value: 'yes', selected: false }],
    },
  });
  widgets.push({ buttonList: { buttons: [primary('Approve and send', action('textSend')), secondary('Cancel', action('textCancel'))] } });
  return { header: { title: `Text ${name}`, subtitle: `Deal ${dealNumber}. Approve the exact words before anything is sent.` }, sections: [{ widgets }] };
}

// The draft card once its text is sent: what went, to whom, who approved it, and no button,
// so it can't be sent again.
function sentCard({ dealNumber, name, number, message, approver, line, now, testTo = null }) {
  const to = testTo ? `the test phone ${pretty(testTo)} (live: ${name}, ${pretty(number)})` : `${name}, ${pretty(number)}`;
  return {
    fallbackText: `Text sent to ${name}`,
    cardsV2: [
      {
        cardId: `text-sent-${dealNumber}`,
        card: {
          header: { title: testTo ? `Test text sent` : `Text sent to ${name}`, subtitle: `Deal ${dealNumber}` },
          sections: [
            {
              widgets: [
                { textParagraph: { text: escapeHtml(message) } },
                { decoratedText: { startIcon: { materialIcon: { name: 'check_circle' } }, text: `<b>Sent</b> to ${escapeHtml(to)}`, wrapText: true } },
                { textParagraph: { text: `<i>Approved by ${escapeHtml(approver)}, ${writtenAt(now)} MT, from ${escapeHtml(line.label)}.</i>` } },
              ],
            },
          ],
        },
      },
    ],
  };
}

// The note on the Delivery record and the Roamer for each send.
function renderTextNote({ message, name, number, approver, line, now, testTo = null }) {
  if (testTo) {
    return [
      '<p><strong>Basecamp text sent (test)</strong></p>',
      `<p>${escapeHtml(message)}</p>`,
      `<p>Test: sent by Basecamp to the test phone ${escapeHtml(pretty(testTo))}, approved by ${escapeHtml(approver)}, ${writtenAt(now)} MT, from ${escapeHtml(line.label)}. Live, it would have gone to ${escapeHtml(name)} at ${escapeHtml(pretty(number))}.</p>`,
    ].join('');
  }
  return [
    '<p><strong>Basecamp text sent</strong></p>',
    `<p>${escapeHtml(message)}</p>`,
    `<p>Sent by Basecamp to ${escapeHtml(name)} at ${escapeHtml(pretty(number))}, approved by ${escapeHtml(approver)}, ${writtenAt(now)} MT, from ${escapeHtml(line.label)}.</p>`,
  ].join('');
}

// `aloware` sends (aloware.js); `line` is { id, label }, the Aloware line texts go out on;
// `testTo`, when set, is the one test phone every approved text goes to (test mode).
// `updateMessage(name, message)` replaces the draft card once its text is sent.
function createTexts({ anthropic, db, hubspot, createNote, findDealSpace, aloware, line, log, endpoint = '', testTo = null, updateMessage = async () => {}, draft = draftText, now = () => new Date() }) {
  const test = toE164(testTo);
  // The deal and its Roamer's name and numbers, from Basecamp's record and, fresh, HubSpot.
  async function roamerOf(dealId) {
    const record = (await db.getDeal(String(dealId))) || {};
    if (!record.contactId) return { record, contact: null };
    const c = await hubspot.get(`/crm/v3/objects/contacts/${record.contactId}?properties=firstname,lastname,phone,mobilephone`);
    const p = c.properties || {};
    return { record, contact: { firstName: p.firstname || '', name: [p.firstname, p.lastname].filter(Boolean).join(' ') || 'the Roamer', numbers: numbersOf(p) } };
  }

  // "/text ...": returns a draft card, or text.
  async function start({ spaceName, isDirectMessage, text = '', userEmail }) {
    let args = String(text || '').trim();
    let dealId = null;
    let dealNumber = null;
    const started = Date.now();
    try {
      if (isDirectMessage) {
        const m = /^#?(\d{3,8})\b\s*([\s\S]*)$/.exec(args);
        if (!m) return SAY.dealFirst;
        dealNumber = m[1];
        args = m[2].trim();
        const found = await findDealSpace({ dealNumber });
        if (!found) return SAY.noDeal(dealNumber);
        dealId = String(found.deal.id);
      } else {
        const space = await db.getSpace(spaceName);
        const deal = space && space.status === 'ready' ? await db.getDeal(space.dealId) : null;
        if (!deal || deal.spaceName !== spaceName) return SAY.notDealSpace;
        dealId = space.dealId;
        dealNumber = space.dealNumber;
      }
      if (!args) return SAY.empty;
      const { contact } = await roamerOf(dealId);
      if (!contact) return SAY.noRoamer(dealNumber);
      if (!contact.numbers.length) return SAY.noNumber(contact.name);
      const result = await draft({ anthropic, instruction: args, firstName: contact.firstName });
      const usage = result.usage || {};
      log('INFO', result.ok ? 'text drafted' : 'text draft failed', { dealNumber, reason: result.reason || null, chars: result.ok ? result.text.length : null, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, costUsd: result.costUsd ?? null, user: userEmail, ms: Date.now() - started });
      if (!result.ok) return SAY.failed;
      return draftCard({ dealId, dealNumber, name: contact.name, draft: result.text, endpoint });
    } catch (err) {
      log('ERROR', isOutOfCredits(err) ? 'text draft failed: out of AI credits' : 'text draft failed', { dealNumber, error: errorFields(err), ms: Date.now() - started });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  }

  // "Review and send": the approval dialog, with the recipient read fresh from HubSpot.
  async function review({ params, messageName = '' }) {
    const p = params || {};
    if (!/^\d+$/.test(String(p.d || ''))) return null;
    const { contact } = await roamerOf(p.d);
    if (!contact || !contact.numbers.length) return null;
    return reviewDialog({ dealId: p.d, dealNumber: p.n, name: contact.name, numbers: contact.numbers, line, draft: String(p.m || ''), endpoint, testTo: test, card: messageName });
  }

  // "Approve and send": the exact words from the dialog, to the checked number, sent once.
  // Returns the text to post in the thread.
  async function send({ params, formInputs, userEmail, userDisplayName }) {
    const p = params || {};
    const f = formInputs || {};
    const dealNumber = /^\d{3,8}$/.test(String(p.n || '')) ? String(p.n) : null;
    const message = noDashes(String(f.message || '').trim());
    if (!message || !/^\d+$/.test(String(p.d || ''))) return SAY.sendFailed;
    if (message.length > MAX_CHARS) return SAY.tooLong;
    if (f.confirm !== 'yes') return SAY.notConfirmed;
    const approver = userDisplayName || userEmail;
    // One send per draft card: a second Approve from the same draft is refused.
    const card = /^spaces\/[\w-]+\/messages\/[\w.-]+$/.test(String(p.c || '')) ? String(p.c) : null;
    try {
      if (card && (await db.textSentFromCard(card))) return SAY.alreadySent;
      const { record, contact } = await roamerOf(p.d);
      if (!contact || !contact.numbers.length) return SAY.sendFailed;
      // The number must still be on the Roamer's record: the one shown, or the one picked.
      const to = contact.numbers.length === 1 ? contact.numbers[0].number : toE164(f.to);
      if (!to || !contact.numbers.some((n) => n.number === to)) return SAY.wrongNumber;
      // Test mode: the checked number stays the one it would go to; the test phone gets it.
      const sendTo = test || to;
      await aloware.sendApproved({ lineId: line.id, to: sendTo, message });
      const at = now();
      // The approval and send, logged in Basecamp's records (the rule for sends asks for the text).
      await db
        .recordTextSend({ dealId: String(p.d), approvedBy: userEmail, lineId: line.id, to: sendTo, wouldGoTo: test ? to : null, message, shadow: Boolean(test), card })
        .catch((e) => log('ERROR', 'could not log text send', { dealNumber, error: errorFields(e) }));
      // A test is noted on the Delivery record only, never the Roamer's contact.
      const noteOn = { contactId: test ? null : record.contactId || null, deliveryId: record.deliveryId || null };
      if (noteOn.contactId || noteOn.deliveryId) {
        await createNote({ ...noteOn, body: renderTextNote({ message, name: contact.name, number: to, approver, line, now: at, testTo: test }), timestamp: at.toISOString() }).catch((e) =>
          log('ERROR', 'could not note text send', { dealNumber, error: errorFields(e) }),
        );
      }
      // The draft card becomes a "Sent" card with no button.
      if (card) {
        await updateMessage(card, sentCard({ dealNumber, name: contact.name, number: to, message, approver, line, now: at, testTo: test })).catch((e) =>
          log('ERROR', 'could not mark the draft sent', { dealNumber, error: errorFields(e) }),
        );
      }
      log('INFO', test ? 'text sent (test)' : 'text sent', { dealNumber, lineId: line.id, chars: message.length, approvedBy: userEmail });
      if (test) return SAY.sentTest({ approver, name: contact.name, number: pretty(to), line: line.label, testTo: pretty(test) });
      return SAY.sent({ approver, name: contact.name, number: pretty(to), line: line.label });
    } catch (err) {
      log('ERROR', 'text send failed', { dealNumber, error: errorFields(err) });
      return SAY.sendFailed;
    }
  }

  return { start, review, send };
}

module.exports = { createTexts, draftCard, reviewDialog, sentCard, renderTextNote, numbersOf, pretty, SAY };
