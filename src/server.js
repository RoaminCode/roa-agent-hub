'use strict';

// HTTP entry point for Cloud Run.
// Environment:
//   CHAT_AUDIENCE   the endpoint URL configured in the Chat app (required)
//   ALLOWED_USERS   comma-separated emails allowed to use Basecamp (shadow mode: Blake only)
//   PROJECT_NUMBER  Google Cloud project number, to accept Workspace add-on signed requests
//   BRIEFS_PAUSED   "true" turns Roamer briefs off (Home stays on); remove it to turn them back on
//   BRIEF_USERS     comma-separated emails who may start a Roamer brief, the only thing that
//                   spends AI credits. Unset or empty means nobody. Each must also be in
//                   ALLOWED_USERS; everyone else allowed keeps Home without Brief buttons.
//   ALOWARE_API_TOKEN from Secret Manager (aloware-api-token), for approved texts (/text)
//   TEXTS_LIVE      "true" turns approved texts on, live to Roamers; anything else, off
//   TEXT_TEST_TO    a phone number: test mode, every approved text goes there instead (and
//                   only there) until it is removed
//   WOW_SHEET_ID    the "ROA WOW Ideas" Google Sheet /wow reads and updates (shared with
//                   basecamp-router as an editor); unset, the database library is used
//   SHADOW_REVIEWER the email that gets every routed question in shadow mode (Blake); unset,
//                   questions are not routed
//   HUBSPOT_ACCESS_TOKEN, ANTHROPIC_API_KEY
//                   from Secret Manager; without both, briefs are turned off
//   PORT            set by Cloud Run

const { safeError, errorFields } = require('./errors');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createVerifier } = require('./chat/verify');
const { createChatSender, createDirectMessageFinder, createMessageUpdater } = require('./chat/send');
const { renderHome } = require('./chat/homeCard');
const { createHubSpotClient } = require('./hubspot/client');
const { createDealContext } = require('./hubspot/dealContext');
const { createOpenDeals } = require('./hubspot/openDeals');
const { createBriefJob, createBriefSource, createNoteKeeper } = require('./briefJob');
const { createSpaceJob, createAccessRequests, createDealSpaceIndex } = require('./spaceJob');
const { createSpaces } = require('./chat/spaces');
const { createSpaceNotes } = require('./spaceNotes');
const { createBriefNoteSaver } = require('./hubspot/briefNotes');
const { createDb } = require('./db');
const { createQuestionRouter } = require('./askJob');
const { createQaNotes } = require('./hubspot/qaNotes');
const { createWow } = require('./wowJob');
const { createTexts } = require('./textJob');
const { createWhatsNew } = require('./newJob');
const { createReminders } = require('./remindJob');
const { createAloware } = require('./aloware');
const { createSheetLibrary, createDbLibrary } = require('./wowLibrary');
const { createDeliveries, withDeliveryRecord } = require('./hubspot/deliveries');
const { Firestore } = require('@google-cloud/firestore');
const { createRouter } = require('./router');

const MAX_BODY_BYTES = 1024 * 1024;

