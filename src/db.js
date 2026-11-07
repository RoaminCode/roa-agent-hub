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
//                           spaceLinkedBy, spaceClaim, deliveryId, briefUpdates, briefFullAt,
//                           deliveryCreatedByBasecamp, deliveryLinkedAt, updatedAt
//   spaces/{spaceId}        spaceName, dealId, dealNumber, store, how, status, linkedAt,
//                           linkedBy (status "ready" or "gone")
//   accessRequests/{auto}   dealId, spaceName, user, at
//   spaceNotes/{noteId}     dealId, spaceName, user, at, chars
//   people/{email}          userName (Chat id), seenAt
//   wowIdeas/{auto}         idea (general, no Roamer details), category, tier, uses,
//                           source ("starter" or "chosen"), createdBy, active, lastUsedAt
//   questions/{auto}        dealId, spaceName, originThread, reviewerThread, noteId, topic,
//                           askedBy, role, model, inputTokens, outputTokens, costUsd,
//                           status ("shadow", "answered", "failed"), answers, answeredBy,
//                           answeredAt, reuse { decision, noteId, kind, stillGood },
//                           reuseVerdict, reuseVerdictBy, reuseVerdictAt, at (never the
//                           question or answer: those are in the HubSpot Q&A note)

const { safeError } = require('./errors');

// A claim to create a deal's space stops a second tap from creating a second space. Past
// this age it is treated as abandoned (the run crashed) and can be taken again.
const CLAIM_MS = 3 * 60 * 1000;

const spaceId = (spaceName) => {
  const m = /^spaces\/([\w-]+)$/.exec(spaceName || '');
  if (!m) throw safeError('invalid space name');
  return m[1];
};
const dealDocId = (dealId) => {
  if (!/^\d+$/.test(String(dealId || ''))) throw safeError('invalid deal id');
  return String(dealId);
};

// `firestore` is a Firestore client (or a fake with the same calls, for tests).
function createDb({ firestore, now = () => new Date() }) {
  const deals = firestore.collection('deals');
  const spaces = firestore.collection('spaces');
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
  // "update" adds one, and a "reuse" (saved again for its space) changes neither.
  async function recordBrief({ dealId, dealNumber, store, contactId, noteId, signature, mode = 'full' }) {
    const ref = deals.doc(dealDocId(dealId));
    const history = {};
    if (mode === 'full') Object.assign(history, { briefUpdates: 0, briefFullAt: stamp() });
    if (mode === 'update') {
      const snap = await ref.get();
      history.briefUpdates = ((snap.exists && snap.data().briefUpdates) || 0) + 1;
    }
    await ref.set(
      { dealNumber: String(dealNumber), store, contactId: contactId ? String(contactId) : null, briefNoteId: String(noteId), briefSignature: signature, briefWrittenAt: stamp(), ...history, updatedAt: stamp() },
      { merge: true },
    );
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
    await deals.doc(dealDocId(dealId)).set({ deliveryId: String(deliveryId), deliveryCreatedByBasecamp: Boolean(created), deliveryLinkedAt: stamp(), updatedAt: stamp() }, { merge: true });
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
        { dealNumber: String(dealNumber), store, spaceName, spaceUri: spaceUri || null, spaceHow: how, spaceLinkedAt: stamp(), spaceLinkedBy: by, spaceClaim: null, updatedAt: stamp() },
        { merge: true },
      );
      tx.set(spaceRef, { spaceName, dealId: dealDocId(dealId), dealNumber: String(dealNumber), store, how, status: 'ready', linkedAt: stamp(), linkedBy: by, updatedAt: stamp() });
    });
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

  async function markAnswered({ id, answeredBy, answers }) {
    await firestore.collection('questions').doc(id).set({ status: 'answered', answeredBy, answeredAt: stamp(), answers }, { merge: true });
  }

  return { getDeal, getSpace, recordBrief, recordDelivery, claimSpace, releaseClaim, linkSpace, markSpaceGone, listDealSpaces, recordAccessRequest, recordSpaceNote, rememberPerson, getPerson, recordQuestion, findQuestionByReviewerThread, markAnswered, listDealQuestions, recordReuse, recordReuseVerdict, listWowIdeas, useWowIdea };
}

module.exports = { createDb, CLAIM_MS };
