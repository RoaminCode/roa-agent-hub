'use strict';

// "/wow": WOW ideas for a deal's delivery, tailored from the deal's brief and ROA's WOW idea
// library (agents/wowPlan.js). In a deal space it is that deal; in a direct message the
// deal number comes first ("/wow 51455"). "/wow ideas" lists the library. The ideas come
// back as a card with "Use this one" on each; a tap saves the plan as a note on the Delivery
// record and the Roamer (first line "Basecamp WOW plan", so Marketing can count them), and
// remembers the idea in the library in its general form, to be re-tailored for other
// deliveries. Nothing reaches the Roamer. Logs steps, never Roamer details.

const { errorFields, isOutOfCredits } = require('./errors');
const { suggestWow } = require('./agents/wowPlan');
const { writtenAt, noDashes } = require('./agents/roamerBrief');

const MARKER = 'Basecamp WOW plan';

const SAY = {
  dealFirst: 'In a direct message, name the deal first, for example: /wow 51455',
  notDealSpace: "This space isn't linked to a deal. Link it with \"use this space for <deal#>\", or send /wow 51455 in a direct message with me.",
  noDeal: (n) => `I couldn't find deal ${n} in HubSpot.`,
  noBrief: (n) => `Deal ${n} has no Roamer brief yet, and WOW ideas start from it. Ask me for "brief ${n}" first.`,
  failed: "I couldn't come up with WOW ideas just now. Blake can see what happened in the logs.",
  noCredits: "I couldn't come up with WOW ideas: Basecamp's AI credits have run out.",
  chosen: (title, n, who) => `${who} chose the WOW plan "${title}" for deal ${n}. Saved to the Delivery record in HubSpot.`,
  chooseFailed: "I couldn't save that WOW plan. Nothing was saved; Blake can see what happened in the logs.",
  noIdeas: 'The WOW idea library is empty.',
};

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The ideas as a card: one section per idea with "Use this one", carrying what to save.
function wowCard({ dealId, dealNumber, suggestions, endpoint }) {
  const sections = suggestions.map((s, i) => ({
    header: `${i + 1}. ${escapeHtml(s.title)} <font color="#6B6B6B">${escapeHtml(s.tier)}</font>`,
    widgets: [
      { textParagraph: { text: escapeHtml(s.tailored) } },
      { textParagraph: { text: `<font color="#6B6B6B">Why: ${escapeHtml(s.why)} · ${escapeHtml(s.owner)}${s.ideaId ? '' : ' · New idea'}</font>` } },
      {
        buttonList: {
          buttons: [
            {
              text: 'Use this one',
              type: 'FILLED_TONAL',
              onClick: {
                action: {
                  function: endpoint,
                  parameters: [
                    { key: 'action', value: 'wowPick' },
                    { key: 'd', value: String(dealId) },
                    { key: 'n', value: String(dealNumber) },
                    { key: 'i', value: s.ideaId || '' },
                    { key: 't', value: s.title },
                    { key: 'w', value: s.tailored },
                    { key: 'g', value: s.idea },
                    { key: 'f', value: s.fitsWhen || '' },
                    { key: 'c', value: s.category },
                    { key: 'r', value: s.tier },
                  ],
                },
              },
            },
          ],
        },
      },
    ],
  }));
  return {
    fallbackText: `WOW ideas for deal ${dealNumber}`,
    cardsV2: [{ cardId: `wow-${dealNumber}`, card: { header: { title: `WOW ideas for deal ${dealNumber}`, subtitle: 'Tailored from the brief. Pick one to plan it.' }, sections } }],
  };
}

// The note saved on the Delivery record and the Roamer when a plan is chosen.
function renderWowNote({ title, tailored, category, tier, who, now }) {
  return [
    `<p><strong>${MARKER}: ${escapeHtml(title)}</strong></p>`,
    `<p>${escapeHtml(tailored)}</p>`,
    `<p>${escapeHtml(category)}, ${escapeHtml(tier)}. Chosen by ${escapeHtml(who)} in Google Chat, ${writtenAt(now)} MT.</p>`,
  ].join('');
}

