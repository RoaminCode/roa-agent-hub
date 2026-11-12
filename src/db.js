'use strict';

// Basecamp's own records in Firestore: which deal has which Chat space, the deal's brief
// note and what it was built from, access requests, and notes saved from spaces. IDs,
// timestamps, and statuses only, never Roamer names or what anyone wrote: those stay in
// HubSpot. Only Basecamp writes here, so a record cannot drift the way a hand-edited
// HubSpot note can.
//
// Collections:
//   deals/{hubspotDealId}   dealNumber, store, contactId, briefNoteId, briefSignature,
//                           briefWrittenAt, spaceName, spaceUri, spaceHow, spaceLinkedAt,
//                           spaceLinkedBy, spaceBriefPosted, spaceClaim, deliveryId,
//                           deliveryClaim, briefUpdates, briefFullAt,
//                           deliveryCreatedByBasecamp, deliveryLinkedAt, updatedAt
//   spaces/{spaceId}        spaceName, dealId, dealNumber, store, how, status, linkedAt,
//                           linkedBy (status "ready" or "gone")
//   accessRequests/{auto}   dealId, spaceName, user, at
//   spaceNotes/{noteId}     dealId, spaceName, user, at, chars
//   people/{email}          userName (Chat id), seenAt
//   textSends/{card}        dealId, approvedBy, lineId, to, wouldGoTo, message, shadow, card, at,
//                           status ("sending", "sent", "unknown"), claimedAt; keyed by the
//                           draft card, so each draft is claimed once (older ones: {auto})
//                           (the send log the rule for texts asks for; the one place a
//                           text and a number are kept)
//   wowIdeas/{auto}         idea (general, no Roamer details), category, tier, uses,
//                           source ("starter" or "chosen"), createdBy, active, lastUsedAt
//   questions/{auto}        dealId, spaceName, originThread, reviewerThread, noteId, topic,
//                           askedBy, role, model, inputTokens, outputTokens, costUsd,
//                           status ("shadow", "answered", "failed"), answers, answeredBy,
//                           answeredAt, reuse { decision, noteId, kind, stillGood },
//                           reuseVerdict, reuseVerdictBy, reuseVerdictAt, routeVerdict ("not_mine"),
//                           routeVerdictBy, routeVerdictAt, at (never the
//                           question or answer: those are in the HubSpot Q&A note)
//   once/{kind_hash}        kind, at: a tap that counts once ("Send this answer", "Use this one")
//   locks/{name}            token, at: held for seconds while a HubSpot note is read and rewritten
//   reminders/{auto}        userEmail, userName (Chat id, for the direct message), what,
//                           dueAt, dealId, dealNumber, spaceUri, status ("pending",
//                           "sending", "sent", "failed"), tries, claimedAt, sentAt, at.
//                           `what` is the person's own words, kept only until the reminder
//                           is sent or given up on, then cleared
//   commitments/{auto}      questionId, dealId, dealNumber, noteId, topic, by (email),
//                           byName, what, promisedAt, dueAt, sendAt, status ("pending",
//                           "checking", "kept", "followed_up", "failed"), keptBy ("answer",
//                           "space", "hubspot"), tries, claimedAt, closedAt. A promise made
//                           in an answer (commitJob.js). `what` is the promise in the
//                           person's words, kept only until it is closed, then cleared; the
//                           rest stays as the record of kept and missed promises
//   spend/{YYYY-MM-DD}      day (Utah), totalUsd, calls, jobs { job: { usd, calls } },
//                           models { model: { usd, calls } }, limitReachedAt, updatedAt:
//                           what the AI cost that day (spend.js). A deal's own total is
//                           aiCostUsd and aiCalls on its deals record

const { createHash } = require('crypto');
const { safeError } = require('./errors');

// A lock older than this was left by a run that crashed, and may be taken.
const LOCK_MS = 30 * 1000;
// A reminder or commitment claimed by a timer run for longer than this was left by a run
// that stopped, and may be claimed again.
const STALE_MS = 10 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A claim to create a deal's space stops a second tap from creating a second space. Past
// this age it is treated as abandoned (the run crashed) and can be taken again.
const CLAIM_MS = 3 * 60 * 1000;

