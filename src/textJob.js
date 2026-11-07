'use strict';

// "/text <what to say>": Basecamp drafts a text to the deal's Roamer; a Team Member reviews
// it in a dialog that shows the recipient's name and number, the line, and the exact words,
// and only "Approve and send" sends it, through Aloware, as the company. One approval
// covers one draft and is logged (line, recipient, time, approver, text), and a HubSpot note
// names the approver ("Sent by Basecamp, approved by ...").
//
// Shadow mode (until Blake says otherwise): nothing goes to a Roamer. The approved text goes
// to the approver's own phone (TEXT_TEST_NUMBERS, Blake's and Shane's), labeled with who
// it would have gone to, and its HubSpot note goes on the Delivery record only, so a test
// never shows in the Roamer's communication history or the next brief. Aloware refuses any
// other number (aloware.js). Logs steps, never the text or a number.

const { errorFields, isOutOfCredits } = require('./errors');
const { draftText } = require('./agents/textDraft');
const { writtenAt, noDashes } = require('./agents/roamerBrief');
const { MAX_CHARS, toE164 } = require('./aloware');

const SHADOW = true;

const SAY = {
  empty: 'Say what the text should tell them, for example: /text let them know the awning arm arrives Tuesday',
  dealFirst: 'In a direct message, name the deal first, for example: /text 51455 let them know the awning arm arrives Tuesday',
  notDealSpace: "This space isn't linked to a deal. Link it with \"use this space for <deal#>\", or send /text 51455 ... in a direct message with me.",
  noDeal: (n) => `I couldn't find deal ${n} in HubSpot.`,
  noRoamer: (n) => `Deal ${n} has no Roamer on record with Basecamp yet. Ask me for "brief ${n}" first.`,
  noNumber: (name) => `${name} has no phone number in HubSpot, so there's no one to text.`,
  failed: "I couldn't draft that text. Blake can see what happened in the logs.",
  noCredits: "I couldn't draft that text: Basecamp's AI credits have run out.",
  sent: ({ approver, name, number, shadowTo }) =>
    SHADOW
      ? `Shadow mode: sent to ${approver}'s phone (${shadowTo}), approved by ${approver}. It would have gone to ${name} (${number}). Logged, and noted on the Delivery record.`
      : `Sent to ${name} (${number}), approved by ${approver}. Logged in HubSpot.`,
  cancelled: 'Cancelled. Nothing was sent.',
  sendFailed: "I couldn't send that text. Nothing was sent; Blake can see what happened in the logs.",
  tooLong: `That text is over ${MAX_CHARS} characters. Shorten it and approve again.`,
  noTestNumber: "You don't have a test number on file, so in shadow mode this can't send. Blake can add one.",
};

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// "(801) 555-0100" for showing a number.
function pretty(number) {
  const e = toE164(number);
  return e ? `(${e.slice(2, 5)}) ${e.slice(5, 8)}-${e.slice(8)}` : String(number || '');
}