// `readBriefNote(noteId)` reads a deal's saved brief (hubspot/dealContext.js);
// `findDealSpace({ dealNumber })` finds a deal by number; `createNote` is the HubSpot client's.
// `library` is the WOW idea library (wowLibrary.js): the team's sheet, or the database.
// `sheetUrl`, when set, is linked from "/wow ideas".
function createWow({ anthropic, db, library, readBriefNote, findDealSpace, createNote, log, endpoint = '', sheetUrl = null, suggest = suggestWow, now = () => new Date() }) {
  async function listIdeas() {
    const ideas = await library.listIdeas();
    if (!ideas.length) return SAY.noIdeas;
    return [
      '*WOW idea library* (most used first)',
      ...ideas.map((i) => `• ${i.idea} (${i.category}, ${i.tier}${i.uses ? `, used ${i.uses}` : ''})`),
      ...(sheetUrl ? ['', `Edit the list: ${sheetUrl}`] : []),
    ].join('\n');
  }

  // Returns the reply: a card of ideas, or text.
  async function wow({ spaceName, isDirectMessage, text = '', userEmail }) {
    const args = String(text || '').trim();
    if (/^ideas?$/i.test(args)) return listIdeas();
    const started = Date.now();
    let dealNumber = null;
    try {
      let dealId = null;
      if (isDirectMessage) {
        const m = /^#?(\d{3,8})\b/.exec(args);
        if (!m) return SAY.dealFirst;
        dealNumber = m[1];
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
      const record = (await db.getDeal(dealId)) || {};
      const saved = record.briefNoteId ? await readBriefNote(record.briefNoteId) : null;
      if (!saved || !saved.brief) return SAY.noBrief(dealNumber);

      const [ideas, standards] = await Promise.all([library.listIdeas(), library.standards()]);
      const result = await suggest({ anthropic, brief: saved.brief, ideas, standards });
      const usage = result.usage || {};
      log('INFO', result.ok ? 'wow ideas' : 'wow ideas failed', {
        dealNumber,
        reason: result.reason || null,
        suggestions: result.ok ? result.suggestions.length : 0,
        fromLibrary: result.ok ? result.suggestions.filter((s) => s.ideaId).length : 0,
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        user: userEmail,
        ms: Date.now() - started,
      });
      if (!result.ok) return SAY.failed;
      return wowCard({ dealId, dealNumber, suggestions: result.suggestions, endpoint });
    } catch (err) {
      log('ERROR', isOutOfCredits(err) ? 'wow failed: out of AI credits' : 'wow failed', { dealNumber, error: errorFields(err), ms: Date.now() - started });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  }

  // "Use this one": the plan saved on the Delivery record and the Roamer, and the idea
  // remembered in the library. Returns the text that replaces the card.
  async function choose({ params, userEmail, userDisplayName }) {
    const p = params || {};
    const dealNumber = /^\d{3,8}$/.test(String(p.n || '')) ? String(p.n) : null;
    try {
      if (!/^\d+$/.test(String(p.d || '')) || !p.t || !p.w) return SAY.chooseFailed;
      const record = (await db.getDeal(String(p.d))) || {};
      if (!record.contactId && !record.deliveryId) return SAY.chooseFailed;
      const who = userDisplayName || userEmail;
      const title = noDashes(p.t);
      const tailored = noDashes(p.w);
      const at = now();
      const noteId = await createNote({
        contactId: record.contactId || null,
        deliveryId: record.deliveryId || null,
        body: renderWowNote({ title, tailored, category: p.c || 'Gift', tier: p.r || '$', who, now: at }),
        timestamp: at.toISOString(),
      });
      // Remembered in the library: a library idea is counted, a new one is added in general form.
      const remembered = await (p.i
        ? library.useIdea({ ideaId: p.i })
        : library.addIdea({ idea: noDashes(p.g || tailored), fitsWhen: noDashes(p.f || ''), category: p.c || 'Gift', tier: p.r || '$', by: userEmail })
      ).then(
        () => true,
        (e) => (log('ERROR', 'could not remember wow idea', { dealNumber, error: errorFields(e) }), false),
      );
      log('INFO', 'wow plan chosen', { dealNumber, noteId, fromLibrary: Boolean(p.i), remembered, library: library.source, user: userEmail });
      return SAY.chosen(title, dealNumber || '', who);
    } catch (err) {
      log('ERROR', 'wow plan not saved', { dealNumber, error: errorFields(err) });
      return SAY.chooseFailed;
    }
  }

  return { wow, choose, listIdeas };
}

module.exports = { createWow, wowCard, renderWowNote, SAY, MARKER };
