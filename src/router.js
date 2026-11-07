'use strict';

// Basecamp's router. It verifies the request came from Google Chat, checks the sender is
// allowed, and routes the event. Commands: "brief <deal#> [store]", which answers right
// away and posts the Roamer brief when it is ready; "open a space for <deal#>", which
// opens the deal's Chat space with the brief as its first post; "use this space for
// <deal#>", said in a space a person made, which makes it the deal's space; and "note
// <text>" in a deal space, which saves the text as a HubSpot note on the deal. App Home
// shows open deals, each with a Brief button and its deal space: a link, a button to
// create it, or a button to ask the space to add you.

const { errorFields } = require('./errors');
const { parseEvent, replyFor, updateMessageFor, homeFor, homeUpdateFor, dialogFor, closeDialog, shapeOf } = require('./chat/events');
const { renderNotAllowedHome } = require('./chat/homeCard');

const MESSAGES = {
  added: "Basecamp is here. I'm in shadow mode. Try \"brief 51431\" for a Roamer brief on a Utah deal.",
  help: "Try \"brief 51431\" for a Roamer brief on a Utah deal, or \"open a space for 51431\" for its deal space. In a deal space, \"/note <text>\" saves a note to the deal's Delivery record in HubSpot.",
  opening: (n) => `Opening a space for deal ${n}. I'll post the link here when it's ready.`,
  spaceDirectOnly: (n) => `Ask me to open the space for deal ${n} in a direct message with me.`,
  adopting: (n) => `Setting this space up for deal ${n}. The brief will be here shortly.`,
  wowWorking: 'Coming up with WOW ideas from the brief. They will be here in a moment.',
  useInSpace: (n) => `Say "use this space for ${n}" in the deal's space, after adding me to it.`,
  notAllowed: "Basecamp isn't available to you yet.",
  working: (n, roamer) => `I'll need just a moment to read up on ${roamer ? `${roamer} (deal ${n})` : `deal ${n}`}.`,
  paused: "Roamer briefs are paused for now while Basecamp's AI funding is sorted out. Home still shows every deal, delivery, and last contact.",
  notBriefUser: "Roamer briefs are off for you for now, to save Basecamp's AI credits for a test. Home still shows every deal, delivery, and last contact.",
  directOnly: (n) => `Roamer briefs stay private for now: ask me for deal ${n} in a direct message with me.`,
  unknownStore: (s) => `I only know the Utah Experience Center (UT) so far, not ${s}.`,
};

const STORES = new Set(['UT']);

// App commands, by the id each has in the Chat app configuration (Chat API > Configuration
// > Commands). 1, 2, 3, and 5 are slash commands (/note, /ask, /wow, /text); 4 is the "Save
// to HubSpot" message action, chosen from any message's menu, which saves that whole
// message; 6 is the "WOW ideas" quick command in the + menu, the same as /wow with nothing
// typed (a quick command carries no text). A command registered ahead of its build would
// say so here (none now).
const SLASH_COMMANDS = { 1: 'note', 2: 'ask', 3: 'wow', 4: 'saveMessage', 5: 'text', 6: 'wowQuick' };
const NOT_BUILT = {};

