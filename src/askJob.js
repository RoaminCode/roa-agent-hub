'use strict';

// "/ask <question>": Basecamp works out which role owns the answer and, in shadow mode,
// sends the question to the shadow reviewer (Blake) labeled with that role, never to the
// role itself. Basecamp never answers the question. On a deal, the question is also kept
// in HubSpot as a "Basecamp Q&A" note on the Delivery record and the Roamer, filed by topic.
// A question is on a deal when asked in its linked space, or in a direct message that names
// one open deal by number ("/ask have we scheduled the PDI for 51455?").
//
// The answer loop: the reviewer replies in the thread under the routed question in their
// direct message with Basecamp; Basecamp posts the answer back in the thread where the
// question was asked, adds it to the Q&A note, and marks the question answered.
//
// Each routing is recorded in the database with its topic, token counts, and estimated
// cost. The question's and answers' text is never logged or stored there; it is in
// HubSpot and Chat only.

const { errorFields, isOutOfCredits } = require('./errors');
const { routeQuestion, UNSURE } = require('./agents/askRouter');
const { checkEarlier, stillGood } = require('./agents/qaReuse');
const { checkBrief } = require('./agents/briefAnswer');
const { checkFacts } = require('./agents/factsAnswer');
const { noDashes, recordDate } = require('./agents/roamerBrief');
const { primary, secondary, label } = require('./chat/style');
const { dealsNamedIn } = require('./hubspot/namedDeals');

// How long a question waits on LightSpeed before going on without it.
const FACTS_WAIT_MS = 8000;

// How many times Basecamp asks the asker to clarify before sending the question to Blake
// as "Not sure", so nothing gets stuck.
const MAX_CLARIFY = 2;

// A question, not a document.
const MAX_CHARS = 2000;

const SAY = {
  empty: 'Add the question after /ask, for example: /ask Has the title come in yet?',
  whichDeal: (numbers) => `That question names more than one deal (${numbers.join(' and ')}). Ask about one deal at a time, so the answer is filed on the right one.`,
  tooLong: `That question is over ${MAX_CHARS} characters. Ask it in shorter parts.`,
  routed: (role) =>
    role === UNSURE
      ? "Shadow mode: I couldn't tell who owns this one, so I sent it to Blake to route."
      : `Shadow mode: this would go to the ${role}. I sent it to Blake for now.`,
  // Posted in the space by Basecamp, so the answer has a thread of Basecamp's own to land in.
  asked: (who, question, role) => `*Question from ${who}:* ${question}\n${SAY.routed(role)}`,
  noReviewer: "I couldn't reach Blake to route this. Nothing was sent; Blake can see what happened in the logs.",
  failed: "I couldn't route that question. Nothing was sent; Blake can see what happened in the logs.",
  noCredits: "I couldn't route that question: Basecamp's AI credits have run out. Nothing was sent.",
  // To the reviewer, after an answer.
  relayed: (dealNumber, saved) =>
    `Posted your answer where it was asked${dealNumber ? ` in the deal ${dealNumber} space` : ''}${saved ? ' and added it to the Q&A note in HubSpot' : ''}.`,
  noDetail: 'Type a bit more in the box, then tap Send.',
  verdict: (v) => (v === 'right' ? 'Marked right. Thanks.' : 'Marked wrong. Thanks; that one counts against reusing answers.'),
  verdictFailed: "I couldn't record that. Blake can see what happened in the logs.",
  alreadyAnswered: 'That answer was already sent; it went once.',
  relayFailed: "I couldn't post that answer where the question was asked. Blake can see what happened in the logs.",
  cardGone: "I couldn't find the question this card belongs to. Reply in its thread instead.",
};

