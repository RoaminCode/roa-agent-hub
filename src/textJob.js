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

const { errorFields, isOutOfCredits } = require('./errors');
const { draftText } = require('./agents/textDraft');
const { writtenAt, noDashes } = require('./agents/roamerBrief');
const { MAX_CHARS, toE164 } = require('./aloware');

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
  notConfirmed: 'Not sent: tick that you checked the number, then approve again. Tap "Review and send" on the draft to reopen it.',
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
                { textParagraph: { text: `<font color="#6B6B6B">${draft.length} of ${MAX_CHARS} characters. Nothing is sent until someone reviews and approves it.</font>` } },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Review and send',
                        type: 'FILLED_TONAL',
                        onClick: { action: { function: endpoint, interaction: 'OPEN_DIALOG', parameters: [{ key: 'action', value: 'textReview' }, { key: 'd', value: String(dealId) }, { key: 'n', value: String(dealNumber) }, { key: 'm', value: draft }] } },
                      },
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
function reviewDialog({ dealId, dealNumber, name, numbers, line, draft, endpoint }) {
  const action = (value) => ({ action: { function: endpoint, parameters: [{ key: 'action', value }, { key: 'd', value: String(dealId) }, { key: 'n', value: String(dealNumber) }] } });
  const only = numbers.length === 1 ? numbers[0] : null;
  const widgets = [
    {
      textParagraph: {
        text: `<font color="#C0392B"><b>LIVE:</b> this sends to ${escapeHtml(name)}${only ? ` at ${escapeHtml(pretty(only.number))}` : ''} as soon as you approve. It can't be unsent.</font>`,
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
  widgets.push({ buttonList: { buttons: [{ text: 'Approve and send', type: 'FILLED', onClick: action('textSend') }, { text: 'Cancel', onClick: action('textCancel') }] } });
  return { header: { title: `Text ${name}`, subtitle: `Deal ${dealNumber}. Approve the exact words before anything is sent.` }, sections: [{ widgets }] };
}

// The note on the Delivery record and the Roamer for each send.
function renderTextNote({ message, name, number, approver, line, now }) {
  return [
    '<p><strong>Basecamp text sent</strong></p>',
    `<p>${escapeHtml(message)}</p>`,
    `<p>Sent by Basecamp to ${escapeHtml(name)} at ${escapeHtml(pretty(number))}, approved by ${escapeHtml(approver)}, ${writtenAt(now)} MT, from ${escapeHtml(line.label)}.</p>`,
  ].join('');
}

// `aloware` sends (aloware.js); `line` is { id, label }, the Aloware line texts go out on.
function createTexts({ anthropic, db, hubspot, createNote, findDealSpace, aloware, line, log, endpoint = '', draft = draftText, now = () => new Date() }) {
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
  async function review({ params }) {
    const p = params || {};
    if (!/^\d+$/.test(String(p.d || ''))) return null;
    const { contact } = await roamerOf(p.d);
    if (!contact || !contact.numbers.length) return null;
    return reviewDialog({ dealId: p.d, dealNumber: p.n, name: contact.name, numbers: contact.numbers, line, draft: String(p.m || ''), endpoint });
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
    try {
      const { record, contact } = await roamerOf(p.d);
      if (!contact || !contact.numbers.length) return SAY.sendFailed;
      // The number must still be on the Roamer's record: the one shown, or the one picked.
      const to = contact.numbers.length === 1 ? contact.numbers[0].number : toE164(f.to);
      if (!to || !contact.numbers.some((n) => n.number === to)) return SAY.wrongNumber;
      await aloware.sendApproved({ lineId: line.id, to, message });
      const at = now();
      // The approval and send, logged in Basecamp's records (the rule for sends asks for the text).
      await db
        .recordTextSend({ dealId: String(p.d), approvedBy: userEmail, lineId: line.id, to, wouldGoTo: null, message, shadow: false })
        .catch((e) => log('ERROR', 'could not log text send', { dealNumber, error: errorFields(e) }));
      await createNote({ contactId: record.contactId || null, deliveryId: record.deliveryId || null, body: renderTextNote({ message, name: contact.name, number: to, approver, line, now: at }), timestamp: at.toISOString() }).catch((e) =>
        log('ERROR', 'could not note text send', { dealNumber, error: errorFields(e) }),
      );
      log('INFO', 'text sent', { dealNumber, lineId: line.id, chars: message.length, approvedBy: userEmail });
      return SAY.sent({ approver, name: contact.name, number: pretty(to), line: line.label });
    } catch (err) {
      log('ERROR', 'text send failed', { dealNumber, error: errorFields(err) });
      return SAY.sendFailed;
    }
  }

  return { start, review, send };
}

module.exports = { createTexts, draftCard, reviewDialog, renderTextNote, numbersOf, pretty, SAY };