const spaceId = (spaceName) => {
  const m = /^spaces\/([\w-]+)$/.exec(spaceName || '');
  if (!m) throw safeError('invalid space name');
  return m[1];
};
// A draft card's message name ("spaces/A/messages/B.C") as a document id, which cannot hold "/".
const cardKey = (card) => {
  if (!/^spaces\/[\w-]+\/messages\/[\w.-]+$/.test(String(card || ''))) throw safeError('invalid card');
  return String(card).replace(/\//g, '__');
};
const dealDocId = (dealId) => {
  if (!/^\d+$/.test(String(dealId || ''))) throw safeError('invalid deal id');
  return String(dealId);
};

// `firestore` is a Firestore client (or a fake with the same calls, for tests).
function createDb({ firestore, now = () => new Date() }) {
  const deals = firestore.collection('deals');
  const spaces = firestore.collection('spaces');
  const textSends = firestore.collection('textSends');
  const stamp = () => now().toISOString();

  async function getDeal(dealId) {
    const snap = await deals.doc(dealDocId(dealId)).get();
    return snap.exists ? snap.data() : null;
  }

  async function getSpace(spaceName) {
    const snap = await spaces.doc(spaceId(spaceName)).get();
    return snap.exists ? snap.data() : null;
  }

  // The brief note just saved: its id, what the brief was built from, and when. `mode`
  // keeps the brief's history: a "full" read resets the update count and its date, an
  // "update" adds one, and a "reuse" (saved again for its space) changes neither, nor when
  // the brief was written, so an item edited since still counts as an edit next time. In a
  // transaction, so two updates at once count two.
  async function recordBrief({ dealId, dealNumber, store, contactId, noteId, signature, mode = 'full' }) {
    const ref = deals.doc(dealDocId(dealId));
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const history = {};
      if (mode === 'full') Object.assign(history, { briefUpdates: 0, briefFullAt: stamp() });
      if (mode === 'update') history.briefUpdates = ((snap.exists && snap.data().briefUpdates) || 0) + 1;
      if (mode !== 'reuse') history.briefWrittenAt = stamp();
      tx.set(ref, { dealNumber: String(dealNumber), store, contactId: contactId ? String(contactId) : null, briefNoteId: String(noteId), briefSignature: signature, ...history, updatedAt: stamp() }, { merge: true });
    });
  }

  // Before Basecamp creates a space: { claimed: true }, or { busy: true } when another run
  // is creating this deal's space right now.
  async function claimSpace({ dealId, by }) {
    const ref = deals.doc(dealDocId(dealId));
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const claim = snap.exists ? snap.data().spaceClaim : null;
      if (claim && now() - new Date(claim.at) < CLAIM_MS) return { busy: true };
      tx.set(ref, { spaceClaim: { by, at: stamp() }, updatedAt: stamp() }, { merge: true });
      return { claimed: true };
    });
  }

  // The deal's HubSpot Delivery record, and whether Basecamp created it.
  async function recordDelivery({ dealId, deliveryId, created }) {
    await deals.doc(dealDocId(dealId)).set({ deliveryId: String(deliveryId), deliveryCreatedByBasecamp: Boolean(created), deliveryLinkedAt: stamp(), deliveryClaim: null, updatedAt: stamp() }, { merge: true });
  }

  // Before Basecamp looks for or creates a deal's Delivery record: { deliveryId } when it is
  // already recorded, { busy: true } when another run is on it right now, else { claimed:
  // true }. So two people opening the deal's space at once make one record, not two.
  async function claimDelivery(dealId) {
    const ref = deals.doc(dealDocId(dealId));
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      if (d.deliveryId) return { deliveryId: d.deliveryId };
      if (d.deliveryClaim && now() - new Date(d.deliveryClaim.at) < CLAIM_MS) return { busy: true };
      tx.set(ref, { deliveryClaim: { at: stamp() }, updatedAt: stamp() }, { merge: true });
      return { claimed: true };
    });
  }

  async function releaseDeliveryClaim(dealId) {
    await deals.doc(dealDocId(dealId)).set({ deliveryClaim: null, updatedAt: stamp() }, { merge: true });
  }

  async function releaseClaim(dealId) {
    await deals.doc(dealDocId(dealId)).set({ spaceClaim: null, updatedAt: stamp() }, { merge: true });
  }

  // The deal's space, created by Basecamp ("created") or by a person ("adopted"). Replaces
  // any earlier space on the deal, which is marked gone.
  async function linkSpace({ dealId, dealNumber, store, spaceName, spaceUri, how, by }) {
    const dealRef = deals.doc(dealDocId(dealId));
    const spaceRef = spaces.doc(spaceId(spaceName));
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(dealRef);
      const earlier = snap.exists ? snap.data().spaceName : null;
      if (earlier && earlier !== spaceName) tx.set(spaces.doc(spaceId(earlier)), { status: 'gone', updatedAt: stamp() }, { merge: true });
      tx.set(
        dealRef,
        { dealNumber: String(dealNumber), store, spaceName, spaceUri: spaceUri || null, spaceHow: how, spaceLinkedAt: stamp(), spaceLinkedBy: by, spaceBriefPosted: false, spaceClaim: null, updatedAt: stamp() },
        { merge: true },
      );
      tx.set(spaceRef, { spaceName, dealId: dealDocId(dealId), dealNumber: String(dealNumber), store, how, status: 'ready', linkedAt: stamp(), linkedBy: by, updatedAt: stamp() });
    });
  }

  // The brief is posted in the deal's space, so a space whose opening stopped part way can be
  // told from one that finished (spaceJob.js).
  async function markBriefPosted(dealId) {
    await deals.doc(dealDocId(dealId)).set({ spaceBriefPosted: true, updatedAt: stamp() }, { merge: true });
  }

  // A recorded space that no longer exists in Chat (deleted, or Basecamp removed).
  async function markSpaceGone({ dealId, spaceName }) {
    const batch = firestore.batch();
    batch.set(spaces.doc(spaceId(spaceName)), { status: 'gone', updatedAt: stamp() }, { merge: true });
    batch.set(deals.doc(dealDocId(dealId)), { spaceName: null, spaceUri: null, updatedAt: stamp() }, { merge: true });
    await batch.commit();
  }

  // Every ready deal space in one store: [{ spaceName, dealId, dealNumber, uri }].
  async function listDealSpaces(store) {
    const snap = await spaces.where('status', '==', 'ready').get();
    const out = [];
    for (const doc of snap.docs) {
      const s = doc.data();
      if (s.store !== store) continue;
      const deal = await getDeal(s.dealId);
      // The deal record is the authority: a space it no longer names is not the deal's.
      if (deal && deal.spaceName === s.spaceName) out.push({ spaceName: s.spaceName, dealId: s.dealId, dealNumber: s.dealNumber, uri: deal.spaceUri || null });
    }
    return out;
  }

  async function recordAccessRequest({ dealId, spaceName, user }) {
    await firestore.collection('accessRequests').add({ dealId: dealDocId(dealId), spaceName, user, at: stamp() });
  }

  async function recordSpaceNote({ noteId, dealId, spaceName, user, chars }) {
    await firestore.collection('spaceNotes').doc(String(noteId)).set({ dealId: dealDocId(dealId), spaceName, user, chars, at: stamp() });
  }

  // A person's Chat id ("users/123") by their email, so Basecamp can reach their direct
  // message (Chat finds one by id, not email). Recorded from their own Chat events.
  async function rememberPerson({ email, userName }) {
    if (!email || !/^users\/[\w-]+$/.test(userName || '')) return;
    await firestore.collection('people').doc(String(email).toLowerCase()).set({ userName, seenAt: stamp() }, { merge: true });
  }

  async function getPerson(email) {
    const snap = await firestore.collection('people').doc(String(email || '').toLowerCase()).get();
    return snap.exists ? snap.data() : null;
  }

  // A routed question, without its text: who asked, where (the space and thread, for the
  // answer), where it went for an answer (the reviewer's thread), its topic and HubSpot Q&A
  // note, the role, and what the routing cost.
  async function recordQuestion({ dealId, spaceName, originThread, reviewerThread, noteId, topic, askedBy, role, model, inputTokens, outputTokens, costUsd, status }) {
    const ref = await firestore.collection('questions').add({
      dealId: dealId ? dealDocId(dealId) : null,
      spaceName: spaceName || null,
      originThread: originThread || null,
      reviewerThread: reviewerThread || null,
      noteId: noteId ? String(noteId) : null,
      topic: topic || null,
      askedBy,
      role: role || null,
      model: model || null,
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
      costUsd: costUsd ?? null,
      status,
      answers: 0,
      at: stamp(),
    });
    return ref.id;
  }

  // The question sent to the reviewer in this thread, as { id, ...fields }, or null.
  async function findQuestionByReviewerThread(threadName) {
    if (!threadName) return null;
    const snap = await firestore.collection('questions').where('reviewerThread', '==', threadName).get();
    const doc = snap.docs[0];
    return doc ? { id: doc.id, ...doc.data() } : null;
  }

  // A deal's questions that have a Q&A note, as [{ id, noteId, topic, status, answeredAt }].
  async function listDealQuestions(dealId) {
    const snap = await firestore.collection('questions').where('dealId', '==', dealDocId(dealId)).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((q) => q.noteId);
  }

  // Blake's verdict on what Basecamp would have reused for a question: "right" or "wrong".
  async function recordReuseVerdict({ id, verdict, by }) {
    await firestore.collection('questions').doc(id).set({ reuseVerdict: verdict, reuseVerdictBy: by, reuseVerdictAt: stamp() }, { merge: true });
  }

  // "Not mine" on a routed question: the routing was wrong, kept for the routing tally.
  async function recordRouteVerdict({ id, verdict, by }) {
    await firestore.collection('questions').doc(id).set({ routeVerdict: verdict, routeVerdictBy: by, routeVerdictAt: stamp() }, { merge: true });
  }

  // What the reuse check proposed for a question (no text: the decision and which note).
  async function recordReuse({ id, reuse }) {
    await firestore.collection('questions').doc(id).set({ reuse }, { merge: true });
  }

  // The WOW idea library, most used first. Seeded with `starter` once, the first time it has
  // no starter ideas at all (one set aside, active false, still counts, so it never returns).
  // Ideas are general (no Roamer details); `/wow` tailors them to each delivery.
  async function listWowIdeas(starter = []) {
    const col = firestore.collection('wowIdeas');
    if (starter.length && !(await col.where('source', '==', 'starter').get()).docs.length) {
      for (const s of starter) await col.add({ ...s, uses: 0, source: 'starter', active: true, createdAt: stamp() });
    }
    const snap = await col.where('active', '==', true).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.uses || 0) - (a.uses || 0));
  }

  // A WOW idea chosen for a delivery: counted if it is in the library, else added to it in
  // its general form. Returns its id.
  async function useWowIdea({ ideaId, idea, category, tier, by }) {
    const col = firestore.collection('wowIdeas');
    if (ideaId) {
      const ref = col.doc(String(ideaId));
      const snap = await ref.get();
      if (snap.exists) {
        await ref.set({ uses: (snap.data().uses || 0) + 1, lastUsedAt: stamp() }, { merge: true });
        return String(ideaId);
      }
    }
    const ref = await col.add({ idea, category, tier, uses: 1, source: 'chosen', createdBy: by, active: true, createdAt: stamp(), lastUsedAt: stamp() });
    return ref.id;
  }

  // An approved text and its send: line, recipient, time, approver, and the exact text (the
  // rule for sends asks for this log). In shadow mode `to` is the approver's own phone and
  // `wouldGoTo` the Roamer's number.
  // `card` is the draft card the text was approved from; its send is the record claimTextSend
  // made, so a draft is sent only once.
  async function recordTextSend({ dealId, approvedBy, lineId, to, wouldGoTo, message, shadow, card = null }) {
    const fields = { dealId: dealDocId(dealId), approvedBy, lineId: String(lineId), to, wouldGoTo: wouldGoTo || null, message, shadow: Boolean(shadow), card: card || null, at: stamp() };
    if (card) {
      await textSends.doc(cardKey(card)).set({ ...fields, status: 'sent' }, { merge: true });
      return cardKey(card);
    }
    const ref = await textSends.add(fields);
    return ref.id;
  }

  // Claims a draft card before its text goes to Aloware: true for the one Approve that may
  // send it, false when another already did or is sending it right now. Claimed in one
  // transaction, so a double tap or two Teammates approving at once send one text, not two.
  async function claimTextSend({ card, by }) {
    if (await textSentFromCard(card)) return false;
    const ref = textSends.doc(cardKey(card));
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { card: String(card), status: 'sending', approvedBy: by, claimedAt: stamp() });
      return true;
    });
  }

  // Aloware refused the send outright, so nothing went: the draft may be approved again.
  async function releaseTextSend(card) {
    await textSends.doc(cardKey(card)).delete();
  }

  // Aloware gave no answer (a timeout or a dropped connection): the text may have gone. The
  // claim stays, so the draft is not sent again blind.
  async function markTextSendUnknown(card) {
    await textSends.doc(cardKey(card)).set({ status: 'unknown', at: stamp() }, { merge: true });
  }

  // Whether a text was already sent from this draft card (records from before claims, which
  // have their own ids).
  async function textSentFromCard(card) {
    if (!card) return false;
    return (await textSends.where('card', '==', String(card)).get()).docs.length > 0;
  }

  // A tap that must count once (a double tap, or the same card tapped twice): true for the
  // first, false after. `parts` name it; only their hash is kept. undoOnce lets it be tapped
  // again when what it started failed.
  const onceRef = (kind, parts) => firestore.collection('once').doc(`${kind}_${createHash('sha1').update(parts.map(String).join('|')).digest('hex').slice(0, 24)}`);
  async function claimOnce(kind, parts) {
    const ref = onceRef(kind, parts);
    return firestore.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return false;
      tx.set(ref, { kind, at: stamp() });
      return true;
    });
  }
  async function undoOnce(kind, parts) {
    await onceRef(kind, parts).delete();
  }

  // Runs `fn` while holding the named lock, so two runs that read then write the same thing
  // (a HubSpot note) take turns instead of one overwriting the other. Waits up to `waitMs`
  // for the lock, then fails rather than run unguarded.
  async function withLock(name, fn, { waitMs = 8000, stepMs = 200 } = {}) {
    const ref = firestore.collection('locks').doc(String(name).replace(/\//g, '_'));
    const token = `${Date.now()}-${Math.random()}`;
    const take = () =>
      firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists && now() - new Date(snap.data().at) < LOCK_MS) return false;
        tx.set(ref, { token, at: stamp() });
        return true;
      });
    const until = Date.now() + waitMs;
    while (!(await take())) {
      if (Date.now() > until) throw safeError(`lock ${name} is busy`);
      await sleep(stepMs);
    }
    try {
      return await fn();
    } finally {
      // Only its own lock: one held past LOCK_MS may have been taken by another run by now.
      await firestore
        .runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists && snap.data().token === token) tx.delete(ref);
        })
        .catch(() => {});
    }
  }

  async function markAnswered({ id, answeredBy, answers }) {
    await firestore.collection('questions').doc(id).set({ status: 'answered', answeredBy, answeredAt: stamp(), answers }, { merge: true });
  }

  // Reminders a person set with /remind. Pending ones are few, so the due check reads all
  // of them and compares times in code (one equality filter needs no extra index).
  const reminders = firestore.collection('reminders');
  async function addReminder({ userEmail, userName, what, dueAt, dealId = null, dealNumber = null, spaceUri = null }) {
    const ref = await reminders.add({ userEmail, userName, what, dueAt: dueAt.toISOString(), dealId: dealId ? String(dealId) : null, dealNumber: dealNumber ? String(dealNumber) : null, spaceUri, status: 'pending', at: stamp() });
    return ref.id;
  }
  async function dueReminders() {
    const t = now().getTime();
    const pending = (await reminders.where('status', '==', 'pending').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    return [...pending, ...(await stale(reminders, 'sending'))].filter((r) => Date.parse(r.dueAt) <= t);
  }
  // Records claimed by a run that then stopped (a deploy, a crash): claimed longer ago than
  // STALE_MS and never finished. They are due again, so nothing waits forever.
  const isStale = (d) => !d.claimedAt || now().getTime() - Date.parse(d.claimedAt) > STALE_MS;
  async function stale(collection, status) {
    return (await collection.where('status', '==', status).get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter(isStale);
  }
  const claimable = (d, claimed) => d.status === 'pending' || (d.status === claimed && isStale(d));
  // Claims one reminder for sending, so two timer runs never send it twice: true only for
  // the run that moved it from pending.
  async function claimReminder(id) {
    const ref = reminders.doc(String(id));
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || !claimable(snap.data(), 'sending')) return false;
      tx.set(ref, { status: 'sending', claimedAt: stamp() }, { merge: true });
      return true;
    });
  }
  // Sent or given up on; the person's words are cleared either way.
  async function finishReminder(id, status) {
    await reminders.doc(String(id)).set({ status, what: null, sentAt: stamp() }, { merge: true });
  }
  // A send that failed: back to pending with its words kept, to try again on the next
  // timer run. Returns how many times it has now been tried.
  async function retryReminder(id) {
    const ref = reminders.doc(String(id));
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const tries = ((snap.exists && snap.data().tries) || 0) + 1;
      tx.set(ref, { status: 'pending', tries, claimedAt: null }, { merge: true });
      return tries;
    });
  }

  // Promises made in answers (commitJob.js). Open ones are few, so the due check reads them
  // all and compares times in code, as reminders do.
  const commitments = firestore.collection('commitments');
  async function addCommitment({ questionId, dealId = null, dealNumber = null, noteId = null, topic = null, by, byName = null, what, dueAt, sendAt }) {
    const ref = await commitments.add({ questionId: String(questionId), dealId: dealId ? String(dealId) : null, dealNumber: dealNumber ? String(dealNumber) : null, noteId: noteId ? String(noteId) : null, topic, by, byName, what, promisedAt: stamp(), dueAt: dueAt.toISOString(), sendAt: sendAt.toISOString(), status: 'pending', tries: 0 });
    return ref.id;
  }
  // Open promises whose check-in time has come.
  async function dueCommitments() {
    const t = now().getTime();
    const pending = (await commitments.where('status', '==', 'pending').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    return [...pending, ...(await stale(commitments, 'checking'))].filter((c) => Date.parse(c.sendAt) <= t);
  }
  // Claims one promise for its check, so two timer runs never follow up twice.
  async function claimCommitment(id) {
    const ref = commitments.doc(String(id));
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || !claimable(snap.data(), 'checking')) return false;
      tx.set(ref, { status: 'checking', claimedAt: stamp() }, { merge: true });
      return true;
    });
  }
  // A check that could not finish (AI off for now, or an error): back to pending for the
  // next timer run. `counts` false leaves the tries alone, for a wait that is nobody's
  // failure. Returns how many times it has now been tried.
  async function releaseCommitment(id, { counts = true } = {}) {
    const ref = commitments.doc(String(id));
    return firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const tries = ((snap.exists && snap.data().tries) || 0) + (counts ? 1 : 0);
      tx.set(ref, { status: 'pending', tries, claimedAt: null }, { merge: true });
      return tries;
    });
  }
  // Closed: "kept" (with how it was seen), "followed_up" (not seen by its time, so the one
  // follow-up went out), or "failed". The promise's words are cleared.
  async function finishCommitment(id, status, { keptBy = null } = {}) {
    await commitments.doc(String(id)).set({ status, keptBy, what: null, closedAt: stamp() }, { merge: true });
  }
  // A newer answer on a question keeps the promises still open on it. Returns how many.
  async function keepCommitmentsFor(questionId) {
    const open = (await commitments.where('questionId', '==', String(questionId)).get()).docs.filter((d) => ['pending', 'checking'].includes(d.data().status));
    for (const d of open) await finishCommitment(d.id, 'kept', { keptBy: 'answer' });
    return open.length;
  }

  // One question by its id, as { id, ...fields }, or null.
  async function getQuestion(id) {
    if (!/^[\w-]+$/.test(String(id || ''))) return null;
    const snap = await firestore.collection('questions').doc(String(id)).get();
    return snap.exists ? { id: String(id), ...snap.data() } : null;
  }
  // The reviewer's thread for a question, when a later message about it started a new one,
  // so a reply there is still read as its answer.
  async function setReviewerThread({ id, reviewerThread }) {
    await firestore.collection('questions').doc(String(id)).set({ reviewerThread }, { merge: true });
  }

  // One AI call's cost, added to its day (by job and by model) and, when it was about a
  // deal, to that deal's total. Returns { totalUsd, crossed }: the day's total, and whether
  // this call is the one that took the day to `limitUsd` (true once a day, so Blake is told once).
  const spend = firestore.collection('spend');
  const spendDay = (day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw safeError('invalid day');
    return spend.doc(String(day));
  };
  async function addSpend({ day, job, model, costUsd, dealId = null, limitUsd = null }) {
    const ref = spendDay(day);
    const bump = (map, key) => {
      const was = (map && map[key]) || { usd: 0, calls: 0 };
      return { ...(map || {}), [key]: { usd: was.usd + costUsd, calls: was.calls + 1 } };
    };
    const result = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? snap.data() : {};
      const totalUsd = (d.totalUsd || 0) + costUsd;
      const crossed = Boolean(limitUsd) && totalUsd >= limitUsd && !d.limitReachedAt;
      tx.set(ref, {
        day: String(day),
        totalUsd,
        calls: (d.calls || 0) + 1,
        jobs: bump(d.jobs, String(job || 'other')),
        models: bump(d.models, String(model || 'unknown')),
        limitReachedAt: crossed ? stamp() : d.limitReachedAt || null,
        updatedAt: stamp(),
      });
      return { totalUsd, crossed };
    });
    if (dealId && /^\d+$/.test(String(dealId))) {
      const dealRef = deals.doc(String(dealId));
      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(dealRef);
        const d = snap.exists ? snap.data() : {};
        tx.set(dealRef, { aiCostUsd: (d.aiCostUsd || 0) + costUsd, aiCalls: (d.aiCalls || 0) + 1, updatedAt: stamp() }, { merge: true });
      });
    }
    return result;
  }
  async function getSpend(day) {
    const snap = await spendDay(day).get();
    return snap.exists ? snap.data() : null;
  }

  return { addSpend, getSpend, addReminder, dueReminders, claimReminder, finishReminder, retryReminder, addCommitment, dueCommitments, claimCommitment, releaseCommitment, finishCommitment, keepCommitmentsFor, getQuestion, setReviewerThread, getDeal, getSpace, recordBrief, recordDelivery, claimDelivery, releaseDeliveryClaim, claimSpace, releaseClaim, linkSpace, markBriefPosted, markSpaceGone, listDealSpaces, recordAccessRequest, recordSpaceNote, rememberPerson, getPerson, recordQuestion, findQuestionByReviewerThread, markAnswered, listDealQuestions, recordReuse, recordReuseVerdict, recordRouteVerdict, listWowIdeas, useWowIdea, claimOnce, undoOnce, withLock, recordTextSend, claimTextSend, releaseTextSend, markTextSendUnknown, textSentFromCard };
}

module.exports = { createDb, CLAIM_MS, STALE_MS };