// When Basecamp can't tell who owns a question, it answers in the thread with a card: its
// question back, a text box, and Send. Send carries the question so far, so the detail is
// tied to it without a second @mention, and nothing is stored. Anyone in the space can
// answer it; the card is replaced by the result, so it can't be answered twice.
function clarifyCard({ clarify, question, attempt, endpoint }) {
  const ask = noDashes(clarify || 'Can you say a bit more about what you want to know?');
  const safe = ask.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    fallbackText: ask,
    cardsV2: [
      {
        cardId: 'clarify',
        card: {
          sections: [
            {
              widgets: [
                { textParagraph: { text: safe } },
                { textInput: { name: 'detail', label: 'Add detail', type: 'SINGLE_LINE' } },
                {
                  buttonList: {
                    buttons: [
                      primary('Send', {
                        action: {
                          function: endpoint,
                          parameters: [
                            { key: 'action', value: 'clarify' },
                            { key: 'q', value: question },
                            { key: 'attempt', value: String(attempt) },
                          ],
                        },
                      }),
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

// The question so far plus the detail added on a clarify card, as Basecamp routes it next.
const withDetail = (question, detail) => `${question}\nDetail added: ${detail}`;

// What Blake sees in his direct message with Basecamp.
// `reuse` is what the reuse check found in the deal's earlier Q&A, or null.
function reviewMessage({ role, reason, topic, who, dealNumber, spaceUri, question, reuse = null }) {
  return [
    '*Routed question (shadow mode)*',
    `Would go to: ${role}`,
    `Why: ${reason}`,
    `Topic: ${topic}`,
    `Asked by ${who}${dealNumber ? ` in the deal ${dealNumber} space` : ' in a direct message'}${spaceUri ? `: ${spaceUri}` : ''}`,
    '',
    `Question: ${question}`,
    ...(reuse ? ['', reuseLine(reuse)] : []),
    '',
    'Reply in this thread to answer; I will post it where it was asked.',
  ].join('\n');
}

// What Basecamp would have done with an earlier answer or the brief, for Blake to judge.
// An answer too old to use is still shown, with why it was not used (Blake, 2026-11-12).
function reuseLine(reuse) {
  if (reuse.source === 'lightspeed') {
    return `*Basecamp would answer from LightSpeed:* "${reuse.answer}" (LightSpeed's ${reuse.part || 'deal facts'}, read just now, ${reuse.kind}). Mark below whether that is right.`;
  }
  if (reuse.source === 'brief') {
    const from = `the brief's ${reuse.part || 'details'}${reuse.answeredOn ? `, from ${reuse.answeredOn}` : ''}, ${reuse.kind}`;
    return reuse.stillGood
      ? `*Basecamp would answer from the brief:* "${reuse.answer}" (${from}). Mark below whether that is right.`
      : `The brief says: "${reuse.answer}" (${from}). That is a status more than 48 hours old, so Basecamp would not use it.`;
  }
  if (reuse.decision === 'answered' && reuse.stillGood) {
    return `*Basecamp would answer:* "${reuse.answer}" (${reuse.answeredBy}, ${reuse.answeredOn}, ${reuse.kind}). Mark below whether that is right.`;
  }
  if (reuse.decision === 'answered') {
    return `An earlier answer says: "${reuse.answer}" (${reuse.answeredBy}, ${reuse.answeredOn}). That is a status more than 48 hours old, so Basecamp would not reuse it; filed with that topic's questions.`;
  }
  return "A follow-up on an earlier topic; filed in that topic's Q&A note.";
}

const esc = (text) => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The routed question as a card in the reviewer's direct message, so it is answered from the
// card instead of a thread reply (a thread reply still works): the question and who asked;
// Basecamp's suggested answer, when it has a good one, with "Send this answer" (relays it and
// counts as Right) and "Not right" (counts as Wrong); a box to type an answer and Send; and
// "Not mine" when it went to the wrong role. Every button carries `ctx` (what the card shows),
// so the card can be drawn again after a tap. `note` is a line about the last tap.
function reviewCard(ctx, { reuse = null, endpoint = '', note = '' } = {}) {
  const { role, reason, who, dealNumber, spaceUri, question } = ctx;
  const act = (action, extra = []) => ({ action: { function: endpoint, parameters: [{ key: 'action', value: action }, { key: 'ctx', value: JSON.stringify(ctx) }, ...extra] } });
  const sections = [
    {
      widgets: [
        { textParagraph: { text: `<b>${esc(question)}</b>` } },
        { textParagraph: { text: `<i>Asked by ${esc(who)}${dealNumber ? ` about deal ${esc(dealNumber)}` : ' in a direct message'}. Why this role: ${esc(reason)}</i>` } },
        ...(note ? [{ textParagraph: { text: esc(note) } }] : []),
      ],
    },
  ];
  const suggested = reuse && reuse.decision === 'answered' && reuse.stillGood;
  if (suggested) {
    const from = reuse.source === 'lightspeed' ? `From LightSpeed's ${reuse.part || 'deal facts'}, read just now` : reuse.source === 'brief' ? `From the brief's ${reuse.part || 'details'}` : `From ${reuse.answeredBy}, ${reuse.answeredOn}`;
    sections.push({
      header: label('Suggested answer'),
      widgets: [
        { textParagraph: { text: esc(reuse.answer) } },
        { textParagraph: { text: `<i>${esc(from)} (${esc(reuse.kind)})</i>` } },
        { buttonList: { buttons: [primary('Send this answer', act('qaUse', [{ key: 'm', value: reuse.answer }])), secondary('Not right', act('qaWrong'))] } },
      ],
    });
  } else if (reuse) {
    sections.push({ widgets: [{ textParagraph: { text: `<i>${esc(reuseLine(reuse).replace(/\*/g, ''))}</i>` } }] });
  }
  const buttons = [(suggested ? secondary : primary)('Send', act('qaSend')), secondary('Not mine', act('qaNotMine'))];
  if (spaceUri) buttons.push(secondary('Open space', { openLink: { url: spaceUri } }));
  sections.push({ widgets: [{ textInput: { name: 'answer', label: 'Your answer', type: 'MULTIPLE_LINE' } }, { buttonList: { buttons } }] });
  return {
    fallbackText: reviewMessage({ ...ctx, reuse }),
    cardsV2: [
      {
        cardId: 'routed-question',
        card: { header: { title: role === UNSURE ? 'Question to route' : `Question for the ${role}`, subtitle: `Shadow mode: sent to you${dealNumber ? ` · Deal ${dealNumber}` : ''}` }, sections },
      },
    ],
  };
}

// Right or Wrong on what Basecamp would have answered, in Blake's thread. The tally decides
// when Basecamp may answer in deal spaces itself. Kept for cards posted before the
// routed-question card carried its own buttons.
function verdictCard({ questionId, endpoint }) {
  const tap = (text, verdict) => ({ text, type: 'OUTLINED', onClick: { action: { function: endpoint, parameters: [{ key: 'action', value: 'reuseVerdict' }, { key: 'id', value: questionId }, { key: 'verdict', value: verdict }] } } });
  return {
    fallbackText: 'Was that the right answer?',
    cardsV2: [{ cardId: 'reuse-verdict', card: { sections: [{ widgets: [{ textParagraph: { text: 'Would that have been the right answer?' } }, { buttonList: { buttons: [tap('Right', 'right'), tap('Wrong', 'wrong')] } }] }] } }],
  };
}

const nameOf = (userDisplayName, userEmail) => userDisplayName || userEmail;

// `qaNotes` keeps questions and answers in HubSpot (hubspot/qaNotes.js); left out, they are
// only relayed, not kept.
// `endpoint` is Basecamp's own URL, which a clarify card's Send button calls.
// `reuseCheck` compares a question with the deal's earlier Q&A (agents/qaReuse.js).
// `findDealSpace({ dealNumber })` looks a deal up in HubSpot (hubspot/dealContext.js), so a
// question asked in a direct message that names a deal is handled as if asked in its space.
// `readBriefNote(noteId)` reads a deal's saved brief (hubspot/dealContext.js); `briefCheck`
// looks for the answer in it (agents/briefAnswer.js).
// `readDealFacts({ dealNumber, store })` reads the deal from LightSpeed (factsJob.js's read);
// `factsCheck` looks for the answer in it (agents/factsAnswer.js). Left out, LightSpeed is
// not a source.
// `onAnswer({ question, answer, userEmail, answeredBy, dealNumber })` is told each answer
// once it is relayed (commitJob.js's noteAnswer); it may return a line to add to the reply.
function createQuestionRouter({ anthropic, db, sendMessage, findDirectMessage, reviewerEmail, log, endpoint = '', qaNotes = null, findDealSpace = null, readBriefNote = null, readDealFacts = null, onAnswer = null, route = routeQuestion, reuseCheck = checkEarlier, briefCheck = checkBrief, factsCheck = checkFacts, now = () => new Date() }) {
  // The deal's saved brief, or null when it has none or it can't be read.
  async function savedBrief(dealId, dealNumber) {
    if (!dealId || !readBriefNote) return null;
    try {
      const record = await db.getDeal(dealId);
      const saved = record && record.briefNoteId ? await readBriefNote(record.briefNoteId) : null;
      return (saved && saved.brief) || null;
    } catch (err) {
      log('WARNING', 'could not read the brief for a question', { dealNumber, error: errorFields(err) });
      return null;
    }
  }

  // The brief check's finding, with the same 48-hour rule: a status counts only within 48
  // hours of the brief item it came from, and a status with no date never counts.
  function judgeBrief(found) {
    if (!found || !found.ok || found.decision !== 'answered') return null;
    const good = found.kind === 'fact' || (Boolean(found.sourceDate) && stillGood({ kind: 'status', answeredOn: found.sourceDate }, now()));
    return { decision: 'answered', source: 'brief', noteId: null, part: found.part, kind: found.kind, stillGood: Boolean(good), answer: found.answer, answeredBy: 'the brief', answeredOn: found.sourceDate || '', costUsd: found.costUsd ?? null };
  }

  // The deal as LightSpeed has it now, or null when lookups are off, it has no such deal, it
  // could not be read, or it took too long. A question never waits long or fails on this.
  async function dealFacts(dealNumber, store) {
    if (!dealNumber || !readDealFacts) return null;
    let timer;
    const tooSlow = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), FACTS_WAIT_MS);
    });
    try {
      return await Promise.race([readDealFacts({ dealNumber, store }), tooSlow]);
    } catch (err) {
      log('WARNING', 'could not read LightSpeed for a question', { dealNumber, error: errorFields(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // The LightSpeed check's finding. It was read a moment ago, so a status is always fresh.
  function judgeFacts(found) {
    if (!found || !found.ok || found.decision !== 'answered') return null;
    return { decision: 'answered', source: 'lightspeed', noteId: null, part: found.part, kind: found.kind, stillGood: true, answer: found.answer, answeredBy: 'LightSpeed', answeredOn: recordDate(now().toISOString()), costUsd: found.costUsd ?? null };
  }

  // The deal's earlier Q&A: its questions on record and their notes' text from HubSpot.
  // Empty when there are none or they can't be read (routing goes on without them).
  async function earlierQa(dealId, dealNumber) {
    if (!dealId || !qaNotes || !qaNotes.readNotes) return { questions: [], notes: [] };
    try {
      const questions = await db.listDealQuestions(dealId);
      const notes = questions.length ? await qaNotes.readNotes(questions.map((q) => q.noteId)) : [];
      return { questions, notes };
    } catch (err) {
      log('WARNING', 'could not read earlier Q&A', { dealNumber, error: errorFields(err) });
      return { questions: [], notes: [] };
    }
  }

  // The reuse check's finding, with the 48-hour rule applied to a reused answer. The answer's
  // exact time comes from Basecamp's records when that answer (the one on the note, on the
  // day the check named) was given through Basecamp; otherwise from its date. Another, newer
  // answer on the same topic never makes an old one fresh.
  function judgeReuse(found, questions) {
    if (!found || !found.ok || found.decision === 'new') return null;
    const answeredAt = questions
      .filter((q) => q.noteId === found.noteId && q.answeredAt && recordDate(q.answeredAt) === found.answeredOn)
      .map((q) => q.answeredAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .pop();
    const age = answeredAt ? now() - Date.parse(answeredAt) : NaN;
    const fresh = answeredAt ? age >= 0 && age <= 48 * 60 * 60 * 1000 : stillGood(found, now());
    const good = found.decision === 'answered' && (found.kind === 'fact' || fresh);
    return { decision: found.decision, noteId: found.noteId, kind: found.kind, stillGood: Boolean(good), answer: found.answer, answeredBy: found.answeredBy, answeredOn: found.answeredOn, costUsd: found.costUsd ?? null };
  }

  // Returns the reply to post where the question was asked: text, or a clarify card.
  // `threadName` is the thread it was asked in, where the answer will be posted.
  // `attempt` counts the clarify cards already answered for this question.
  // `ownThread`: the question is a person's own message in a space. Chat puts a reply to the
  // thread of a person's slash command in a new thread (seen live 2026-11-12), while a reply
  // to a thread Basecamp started lands in it. So Basecamp posts the question back itself,
  // the answer goes under that, and null is returned: there is nothing more to reply.
  async function ask({ spaceName, threadName = null, isDirectMessage, userEmail, userDisplayName, text, attempt = 0, ownThread = false }) {
    const question = String(text || '').trim();
    if (!question) return SAY.empty;
    if (question.length > MAX_CHARS) return SAY.tooLong;
    const started = Date.now();
    let step = 'deal';
    let dealId = null;
    let dealNumber = null;
    let store = 'UT';
    try {
      // In a linked deal space, the question is about that deal.
      let spaceUri = null;
      let contactId = null;
      let deliveryId = null;
      if (!isDirectMessage) {
        const space = await db.getSpace(spaceName);
        const deal = space && space.status === 'ready' ? await db.getDeal(space.dealId) : null;
        if (deal && deal.spaceName === spaceName) {
          dealId = space.dealId;
          dealNumber = space.dealNumber;
          store = space.store || deal.store || store;
          spaceUri = deal.spaceUri || null;
          contactId = deal.contactId || null;
          deliveryId = deal.deliveryId || null;
        }
      } else {
        // In a direct message, a question that names a deal runs as if asked in its space:
        // filed on the deal, checked against its earlier answers, and the deal named to Blake.
        const named = await dealsNamedIn(question, { findDealSpace, log });
        if (named.length > 1) return SAY.whichDeal(named.map((d) => d.dealNumber));
        if (named.length === 1) {
          const [d] = named;
          const record = (await db.getDeal(String(d.deal.id))) || {};
          dealId = String(d.deal.id);
          dealNumber = d.dealNumber;
          store = d.store || record.store || store;
          spaceUri = record.spaceUri || null;
          contactId = d.contactId || record.contactId || null;
          deliveryId = d.deliveryId || record.deliveryId || null;
        }
      }

      step = 'route';
      // Routing and the checks against the deal's earlier Q&A, its brief, and LightSpeed run
      // side by side. Routing does not wait on LightSpeed being read.
      const routing = route({ anthropic, question, dealId });
      routing.catch(() => {});
      const [earlier, brief, facts] = await Promise.all([earlierQa(dealId, dealNumber), savedBrief(dealId, dealNumber), dealFacts(dealNumber, store)]);
      const [routed, found, inBrief, inFacts] = await Promise.all([
        routing,
        earlier.notes.length
          ? reuseCheck({ anthropic, question, notes: earlier.notes, dealId }).catch((e) => (log('WARNING', 'reuse check failed', { dealNumber, error: errorFields(e) }), null))
          : null,
        brief ? briefCheck({ anthropic, question, brief, dealId }).catch((e) => (log('WARNING', 'brief check failed', { dealNumber, error: errorFields(e) }), null)) : null,
        facts ? factsCheck({ anthropic, question, facts, dealId }).catch((e) => (log('WARNING', 'lightspeed check failed', { dealNumber, error: errorFields(e) }), null)) : null,
      ]);
      const usage = routed.usage || {};
      const cost = { model: routed.model || null, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, costUsd: routed.costUsd ?? null };
      if (!routed.ok) {
        log('WARNING', 'question not routed', { dealNumber, reason: routed.reason, ...cost });
        await db.recordQuestion({ dealId, spaceName, askedBy: userEmail, status: 'failed', ...cost });
        return SAY.failed;
      }

      // Unsure: ask the asker, not Blake, until it has asked MAX_CLARIFY times.
      if (routed.role === UNSURE && attempt < MAX_CLARIFY) {
        await db
          .recordQuestion({ dealId, spaceName, askedBy: userEmail, role: UNSURE, status: 'clarify', ...cost })
          .catch((e) => log('ERROR', 'could not record question', { dealNumber, error: errorFields(e) }));
        log('INFO', 'question needs clarifying', { dealNumber, attempt, user: userEmail, chars: question.length, ...cost, ms: Date.now() - started });
        return clarifyCard({ clarify: routed.clarify, question, attempt: attempt + 1, endpoint });
      }

      step = 'reach reviewer';
      const reviewer = await db.getPerson(reviewerEmail);
      if (!reviewer) {
        log('ERROR', 'question not sent: shadow reviewer has no Chat id on record yet', { dealNumber });
        return SAY.noReviewer;
      }

      // What Basecamp would answer with: a Team Member's earlier answer still good wins (a
      // person can know what LightSpeed cannot, such as a job being done), then LightSpeed
      // read just now, then the brief, then whatever the earlier Q&A found (a follow-up, or a
      // stale answer).
      const qa = judgeReuse(found, earlier.questions);
      const fromFacts = judgeFacts(inFacts);
      const fromBrief = judgeBrief(inBrief);
      const good = (r) => r && r.decision === 'answered' && r.stillGood;
      const reuse = good(qa) ? qa : fromFacts || (good(fromBrief) ? fromBrief : qa || fromBrief);

      // On the record before anyone answers: in the earlier topic's note when this follows
      // up on it, else a new topic note. A failed save is logged; routing goes on.
      let noteId = null;
      // A deal with no Roamer on record and no Delivery record has nowhere to keep the note.
      if (dealId && qaNotes && (qa || contactId || deliveryId)) {
        const askedBy = nameOf(userDisplayName, userEmail);
        const saving = qa
          ? qaNotes.addFollowUp({ noteId: qa.noteId, question, askedBy, at: now() }).then(() => qa.noteId)
          : qaNotes.addQuestion({ contactId, deliveryId, topic: routed.topic, question, askedBy, at: now() });
        noteId = await saving.catch((e) => (log('ERROR', 'could not save question to HubSpot', { dealNumber, error: errorFields(e) }), null));
      }

      step = 'send to reviewer';
      const dm = await findDirectMessage(reviewer.userName);
      const who = userDisplayName ? `${userDisplayName} (${userEmail})` : userEmail;
      const ctx = { role: routed.role, reason: routed.reason, topic: routed.topic, who, dealNumber, spaceUri, question };
      const sent = await sendMessage(dm, reviewCard(ctx, { reuse, endpoint }));

      let originThread = threadName;
      let postedBack = false;
      if (ownThread && !isDirectMessage) {
        const receipt = await sendMessage(spaceName, SAY.asked(nameOf(userDisplayName, userEmail), question, routed.role)).catch(
          (e) => (log('WARNING', 'could not post the question back in its space', { dealNumber, error: errorFields(e) }), null),
        );
        if (receipt && receipt.threadName) {
          originThread = receipt.threadName;
          postedBack = true;
        }
      }

      // Blake has it by now; failing to record it must not say otherwise.
      const questionId = await db
        .recordQuestion({
          dealId,
          spaceName,
          originThread,
          reviewerThread: sent && sent.threadName,
          noteId,
          topic: routed.topic,
          askedBy: userEmail,
          role: routed.role,
          status: 'shadow',
          ...cost,
        })
        .catch((e) => (log('ERROR', 'could not record question', { dealNumber, error: errorFields(e) }), null));
      if (questionId && reuse) {
        const { answer, answeredBy, ...kept } = reuse;
        // A suggested answer is judged on the card itself: Send this answer or Not right.
        await db.recordReuse({ id: questionId, reuse: kept }).catch((e) => log('ERROR', 'could not record reuse', { dealNumber, error: errorFields(e) }));
      }
      log('INFO', 'question routed', {
        dealNumber,
        role: routed.role,
        topic: routed.topic,
        noteId,
        reuse: reuse ? `${reuse.decision}${reuse.source === 'brief' ? ' from the brief' : reuse.source === 'lightspeed' ? ' from LightSpeed' : ''}${reuse.decision === 'answered' ? (reuse.stillGood ? ' (reusable)' : ' (too old)') : ''}` : 'new',
        reuseCostUsd: found && found.ok ? found.costUsd : null,
        briefCostUsd: inBrief && inBrief.ok ? inBrief.costUsd : null,
        lightspeed: facts ? (inFacts && inFacts.ok ? inFacts.decision : 'check failed') : 'not read',
        factsCostUsd: inFacts && inFacts.ok ? inFacts.costUsd : null,
        user: userEmail,
        chars: question.length,
        ...cost,
        ms: Date.now() - started,
      });
      return postedBack ? null : SAY.routed(routed.role);
    } catch (err) {
      log('ERROR', isOutOfCredits(err) ? 'question failed: out of AI credits' : 'question failed', { dealNumber, step, error: errorFields(err), ms: Date.now() - started });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  }

  // A reply in a direct message. When it is in the thread of a routed question, it is that
  // question's answer: posted back where it was asked, added to the Q&A note, and the
  // question marked answered. Returns the reply to the reviewer, or null when the message
  // is not an answer (it is then handled as any other message).
  async function relayAnswer({ threadName, userEmail, userDisplayName, text }) {
    const answer = String(text || '').trim();
    if (!threadName || !answer) return null;
    const q = await db.findQuestionByReviewerThread(threadName);
    if (!q) return null;
    const answeredBy = nameOf(userDisplayName, userEmail);
    const dealNumber = q.dealId ? (await db.getDeal(q.dealId) || {}).dealNumber || null : null;
    try {
      await sendMessage(q.spaceName, `*Answer from ${answeredBy}:* ${answer}`, { threadName: q.originThread });
    } catch (err) {
      log('ERROR', 'answer not relayed', { dealNumber, question: q.id, error: errorFields(err) });
      return SAY.relayFailed;
    }
    let saved = false;
    if (q.noteId && qaNotes) {
      saved = await qaNotes
        .addAnswer({ noteId: q.noteId, answer, answeredBy, at: now() })
        .then(() => true)
        .catch((e) => (log('ERROR', 'could not add answer to HubSpot', { dealNumber, question: q.id, error: errorFields(e) }), false));
    }
    const answers = (q.answers || 0) + 1;
    await db.markAnswered({ id: q.id, answeredBy: userEmail, answers }).catch((e) => log('ERROR', 'could not mark question answered', { question: q.id, error: errorFields(e) }));
    log('INFO', 'answer relayed', { dealNumber, question: q.id, role: q.role, topic: q.topic, answers, savedToHubSpot: saved, chars: answer.length });
    // An answer that promises something later is noted for a check-in (commitJob.js); the
    // answerer is told when, so a misread time is seen at once.
    const noted = onAnswer ? await Promise.resolve(onAnswer({ question: q, answer, userEmail, answeredBy, dealNumber })).catch(() => null) : null;
    return `${SAY.relayed(dealNumber, saved)}${noted ? ` ${noted}` : ''}`;
  }

  // Send on a clarify card: the question so far plus the detail typed in, routed again.
  async function clarify({ spaceName, threadName, isDirectMessage, userEmail, userDisplayName, question, detail, attempt }) {
    const added = String(detail || '').trim();
    if (!added) return SAY.noDetail;
    const n = Number(attempt);
    return ask({ spaceName, threadName, isDirectMessage, userEmail, userDisplayName, text: withDetail(String(question || ''), added), attempt: Number.isInteger(n) && n > 0 ? n : MAX_CLARIFY });
  }

  // A tap on the routed-question card. Returns what replaces the card: a line saying what
  // happened once it is answered, or the card drawn again with a note. The question is found
  // by the card's thread, the same way a thread reply is.
  async function fromCard({ action, threadName, userEmail, userDisplayName, params = {}, formInputs = {} }) {
    let ctx = {};
    try {
      ctx = JSON.parse(params.ctx || '{}');
    } catch {
      ctx = {};
    }
    const q = await db.findQuestionByReviewerThread(threadName);
    if (!q) return SAY.cardGone;
    const redraw = (note) => reviewCard(ctx, { endpoint, note });
    // A double tap sends one answer: the same answer to the same question counts once, and
    // is let through again only when relaying it failed.
    const once = async (answer, run) => {
      if (!(await db.claimOnce('answer', [q.id, answer]))) return `*Answered:* ${answer}\n${SAY.alreadyAnswered}`;
      const said = await run();
      if (said.endsWith(SAY.relayFailed)) await db.undoOnce('answer', [q.id, answer]).catch(() => {});
      return said;
    };
    if (action === 'qaSend') {
      const answer = String(formInputs.answer || '').trim();
      if (!answer) return redraw('Type an answer in the box, then tap Send.');
      return once(answer, async () => `*Answered:* ${answer}\n${await relayAnswer({ threadName, userEmail, userDisplayName, text: answer })}`);
    }
    if (action === 'qaUse') {
      const answer = String(params.m || '').trim();
      if (!answer) return redraw('Type an answer in the box, then tap Send.');
      return once(answer, async () => {
        await db.recordReuseVerdict({ id: q.id, verdict: 'right', by: userEmail });
        log('INFO', 'reuse verdict', { question: q.id, verdict: 'right', user: userEmail, from: 'card' });
        return `*Sent the suggested answer* (marked right): ${answer}\n${await relayAnswer({ threadName, userEmail, userDisplayName, text: answer })}`;
      });
    }
    if (action === 'qaWrong') {
      await db.recordReuseVerdict({ id: q.id, verdict: 'wrong', by: userEmail });
      log('INFO', 'reuse verdict', { question: q.id, verdict: 'wrong', user: userEmail, from: 'card' });
      return redraw('Suggested answer marked wrong. Type the right answer below.');
    }
    if (action === 'qaNotMine') {
      await db.recordRouteVerdict({ id: q.id, verdict: 'not_mine', by: userEmail });
      log('INFO', 'route verdict', { question: q.id, verdict: 'not_mine', role: q.role, user: userEmail });
      return redraw(`Marked as not the ${ctx.role || q.role}'s question. The asker still needs an answer: type one below, or leave it.`);
    }
    return SAY.cardGone;
  }

  // Right or Wrong on a reusable answer, from the card in Blake's thread.
  async function reuseVerdict({ id, verdict, userEmail }) {
    if (!/^[\w-]+$/.test(String(id || '')) || !['right', 'wrong'].includes(verdict)) return SAY.verdictFailed;
    await db.recordReuseVerdict({ id, verdict, by: userEmail });
    log('INFO', 'reuse verdict', { question: id, verdict, user: userEmail });
    return SAY.verdict(verdict);
  }

  return { ask, relayAnswer, clarify, reuseVerdict, fromCard };
}

module.exports = { createQuestionRouter, reviewMessage, reviewCard, reuseLine, verdictCard, clarifyCard, withDetail, SAY, MAX_CHARS, MAX_CLARIFY, FACTS_WAIT_MS };