// "brief 51431" or "brief 51431 UT"; "open a space for 51431" (also "open space 51431").
// "use this space for 51431"; "note <text>" (also "note: <text>"), whose text keeps its
// line breaks; "ask <question>". Deal numbers are digits only.
function parseCommand(text) {
  const t = text || '';
  const note = /^note\b:?\s*([\s\S]*)$/i.exec(t);
  if (note) return { command: 'note', text: note[1].trim() };
  const textCmd = /^text\b:?\s*([\s\S]*)$/i.exec(t);
  if (textCmd) return { command: 'text', text: textCmd[1].trim() };
  const wow = /^wow\b:?\s*([\s\S]*)$/i.exec(t);
  if (wow) return { command: 'wow', text: wow[1].trim() };
  const ask = /^ask\b:?\s*([\s\S]*)$/i.exec(t);
  if (ask) return { command: 'ask', text: ask[1].trim() };
  let m = /^brief\s+#?(\d{3,8})(?:\s+([A-Za-z]{2}))?\s*$/i.exec(t);
  if (m) return { command: 'brief', dealNumber: m[1], store: (m[2] || 'UT').toUpperCase() };
  m = /^open\s+(?:a\s+)?(?:deal\s+)?space\s+(?:for\s+)?(?:deal\s+)?#?(\d{3,8})(?:\s+([A-Za-z]{2}))?\s*$/i.exec(t);
  if (m) return { command: 'space', dealNumber: m[1], store: (m[2] || 'UT').toUpperCase() };
  m = /^use\s+this\s+(?:deal\s+)?space\s+(?:for\s+)?(?:deal\s+)?#?(\d{3,8})(?:\s+([A-Za-z]{2}))?\s*$/i.exec(t);
  if (m) return { command: 'use', dealNumber: m[1], store: (m[2] || 'UT').toUpperCase() };
  return null;
}

function log(severity, message, fields = {}) {
  // One JSON line per entry so Cloud Logging picks up severity and fields.
  console.log(JSON.stringify({ severity, message, ...fields }));
}

