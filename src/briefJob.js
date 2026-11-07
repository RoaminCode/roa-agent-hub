'use strict';

// Runs one Roamer brief in the background and posts the result to the space it was
// asked from. Logs timing and token usage, never Roamer details.

const { errorFields, isOutOfCredits } = require('./errors');
const { writeBrief, updateBrief } = require('./agents/roamerBrief');
const { briefSignature, sameSignature } = require('./agents/briefNote');
const { renderBriefCard, renderContactChoice } = require('./chat/briefCard');

const SORRY = {
  notFound: (n, store) => `I couldn't find ${store} deal ${n} in HubSpot. Check the number and try again.`,
  duplicate: (n, store) => `HubSpot has more than one ${store} deal ${n}, so I can't tell which Roamer to read up on. Blake can sort out the duplicate.`,
  // Every deal should have its Roamer attached; a deal without one is a HubSpot problem to fix,
  // so it is also logged as a warning for an alert.
  noContact: (n) => `Deal ${n} has no Roamer contact attached in HubSpot, so there's nothing to read. That needs fixing in HubSpot; it has been flagged.`,
  notOnDeal: (n) => `That contact is no longer on deal ${n} in HubSpot. Ask for the brief again to pick from the current contacts.`,
  failed: (n) => `I couldn't finish the brief for deal ${n}. Blake can see what happened in the logs.`,
  noCredits: "Basecamp's AI credits have run out, so I can't write briefs right now. Blake will need to add more. Home still shows every deal.",
};

// A saved brief is updated from only its new items, not rewritten from the whole record,
// until this many updates have stacked up or this long has passed since the last full
// read; then the next brief rereads everything, so small updates can't drift from the record.
const MAX_UPDATES = 10;
const FULL_EVERY_MS = 30 * 24 * 60 * 60 * 1000;

// How to get the brief for a loaded deal: "reuse" the saved one (nothing changed), "update"
// it from the items added since (`newItems`), or "full" (reread everything), with why.
function planBrief(context, now = Date.now()) {
  const saved = context.briefNote;
  if (!saved || !saved.brief || !saved.signature) return { mode: 'full', why: 'no saved brief' };
  if (sameSignature(saved.signature, briefSignature(context))) return { mode: 'reuse' };
  if (saved.signature.contactId !== briefSignature(context).contactId) return { mode: 'full', why: 'different Roamer' };
  const meta = context.briefMeta;
  if (!meta) return { mode: 'full', why: 'no brief history' };
  if (meta.updates >= MAX_UPDATES) return { mode: 'full', why: `${MAX_UPDATES} updates since the last full read` };
  if (!meta.fullAt) return { mode: 'full', why: 'no full read on record yet' };
  if (now - Date.parse(meta.fullAt) > FULL_EVERY_MS) return { mode: 'full', why: '30 days since the last full read' };
  const since = saved.signature.newestAt || '';
  const newItems = context.items.filter((i) => String(i.at || '') > since);
  const older = context.items.filter((i) => String(i.at || '') <= since);
  // Something old was removed, or added with an old date: the saved brief no longer
  // matches its own record, so only a full read is safe.
  if (older.length !== saved.signature.itemCount) return { mode: 'full', why: 'older items changed' };
  // An item edited after the brief was written (a call summary filled in later).
  if (older.some((i) => i.modified && i.modified > meta.writtenAt)) return { mode: 'full', why: 'an older item was edited' };
  if (!newItems.length) return { mode: 'full', why: 'record changed with nothing new' };
  return { mode: 'update', newItems };
}

const tokens = (result) => ({ inputTokens: result.usage ? result.usage.input_tokens : null, outputTokens: result.usage ? result.usage.output_tokens : null });