// The draft in the thread, with "Review and send", which opens the approval dialog.
function draftCard({ dealId, dealNumber, name, number, draft, endpoint }) {
  return {
    fallbackText: `Draft text to ${name}`,
    cardsV2: [
      {
        cardId: `text-${dealNumber}`,
        card: {
          header: { title: `Draft text to ${name}`, subtitle: `${pretty(number)} · deal ${dealNumber}` },
          sections: [
            {
              widgets: [
                { textParagraph: { text: escapeHtml(draft) } },
                { textParagraph: { text: `<font color="#6B6B6B">${draft.length} of ${MAX_CHARS} characters. Nothing is sent until someone approves it.</font>` } },
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

// The approval dialog: recipient name and number, the line, and the exact words, editable.
function reviewDialog({ dealId, dealNumber, name, number, line, draft, shadowTo, endpoint }) {
  const action = (value, extra = []) => ({ action: { function: endpoint, parameters: [{ key: 'action', value }, { key: 'd', value: String(dealId) }, { key: 'n', value: String(dealNumber) }, ...extra] } });
  const widgets = [
    { decoratedText: { topLabel: 'To', text: `<b>${escapeHtml(name)}</b> · ${escapeHtml(pretty(number))}` } },
    { decoratedText: { topLabel: 'From line', text: escapeHtml(line.label) } },
  ];
  if (SHADOW) {
    widgets.push({
      textParagraph: {
        text: shadowTo
          ? `<font color="#C27C0E"><b>Shadow mode:</b> this sends to your phone, ${escapeHtml(pretty(shadowTo))}, not to ${escapeHtml(name)}.</font>`
          : `<font color="#C27C0E"><b>Shadow mode:</b> you have no test number on file, so this can't send.</font>`,
      },
    });
  }
  widgets.push({ textInput: { name: 'message', label: `Message (${MAX_CHARS} characters max)`, type: 'MULTIPLE_LINE', value: draft } });
  const buttons = [{ text: 'Cancel', onClick: action('textCancel') }];
  if (!SHADOW || shadowTo) buttons.unshift({ text: 'Approve and send', type: 'FILLED', onClick: action('textSend') });
  widgets.push({ buttonList: { buttons } });
  return { header: { title: `Text for deal ${dealNumber}`, subtitle: 'Approve the exact words before anything is sent' }, sections: [{ widgets }] };
}

// The note on the Delivery record for each send.
function renderTextNote({ message, name, number, approver, line, shadowTo, now }) {
  const lines = [
    '<p><strong>Basecamp text sent</strong></p>',
    `<p>${escapeHtml(message)}</p>`,
    `<p>Sent by Basecamp, approved by ${escapeHtml(approver)}, ${writtenAt(now)} MT, from ${escapeHtml(line.label)}.</p>`,
  ];
  if (SHADOW) lines.push(`<p>Shadow mode: sent to the approver's phone (${escapeHtml(pretty(shadowTo))}); it would have gone to ${escapeHtml(name)} (${escapeHtml(pretty(number))}).</p>`);
  return lines.join('');
}

// `aloware` sends (aloware.js); `testNumbers` maps a Team Member's email to their own phone
// for shadow mode; `line` is { id, label }, the Aloware line texts go out on for now.
function createTexts({ anthropic, db, hubspot, createNote, findDealSpace, aloware, testNumbers = {}, line, sendMessage, log, endpoint = '', draft = draftText, now = () => new Date() }) {
  const testNumberFor = (email) => toE164(testNumbers[String(email || '').toLowerCase()]) || null;

  // The deal and its Roamer's name and number, from Basecamp's record and HubSpot.
  async function roamerOf(dealId) {
    const record = (await db.getDeal(String(dealId))) || {};
    if (!record.contactId) return { record, contact: null };
    const c = await hubspot.get(`/crm/v3/objects/contacts/${record.contactId}?properties=firstname,lastname,phone,mobilephone`);
    const p = c.properties || {};
    return { record, contact: { firstName: p.firstname || '', name: [p.firstname, p.lastname].filter(Boolean).join(' ') || 'the Roamer', number: p.mobilephone || p.phone || null } };
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
      if (!contact.number) return SAY.noNumber(contact.name);
      const result = await draft({ anthropic, instruction: args, firstName: contact.firstName });
      const usage = result.usage || {};
      log('INFO', result.ok ? 'text drafted' : 'text draft failed', { dealNumber, reason: result.reason || null, chars: result.ok ? result.text.length : null, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, costUsd: result.costUsd ?? null, user: userEmail, ms: Date.now() - started });
      if (!result.ok) return SAY.failed;
      return draftCard({ dealId, dealNumber, name: contact.name, number: contact.number, draft: result.text, endpoint });
    } catch (err) {
      log('ERROR', isOutOfCredits(err) ? 'text draft failed: out of AI credits' : 'text draft failed', { dealNumber, error: errorFields(err), ms: Date.now() - started });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  }

  // "Review and send": the approval dialog, with the recipient read fresh from HubSpot.
  async function review({ params, userEmail }) {
    const p = params || {};
    if (!/^\d+$/.test(String(p.d || ''))) return null;
    const { contact } = await roamerOf(p.d);
    if (!contact || !contact.number) return null;
    return reviewDialog({ dealId: p.d, dealNumber: p.n, name: contact.name, number: contact.number, line, draft: String(p.m || ''), shadowTo: testNumberFor(userEmail), endpoint });
  }

  // "Approve and send": the exact words from the dialog, sent once. Returns the text to post.
  async function send({ params, formInputs, userEmail, userDisplayName }) {
    const p = params || {};
    const dealNumber = /^\d{3,8}$/.test(String(p.n || '')) ? String(p.n) : null;
    const message = noDashes(String((formInputs || {}).message || '').trim());
    if (!message || !/^\d+$/.test(String(p.d || ''))) return SAY.sendFailed;
    if (message.length > MAX_CHARS) return SAY.tooLong;
    const approver = userDisplayName || userEmail;
    try {
      const shadowTo = testNumberFor(userEmail);
      if (SHADOW && !shadowTo) return SAY.noTestNumber;
      const { record, contact } = await roamerOf(p.d);
      if (!contact || !contact.number) return SAY.sendFailed;
      const to = SHADOW ? shadowTo : contact.number;
      await aloware.sendApproved({ lineId: line.id, to, message });
      const at = now();
      // The approval and send, logged in Basecamp's records (the rule for sends asks for the text).
      await db
        .recordTextSend({ dealId: String(p.d), approvedBy: userEmail, lineId: line.id, to: toE164(to), wouldGoTo: SHADOW ? toE164(contact.number) : null, message, shadow: SHADOW })
        .catch((e) => log('ERROR', 'could not log text send', { dealNumber, error: errorFields(e) }));
      // In shadow mode the note goes on the Delivery record only, never the Roamer's contact.
      const noteOn = SHADOW ? { contactId: null, deliveryId: record.deliveryId || null } : { contactId: record.contactId, deliveryId: record.deliveryId || null };
      if (noteOn.contactId || noteOn.deliveryId) {
        await createNote({ ...noteOn, body: renderTextNote({ message, name: contact.name, number: contact.number, approver, line, shadowTo, now: at }), timestamp: at.toISOString() }).catch((e) =>
          log('ERROR', 'could not note text send', { dealNumber, error: errorFields(e) }),
        );
      }
      log('INFO', 'text sent', { dealNumber, shadow: SHADOW, lineId: line.id, chars: message.length, approvedBy: userEmail });
      return SAY.sent({ approver, name: contact.name, number: pretty(contact.number), shadowTo: pretty(shadowTo) });
    } catch (err) {
      log('ERROR', 'text send failed', { dealNumber, error: errorFields(err) });
      return SAY.sendFailed;
    }
  }

  return { start, review, send };
}

module.exports = { createTexts, draftCard, reviewDialog, renderTextNote, pretty, SAY, SHADOW };