// buildHome({ userEmail, sent }) returns the App Home card; `sent` is the set of deal
// numbers whose brief this user started recently. See chat/homeCard.js.
// buildHome also gets `briefsOff`: null, or why this user's briefs are off ('paused' or
// 'notBriefUser'), so Home leaves off the Brief buttons and says why.
// `briefsPaused` turns briefs off for everyone without a deploy (BRIEFS_PAUSED in server.js).
// `briefUsers` lists who may start a brief, the only thing that spends AI credits. Anyone
// else allowed keeps Home but gets a short answer instead of a brief. Left out, every
// allowed user may brief (tests only); server.js always passes it, so an empty BRIEF_USERS
// means nobody.
// saveSpaceNote({ spaceName, spaceDisplayName, userEmail, userDisplayName, text }) saves a
// note from a deal space and returns the reply; see spaceNotes.js. It spends no AI credits,
// so it needs only ALLOWED_USERS, and works while briefs are paused.
// useSpace starts "use this space"; requestAccess({ dealNumber, userName, userEmail,
// userDisplayName }) asks a deal's space to add someone, from Home. Both outlive the request.
// askQuestion({ spaceName, isDirectMessage, userEmail, userDisplayName, text }) routes a
// question and returns the reply; it spends AI credits, so it needs the brief permission.
// clarifyQuestion({ spaceName, threadName, isDirectMessage, userEmail, userDisplayName,
// question, detail, attempt }) takes Send on a clarify card and returns what replaces it.
// relayAnswer({ threadName, userEmail, userDisplayName, text }) takes a direct message
// reply; when it answers a routed question it returns the reply, else null.
// seenPerson({ email, userName }) is told who sent each allowed event, so Basecamp can
// later reach that person's direct message.
function createRouter({ verify, allowedUsers, briefUsers, startBrief = () => {}, startSpace = () => {}, useSpace = () => {}, requestAccess = () => {}, askQuestion = async () => "Questions aren't switched on yet.", relayAnswer = async () => null, clarifyQuestion = async () => "Questions aren't switched on yet.", reuseVerdict = async () => "Questions aren't switched on yet.", startText = async () => "Texts aren't switched on yet.", reviewText = async () => null, sendText = async () => "Texts aren't switched on yet.", postNotice = () => {}, startWow = () => {}, chooseWow = async () => "WOW plans aren't switched on yet.", listWowIdeas = async () => "WOW plans aren't switched on yet.", seenPerson = () => {}, saveSpaceNote = async () => "Notes aren't switched on yet.", buildHome = async () => renderNotAllowedHome(), now = Date.now, briefsPaused = false }) {
  const allowed = new Set((allowedUsers || []).map((u) => u.toLowerCase()));
  const mayBrief = briefUsers ? new Set(briefUsers.map((u) => u.toLowerCase())) : null;
  function briefsOffFor(userEmail) {
    if (briefsPaused) return 'paused';
    if (mayBrief && !mayBrief.has(userEmail)) return 'notBriefUser';
    return null;
  }
  function logRefused(off, userEmail) {
    if (off === 'notBriefUser') log('INFO', 'brief not started: user is not in BRIEF_USERS', { user: userEmail });
  }

  // A brief takes about a minute and Home gives no progress bar, so a second tap on the
  // same deal is common. Within this window it starts no second brief. A typed "brief" is
  // not checked: it gets a visible reply, and may be a deliberate retry or another space.
  // The memory is per instance; with two instances a repeat tap can slip through.
  const REPEAT_MS = 2 * 60 * 1000;
  const recentBriefs = new Map();
  function isRepeat(userEmail, dealNumber) {
    const key = `${userEmail}|${dealNumber}`;
    const last = recentBriefs.get(key);
    for (const [k, t] of recentBriefs) if (now() - t > REPEAT_MS) recentBriefs.delete(k);
    if (last && now() - last <= REPEAT_MS) return true;
    recentBriefs.set(key, now());
    return false;
  }
  // Deals whose brief this user started within the window, so Home can mark them sent.
  function sentDeals(userEmail) {
    const sent = new Set();
    for (const [k, t] of recentBriefs) {
      const [user, deal] = k.split('|');
      if (user === userEmail && now() - t <= REPEAT_MS) sent.add(deal);
    }
    return sent;
  }

  return async function handle({ headers, body }) {
    if (!(await verify(headers.authorization))) {
      log('WARNING', 'rejected request that did not come from Google Chat');
      return { status: 401, body: { error: 'unauthorized' } };
    }

    let event;
    try {
      event = parseEvent(body);
    } catch (err) {
      log('ERROR', 'could not parse Chat event', { error: errorFields(err) });
      return { status: 400, body: { error: 'bad event' } };
    }

    // Message text is not logged: it can hold Roamer details.
    log('INFO', 'chat event', {
      format: event.format,
      type: event.type,
      space: event.spaceName,
      user: event.userEmail,
      messageName: event.messageName,
      textLength: event.text ? event.text.length : 0,
    });

    if (event.type === 'REMOVED_FROM_SPACE') return { status: 200, body: {} };

    // Home and card clicks are new to this router; log their shape (keys only) so the
    // real event format can be checked against what we expect.
    if (event.type === 'APP_HOME' || event.type === 'CARD_CLICKED' || event.commandId) {
      log('INFO', 'chat event shape', { type: event.type, shape: shapeOf(body) });
    }

    const isAllowed = Boolean(event.userEmail && allowed.has(event.userEmail));

    if (event.type === 'APP_HOME') {
      const card = isAllowed
        ? await buildHome({ userEmail: event.userEmail, userName: event.userName, sent: sentDeals(event.userEmail), briefsOff: briefsOffFor(event.userEmail) })
        : renderNotAllowedHome();
      return { status: 200, body: homeFor(card) };
    }

    if (!isAllowed) {
      return { status: 200, body: replyFor(event, MESSAGES.notAllowed) };
    }
    if (event.userName) seenPerson({ email: event.userEmail, userName: event.userName });

    // Home's deal space buttons. "Create space" can write a brief, so it needs the brief
    // permission; "Request access" spends nothing. Each redraws Home with the tapped
    // button turned into a disabled one saying where the answer went.
    if (event.type === 'CARD_CLICKED' && (event.parameters.action === 'space' || event.parameters.action === 'join')) {
      const dealNumber = String(event.parameters.dealNumber || '');
      if (!/^\d{3,8}$/.test(dealNumber)) return { status: 200, body: {} };
      const off = briefsOffFor(event.userEmail);
      if (event.parameters.action === 'space') {
        if (off) {
          logRefused(off, event.userEmail);
          return { status: 200, body: homeUpdateFor(await buildHome({ userEmail: event.userEmail, userName: event.userName, sent: sentDeals(event.userEmail), briefsOff: off })) };
        }
        if (!isRepeat(event.userEmail, `space:${dealNumber}`)) {
          startSpace({ spaceName: event.isDirectMessage ? event.spaceName : null, userName: event.userName, dealNumber, store: 'UT', userEmail: event.userEmail });
        }
      } else if (!isRepeat(event.userEmail, `join:${dealNumber}`)) {
        requestAccess({ dealNumber, userName: event.userName, userEmail: event.userEmail, userDisplayName: event.userDisplayName });
      }
      const card = await buildHome({ userEmail: event.userEmail, userName: event.userName, sent: sentDeals(event.userEmail), briefsOff: off });
      return { status: 200, body: homeUpdateFor(card) };
    }

    // Send on a clarify card: the question so far plus the typed detail, routed again (one
    // short AI call, so it needs the brief permission). The card is replaced by the result.
    if (event.type === 'CARD_CLICKED' && event.parameters.action === 'clarify') {
      const off = briefsOffFor(event.userEmail);
      if (off) {
        logRefused(off, event.userEmail);
        return { status: 200, body: updateMessageFor(event, MESSAGES[off]) };
      }
      const said = await clarifyQuestion({
        spaceName: event.spaceName,
        threadName: event.threadName,
        isDirectMessage: event.isDirectMessage,
        userEmail: event.userEmail,
        userDisplayName: event.userDisplayName,
        question: String(event.parameters.q || ''),
        detail: event.formInputs.detail,
        attempt: event.parameters.attempt,
      });
      return { status: 200, body: updateMessageFor(event, said) };
    }

    // Texts: "Review and send" opens the approval dialog; "Approve and send" sends the exact
    // words in it; Cancel closes it. Only people who may brief can approve a text.
    if (event.type === 'CARD_CLICKED' && ['textReview', 'textSend', 'textCancel'].includes(event.parameters.action)) {
      const action = event.parameters.action;
      if (action === 'textCancel') return { status: 200, body: closeDialog() };
      const off = briefsOffFor(event.userEmail);
      if (off) {
        logRefused(off, event.userEmail);
        postNotice({ spaceName: event.spaceName, threadName: event.threadName, text: MESSAGES[off] });
        return { status: 200, body: closeDialog() };
      }
      if (action === 'textReview') {
        const dialog = await reviewText({ params: event.parameters, userEmail: event.userEmail });
        return { status: 200, body: dialog ? dialogFor(dialog) : closeDialog() };
      }
      const said = await sendText({ params: event.parameters, formInputs: event.formInputs, userEmail: event.userEmail, userDisplayName: event.userDisplayName });
      postNotice({ spaceName: event.spaceName, threadName: event.threadName, text: said });
      return { status: 200, body: closeDialog() };
    }

    // "Use this one" on a WOW idea: saved to the Delivery record, remembered in the library. No AI.
    if (event.type === 'CARD_CLICKED' && event.parameters.action === 'wowPick') {
      const said = await chooseWow({ params: event.parameters, userEmail: event.userEmail, userDisplayName: event.userDisplayName });
      return { status: 200, body: updateMessageFor(event, said) };
    }

    // Right or Wrong on what Basecamp would have answered from an earlier answer. No AI.
    if (event.type === 'CARD_CLICKED' && event.parameters.action === 'reuseVerdict') {
      const said = await reuseVerdict({ id: String(event.parameters.id || ''), verdict: String(event.parameters.verdict || ''), userEmail: event.userEmail });
      return { status: 200, body: updateMessageFor(event, said) };
    }

    if (event.type === 'CARD_CLICKED' && event.parameters.action === 'brief') {
      // A button drawn before briefs went off (an old Home or contact picker) starts nothing.
      const off = briefsOffFor(event.userEmail);
      if (off) {
        logRefused(off, event.userEmail);
        if (event.parameters.from === 'picker') return { status: 200, body: updateMessageFor(event, MESSAGES[off]) };
        return { status: 200, body: homeUpdateFor(await buildHome({ userEmail: event.userEmail, userName: event.userName, sent: new Set(), briefsOff: off })) };
      }
      const dealNumber = String(event.parameters.dealNumber || '');
      if (!/^\d{3,8}$/.test(dealNumber)) return { status: 200, body: {} };

      // A tap on the contact picker: that contact is the Roamer. It always starts the brief
      // (it is the answer to a question Basecamp asked), and the picker is replaced by the
      // usual "reading up" line so it cannot be tapped twice.
      if (event.parameters.from === 'picker') {
        const contactId = String(event.parameters.contactId || '');
        const store = String(event.parameters.store || 'UT');
        if (!/^\d{1,20}$/.test(contactId) || !STORES.has(store) || !event.isDirectMessage) return { status: 200, body: {} };
        isRepeat(event.userEmail, dealNumber);
        startBrief({ spaceName: event.spaceName, userName: event.userName, dealNumber, store, contactId, userEmail: event.userEmail });
        return { status: 200, body: updateMessageFor(event, MESSAGES.working(dealNumber, event.parameters.roamer)) };
      }

      if (!isRepeat(event.userEmail, dealNumber)) {
        // The brief job first posts a line in the user's Basecamp messages, the same words
        // a typed "brief" command gets back, for anyone viewing Home and Messages side by side.
        startBrief({
          // Home has no space of its own; the brief goes to the user's direct message.
          spaceName: event.isDirectMessage ? event.spaceName : null,
          userName: event.userName,
          dealNumber,
          store: 'UT',
          userEmail: event.userEmail,
          announce: MESSAGES.working(dealNumber, event.parameters.roamer),
        });
      }
      // On a phone or full screen Messages is out of sight, so Home itself changes: the
      // tapped deal's button now reads "In Messages" and cannot be tapped again.
      const card = await buildHome({ userEmail: event.userEmail, userName: event.userName, sent: sentDeals(event.userEmail), briefsOff: null });
      return { status: 200, body: homeUpdateFor(card) };
    }

    if (event.type === 'ADDED_TO_SPACE') {
      return { status: 200, body: replyFor(event, MESSAGES.added) };
    }

    if (event.type === 'MESSAGE') {
      // A reply in a direct message, in the thread of a routed question, is its answer.
      if (event.isDirectMessage && !event.commandId) {
        const relayed = await relayAnswer({ threadName: event.threadName, userEmail: event.userEmail, userDisplayName: event.userDisplayName, text: event.text });
        if (relayed) return { status: 200, body: replyFor(event, relayed) };
      }
      const slash = event.commandId ? SLASH_COMMANDS[event.commandId] : null;
      if (event.commandId && !slash) return { status: 200, body: replyFor(event, MESSAGES.help) };
      if (NOT_BUILT[slash]) return { status: 200, body: replyFor(event, NOT_BUILT[slash]) };
      // "/note <text>" arrives with only the text; it is the same as "note <text>". "Save to
      // HubSpot" on a message saves the whole message, credited to whoever wrote it.
      let cmd;
      if (slash === 'note' || slash === 'ask' || slash === 'wow' || slash === 'text') cmd = { command: slash, text: event.text };
      else if (slash === 'saveMessage') cmd = { command: 'note', text: event.fullText, writtenBy: event.senderDisplayName };
      else if (slash === 'wowQuick') cmd = { command: 'wow', text: '' };
      else cmd = parseCommand(event.text);
      if (!cmd) return { status: 200, body: replyFor(event, MESSAGES.help) };
      if (cmd.command === 'note') {
        // In a direct message the note names its deal ("note 51455 <text>"); see spaceNotes.js.
        // Answered in the request (a few HubSpot reads and one write), so the reply lands in the note's thread.
        const said = await saveSpaceNote({
          spaceName: event.spaceName,
          spaceDisplayName: event.spaceDisplayName,
          isDirectMessage: event.isDirectMessage,
          userEmail: event.userEmail,
          userDisplayName: event.userDisplayName,
          text: cmd.text,
          ...(cmd.writtenBy !== undefined ? { writtenBy: cmd.writtenBy } : {}),
        });
        return { status: 200, body: replyFor(event, said) };
      }
      // The WOW idea library is a list, no AI; anyone allowed may see it.
      if (cmd.command === 'wow' && /^ideas?$/i.test(cmd.text)) return { status: 200, body: replyFor(event, await listWowIdeas()) };
      const off = briefsOffFor(event.userEmail);
      if (off) {
        logRefused(off, event.userEmail);
        return { status: 200, body: replyFor(event, MESSAGES[off]) };
      }
      if (cmd.command === 'text') {
        // A draft for review (one short AI call); nothing is sent until someone approves it.
        const said = await startText({ spaceName: event.spaceName, isDirectMessage: event.isDirectMessage, userEmail: event.userEmail, text: cmd.text });
        return { status: 200, body: replyFor(event, said) };
      }
      if (cmd.command === 'wow') {
        // Not awaited: ideas take a larger AI call and are posted in this thread when ready.
        startWow({ spaceName: event.spaceName, threadName: event.threadName, isDirectMessage: event.isDirectMessage, userEmail: event.userEmail, text: cmd.text });
        return { status: 200, body: replyFor(event, MESSAGES.wowWorking) };
      }
      if (cmd.command === 'ask') {
        // Answered in the request (one short AI call), so the reply lands in the question's thread.
        const said = await askQuestion({ spaceName: event.spaceName, threadName: event.threadName, isDirectMessage: event.isDirectMessage, userEmail: event.userEmail, userDisplayName: event.userDisplayName, text: cmd.text });
        return { status: 200, body: replyFor(event, said) };
      }
      if (!STORES.has(cmd.store)) return { status: 200, body: replyFor(event, MESSAGES.unknownStore(cmd.store)) };
      if (cmd.command === 'use') {
        // Said in the space itself, which the brief is posted to; it can write a brief, so
        // it needs the brief permission (checked above).
        if (event.isDirectMessage) return { status: 200, body: replyFor(event, MESSAGES.useInSpace(cmd.dealNumber)) };
        useSpace({ spaceName: event.spaceName, spaceDisplayName: event.spaceDisplayName, dealNumber: cmd.dealNumber, store: cmd.store, userEmail: event.userEmail });
        return { status: 200, body: replyFor(event, MESSAGES.adopting(cmd.dealNumber)) };
      }
      if (cmd.command === 'space') {
        // Asked for in a direct message, where the reply (with the Roamer's name) is private.
        // Opening a space can write a brief, so it needs the same brief permission.
        if (!event.isDirectMessage) return { status: 200, body: replyFor(event, MESSAGES.spaceDirectOnly(cmd.dealNumber)) };
        startSpace({ spaceName: event.spaceName, userName: event.userName, dealNumber: cmd.dealNumber, store: cmd.store, userEmail: event.userEmail });
        return { status: 200, body: replyFor(event, MESSAGES.opening(cmd.dealNumber)) };
      }
      // A brief holds a Roamer's personal details, so it is posted only where the reader
      // should see them: a direct message with Basecamp. When deal spaces exist, a deal's
      // space will also get briefs for that deal, and only that deal.
      if (!event.isDirectMessage) return { status: 200, body: replyFor(event, MESSAGES.directOnly(cmd.dealNumber)) };
      // Not awaited: the brief outlives this request and posts itself when done.
      startBrief({ spaceName: event.spaceName, dealNumber: cmd.dealNumber, store: cmd.store, userEmail: event.userEmail });
      return { status: 200, body: replyFor(event, MESSAGES.working(cmd.dealNumber)) };
    }

    return { status: 200, body: {} };
  };
}

module.exports = { createRouter, parseCommand, MESSAGES, NOT_BUILT };