// The brief for a loaded deal: the saved one from the deal's brief note when nothing in the
// record changed since it was written (no AI call, no credits); the saved one updated from
// only the new items when it can be; otherwise a fresh one from the whole record. Returns
// { brief, reused, mode, newSince }, or null when the model gave no usable brief. `mode` is
// "reuse", "update", or "full"; `newSince` lists what an update added. Shared by briefs and
// deal spaces.
function createBriefSource({ anthropic, log }) {
  return async function getBrief({ context, dealNumber, started = Date.now() }) {
    const plan = planBrief(context);
    const base = { dealNumber, items: context.items.length, omitted: context.omitted, clipped: context.clipped, missing: context.missing };
    if (plan.mode === 'reuse') {
      log('INFO', 'brief reused from HubSpot note', { dealNumber, items: context.items.length, ms: Date.now() - started });
      return { brief: context.briefNote.brief, reused: true, mode: 'reuse', newSince: [] };
    }
    if (plan.mode === 'update') {
      const result = await updateBrief({ anthropic, context, brief: context.briefNote.brief, newItems: plan.newItems });
      log('INFO', 'brief updated', { ...base, newItems: plan.newItems.length, ok: result.ok, rebuild: result.ok ? result.rebuild : null, reason: result.reason || null, ...tokens(result), ms: Date.now() - started });
      if (result.ok && !result.rebuild) return { brief: result.brief, reused: false, mode: 'update', newSince: result.newSince };
      plan.why = result.ok ? 'the update asked for a full read' : `the update failed (${result.reason})`;
    }
    const result = await writeBrief({ anthropic, context });
    log('INFO', 'brief finished', { ...base, ok: result.ok, reason: result.reason || null, why: plan.why, ...tokens(result), ms: Date.now() - started });
    return result.ok ? { brief: result.brief, reused: false, mode: 'full', newSince: [] } : null;
  };
}

// Saves a brief as the deal's brief note, if notes are on. A failure is logged, never
// thrown: the brief has already reached the Team Member.
function createNoteKeeper({ saveBriefNote, log }) {
  // Returns the saved note ({ id, updated }), or null when it was not saved. `mode` is how
  // the brief was made ("full", "update", or "reuse"), for the brief's history.
  return async function keepNote({ context, brief, dealNumber, spaceName, mode = 'full' }) {
    if (!saveBriefNote) return null;
    try {
      const note = await saveBriefNote({ context, brief, spaceName, mode });
      log('INFO', 'brief note saved', { dealNumber, noteId: note.id, updated: note.updated });
      return note;
    } catch (err) {
      log('ERROR', 'could not save brief note', { dealNumber, error: errorFields(err) });
      return null;
    }
  };
}

// `endpoint` is Basecamp's own URL, which the contact picker's buttons call.
// `saveBriefNote`, when given, keeps each new brief as the deal's brief note in HubSpot.
function createBriefJob({ loadContext, anthropic, sendMessage, log, avatarUrl, endpoint, saveBriefNote }) {
  const getBrief = createBriefSource({ anthropic, log });
  const keepNote = createNoteKeeper({ saveBriefNote, log });
  // `announce`, when given, is posted before any work so the user knows the brief is coming.
  // `contactId` is the Roamer picked from the contact picker, when the deal has several.
  return async function runBrief({ spaceName, dealNumber, store = 'UT', announce, contactId }) {
    const started = Date.now();
    try {
      if (announce) await sendMessage(spaceName, announce);
      const context = await loadContext({ store, dealNumber, contactId });
      if (context.duplicate) return await sendMessage(spaceName, SORRY.duplicate(dealNumber, store));
      if (!context.found) return await sendMessage(spaceName, SORRY.notFound(dealNumber, store));
      if (context.notOnDeal) return await sendMessage(spaceName, SORRY.notOnDeal(dealNumber));
      if (context.choices) {
        return await sendMessage(spaceName, renderContactChoice({ dealNumber, store, choices: context.choices, contactCount: context.contactCount, endpoint }));
      }
      if (!context.contact) {
        log('WARNING', 'deal has no Roamer contact', { dealNumber, store });
        return await sendMessage(spaceName, SORRY.noContact(dealNumber));
      }

      const got = await getBrief({ context, dealNumber, started });
      if (!got) return await sendMessage(spaceName, SORRY.failed(dealNumber));
      await sendMessage(spaceName, renderBriefCard({ dealNumber, context, brief: got.brief, avatarUrl }));
      // The card is out first; a note that fails to save is logged, and the next brief
      // simply writes a fresh one.
      if (!got.reused) await keepNote({ context, brief: got.brief, dealNumber, mode: got.mode });
    } catch (err) {
      // Out of credits gets its own log line, so it can be found and alerted on by name.
      const noCredits = isOutOfCredits(err);
      log('ERROR', noCredits ? 'brief failed: out of AI credits' : 'brief failed', { dealNumber, error: errorFields(err), ms: Date.now() - started });
      await sendMessage(spaceName, noCredits ? SORRY.noCredits : SORRY.failed(dealNumber)).catch((e) =>
        log('ERROR', 'could not post brief failure', { dealNumber, error: errorFields(e) }),
      );
    }
  };
}

module.exports = { createBriefJob, createBriefSource, createNoteKeeper, planBrief, SORRY, MAX_UPDATES };