// Basecamp's avatar, served publicly so the Chat app configuration can point at it.
const AVATAR = fs.readFileSync(path.join(__dirname, '..', 'assets', 'avatar-256.png'));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(safeError('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// "a@x.com, b@x.com" to a list; unset or blank is an empty list.
function list(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function log(severity, message, fields = {}) {
  console.log(JSON.stringify({ severity, message, ...fields }));
}

// Briefs and App Home. Both need HubSpot; briefs also need Anthropic. Without the keys,
// each says it is not switched on rather than failing.
function features(audience) {
  const { HUBSPOT_ACCESS_TOKEN, ANTHROPIC_API_KEY } = process.env;
  const sendMessage = createChatSender();
  const findDirectMessage = createDirectMessageFinder();
  const hubspot = HUBSPOT_ACCESS_TOKEN ? createHubSpotClient({ token: HUBSPOT_ACCESS_TOKEN }) : null;

  // A brief started from App Home has no space on the event; send it to the user's DM.
  const spaceFor = async ({ spaceName, userName }) => spaceName || findDirectMessage(userName);

  const spaces = createSpaces();
  // Basecamp's own records (IDs, timestamps, statuses) in the project's Firestore database.
  const db = createDb({ firestore: new Firestore({ ignoreUndefinedProperties: true }) });
  // A deal found with an open space but no Delivery record gets one (deliveries.js).
  const ensureDelivery = hubspot ? createDeliveries({ hubspot, db, log }) : null;
  const findDealSpace = hubspot ? withDeliveryRecord(createDealContext({ hubspot, db }).findDealSpace, { ensureDelivery, log }) : null;
  // Not awaited, like briefs: these outlive the request and report back when done.
  const later = (what, run) => (job) => {
    run(job).catch((err) => log('ERROR', `${what} crashed`, { dealNumber: job.dealNumber, error: errorFields(err) }));
  };

  let startBrief;
  let startSpace;
  let useSpace;
  let askQuestion = async () => "Questions aren't switched on yet.";
  let relayAnswer = async () => null;
  let clarifyQuestion = async () => "Questions aren't switched on yet.";
  let reuseVerdict = async () => "Questions aren't switched on yet.";
  let answerCard = async () => "Questions aren't switched on yet.";
  let startWow = () => {};
  let startText = async () => "Texts aren't switched on yet.";
  let startNew = () => {};
  let reviewText = async () => null;
  let sendText = async () => "Texts aren't switched on yet.";
  let chooseWow = async () => "WOW plans aren't switched on yet.";
  let listWowIdeas = async () => "WOW plans aren't switched on yet.";
  let setReminder = async () => "Reminders aren't switched on yet.";
  let dueReminders = async () => 0;
  if (!hubspot || !ANTHROPIC_API_KEY) {
    log('WARNING', 'briefs are off: HUBSPOT_ACCESS_TOKEN or ANTHROPIC_API_KEY is not set');
    startBrief = (job) =>
      spaceFor(job)
        .then((space) => sendMessage(space, "Briefs aren't switched on yet."))
        .catch(() => {});
    startSpace = startBrief;
    useSpace = later('use space', (job) => sendMessage(job.spaceName, "Briefs aren't switched on yet."));
  } else {
    const loadContext = withDeliveryRecord(createDealContext({ hubspot, db }), { ensureDelivery, log });
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const saveBriefNote = createBriefNoteSaver({ hubspot, db });
    // Bump v when the avatar image changes.
    const avatarUrl = `${new URL(audience).origin}/avatar.png?v=2`;
    // One brief source for /brief and deal spaces, so one deal's brief is written once at a time.
    const getBrief = createBriefSource({ anthropic, log });
    const runBrief = createBriefJob({ loadContext, saveBriefNote, anthropic, sendMessage, log, avatarUrl, endpoint: audience, getBrief });
    const spaceJob = createSpaceJob({
      loadContext,
      getBrief,
      keepNote: createNoteKeeper({ saveBriefNote, log }),
      spaces,
      db,
      ensureDelivery,
      sendMessage,
      log,
      avatarUrl,
    });
    // A space asked for from Home reports back in the user's direct message.
    startSpace = later('open space', async (job) => spaceJob.openSpace({ ...job, spaceName: await spaceFor(job) }));
    useSpace = later('use space', spaceJob.useSpace);
    if (process.env.SHADOW_REVIEWER) {
      const questions = createQuestionRouter({ anthropic, db, sendMessage, findDirectMessage, reviewerEmail: process.env.SHADOW_REVIEWER, log, endpoint: audience, qaNotes: createQaNotes({ hubspot, lock: db.withLock }), findDealSpace, readBriefNote: loadContext.readBriefNote });
      askQuestion = questions.ask;
      relayAnswer = questions.relayAnswer;
      clarifyQuestion = questions.clarify;
      reuseVerdict = questions.reuseVerdict;
      answerCard = questions.fromCard;
    } else {
      log('WARNING', 'questions are off: SHADOW_REVIEWER is not set');
    }

    // "/remind": a person's own reminders, sent by Basecamp when Cloud Scheduler calls /tasks/tick.
    const reminders = createReminders({ anthropic, db, findDealSpace, findDirectMessage, sendMessage, log, endpoint: audience });
    setReminder = reminders.remind;
    dueReminders = reminders.due;
    // The WOW idea library: the team's sheet when WOW_SHEET_ID is set, else the database.
    const sheetId = process.env.WOW_SHEET_ID;
    const library = sheetId ? createSheetLibrary({ sheetId }) : createDbLibrary({ db });
    const sheetUrl = sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : null;
    const wowPlans = createWow({ anthropic, db, library, readBriefNote: loadContext.readBriefNote, findDealSpace, createNote: hubspot.createNote, log, endpoint: audience, sheetUrl });
    // The ideas are posted in the thread they were asked in, when ready.
    startWow = later('wow', async (job) => sendMessage(job.spaceName, await wowPlans.wow(job), { threadName: job.threadName }));
    chooseWow = wowPlans.choose;
    listWowIdeas = wowPlans.listIdeas;

    // "/new": what's new on a deal, posted in the thread it was asked in.
    const whatsNew = createWhatsNew({ anthropic, db, loadContext, findDealSpace, log });
    startNew = later('whats new', async (job) => sendMessage(job.spaceName, await whatsNew(job), { threadName: job.threadName }));

    // Approved texts, live to Roamers (Blake's call, 2026-11-07). Off unless TEXTS_LIVE=true.
    // TEXT_TEST_TO (test mode): every approved text goes to that one phone, and Aloware is
    // locked to it, until it is removed.
    const { ALOWARE_API_TOKEN, TEXTS_LIVE, TEXT_TEST_TO } = process.env;
    if (ALOWARE_API_TOKEN && TEXTS_LIVE === 'true') {
      const texts = createTexts({
        anthropic,
        db,
        hubspot,
        createNote: hubspot.createNote,
        findDealSpace,
        aloware: createAloware({ token: ALOWARE_API_TOKEN, allowedNumbers: TEXT_TEST_TO ? [TEXT_TEST_TO] : null }),
        testTo: TEXT_TEST_TO || null,
        updateMessage: createMessageUpdater(),
        line: { id: '67519', label: 'UT - Sales, (385) 378-8538' },
        log,
        endpoint: audience,
      });
      startText = texts.start;
      reviewText = texts.review;
      sendText = texts.send;
    } else {
      log('WARNING', 'texts are off: ALOWARE_API_TOKEN is not set or TEXTS_LIVE is not true');
    }
    startBrief = (job) => {
      spaceFor(job)
        .then((spaceName) => runBrief({ ...job, spaceName }))
        .catch((err) => log('ERROR', 'could not find where to send the brief', { dealNumber: job.dealNumber, error: errorFields(err) }));
    };
  }

  // Notes from deal spaces need HubSpot only, no AI.
  const saveSpaceNote = hubspot
    ? createSpaceNotes({ db, createNote: hubspot.createNote, findDealSpace, log })
    : async () => "Notes aren't switched on yet.";
  const requestAccess = later(
    'access request',
    hubspot ? createAccessRequests({ findDealSpace, spaces, db, sendMessage, findDirectMessage, log }) : async () => {},
  );
  const spacesFor = hubspot ? createDealSpaceIndex({ spaces, db }) : null;

  const listOpenDeals = hubspot ? createOpenDeals({ hubspot }) : null;
  // Loading deals takes about 4 seconds; a Brief tap redraws Home and should answer at
  // once, so a list loaded in the last 90 seconds is reused.
  const DEALS_FRESH_MS = 90 * 1000;
  let dealsCache = null;
  async function openDeals() {
    if (dealsCache && Date.now() - dealsCache.at < DEALS_FRESH_MS) return dealsCache.deals;
    const deals = await listOpenDeals({ store: 'UT' });
    dealsCache = { at: Date.now(), deals };
    return deals;
  }
  // Deal spaces are extra: if they cannot be read, Home still shows the deals, without space buttons.
  async function dealSpacesFor(userName) {
    if (!spacesFor || !userName) return null;
    try {
      return await spacesFor(userName);
    } catch (err) {
      log('WARNING', 'deal spaces unavailable for home', { error: errorFields(err) });
      return null;
    }
  }
  async function buildHome({ userName, sent, briefsOff = null } = {}) {
    if (!listOpenDeals) return { sections: [{ widgets: [{ textParagraph: { text: "Home isn't switched on yet." } }] }] };
    try {
      const [deals, spaces] = await Promise.all([openDeals(), dealSpacesFor(userName)]);
      // Shadow mode: everyone allowed sees every open Utah deal.
      return renderHome({ deals, endpoint: audience, shadow: true, sent, briefsOff, spaces });
    } catch (err) {
      log('ERROR', 'home failed', { error: errorFields(err) });
      return { sections: [{ widgets: [{ textParagraph: { text: "I couldn't load deals from HubSpot just now. Close and reopen Home to try again." } }] }] };
    }
  }

  // Each person's Chat id, recorded once per instance, so Basecamp can reach their direct
  // message (the shadow reviewer's, for routed questions).
  const known = new Set();
  function seenPerson({ email, userName }) {
    const key = `${email}|${userName}`;
    if (known.has(key)) return;
    known.add(key);
    db.rememberPerson({ email, userName }).catch((err) => {
      known.delete(key);
      log('WARNING', 'could not record person', { error: errorFields(err) });
    });
  }

  // A line posted in a thread after a dialog closes (a dialog's reply can't carry one).
  function postNotice({ spaceName, threadName, text }) {
    if (!spaceName || !text) return;
    sendMessage(spaceName, text, { threadName: threadName || null }).catch((err) => log('ERROR', 'could not post notice', { error: errorFields(err) }));
  }

  return { startBrief, startSpace, useSpace, requestAccess, askQuestion, relayAnswer, clarifyQuestion, reuseVerdict, answerCard, startNew, startText, reviewText, sendText, postNotice, startWow, chooseWow, listWowIdeas, setReminder, dueReminders, seenPerson, saveSpaceNote, buildHome };
}

function start() {
  const audience = process.env.CHAT_AUDIENCE;
  if (!audience) {
    console.error('CHAT_AUDIENCE is not set; refusing to start without request verification');
    process.exit(1);
  }

  const briefsPaused = process.env.BRIEFS_PAUSED === 'true';
  if (briefsPaused) console.log(JSON.stringify({ severity: 'INFO', message: 'briefs are paused (BRIEFS_PAUSED)' }));

  // Fails closed: an unset BRIEF_USERS is an empty list, so nobody spends credits.
  const briefUsers = list(process.env.BRIEF_USERS);
  console.log(JSON.stringify({ severity: 'INFO', message: 'brief users', count: briefUsers.length }));

  const featureSet = features(audience);
  const handle = createRouter({
    ...featureSet,
    briefsPaused,
    briefUsers,
    verify: createVerifier({
      audience,
      projectNumber: process.env.PROJECT_NUMBER,
      onReject: (details) =>
        console.log(JSON.stringify({ severity: 'WARNING', message: 'chat verification failed', ...details })),
    }),
    allowedUsers: list(process.env.ALLOWED_USERS),
  });

  // Cloud Scheduler calls POST /tasks/tick every few minutes, signed as Basecamp's own
  // service account with this path as the audience, so nothing else can trigger sends.
  const verifyTick = createVerifier({
    audience: `${audience.replace(/\/+$/, '')}/tasks/tick`,
    signers: [process.env.TICK_SIGNER || 'basecamp-router@roa-agent-hub.iam.gserviceaccount.com'],
    onReject: (details) => console.log(JSON.stringify({ severity: 'WARNING', message: 'tick verification failed', ...details })),
  });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url.split('?')[0] === '/tasks/tick') {
      if (!(await verifyTick(req.headers.authorization))) return send(res, 401, { error: 'unauthorized' });
      try {
        return send(res, 200, { reminders: await featureSet.dueReminders() });
      } catch (err) {
        console.error(JSON.stringify({ severity: 'ERROR', message: 'tick failed', error: errorFields(err) }));
        return send(res, 500, { error: 'tick failed' });
      }
    }
    // Not /healthz: Cloud Run reserves paths ending in "z" and never forwards them.
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    // A ?v= query is allowed so a new avatar can get past Chat's image cache.
    if (req.method === 'GET' && req.url.split('?')[0] === '/avatar.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return res.end(AVATAR);
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    try {
      const body = JSON.parse(await readBody(req));
      const result = await handle({ headers: req.headers, body });
      send(res, result.status, result.body);
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', message: 'request failed', error: errorFields(err) }));
      send(res, 400, { error: 'bad request' });
    }
  });

  const port = Number(process.env.PORT) || 8080;
  server.listen(port, () => console.log(JSON.stringify({ severity: 'INFO', message: `Basecamp listening on ${port}` })));
}

if (require.main === module) start();

module.exports = { start, list };
