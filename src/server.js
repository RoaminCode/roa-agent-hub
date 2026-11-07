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
const { createChatSender, createDirectMessageFinder } = require('./chat/send');
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
const { createDeliveries } = require('./hubspot/deliveries');
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
  const findDealSpace = hubspot ? createDealContext({ hubspot, db }).findDealSpace : null;
  // Not awaited, like briefs: these outlive the request and report back when done.
  const later = (what, run) => (job) => {
    run(job).catch((err) => log('ERROR', `${what} crashed`, { dealNumber: job.dealNumber, error: errorFields(err) }));
  };

  let startBrief;
  let startSpace;
  let useSpace;
  let askQuestion = async () => "Questions aren't switched on yet.";
  let relayAnswer = async () => null;
  if (!hubspot || !ANTHROPIC_API_KEY) {
    log('WARNING', 'briefs are off: HUBSPOT_ACCESS_TOKEN or ANTHROPIC_API_KEY is not set');
    startBrief = (job) =>
      spaceFor(job)
        .then((space) => sendMessage(space, "Briefs aren't switched on yet."))
        .catch(() => {});
    startSpace = startBrief;
    useSpace = later('use space', (job) => sendMessage(job.spaceName, "Briefs aren't switched on yet."));
  } else {
    const loadContext = createDealContext({ hubspot, db });
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const saveBriefNote = createBriefNoteSaver({ hubspot, db });
    // Bump v when the avatar image changes.
    const avatarUrl = `${new URL(audience).origin}/avatar.png?v=2`;
    const runBrief = createBriefJob({ loadContext, saveBriefNote, anthropic, sendMessage, log, avatarUrl, endpoint: audience });
    const spaceJob = createSpaceJob({
      loadContext,
      getBrief: createBriefSource({ anthropic, log }),
      keepNote: createNoteKeeper({ saveBriefNote, log }),
      spaces,
      db,
      ensureDelivery: createDeliveries({ hubspot, db, log }),
      sendMessage,
      log,
      avatarUrl,
    });
    // A space asked for from Home reports back in the user's direct message.
    startSpace = later('open space', async (job) => spaceJob.openSpace({ ...job, spaceName: await spaceFor(job) }));
    useSpace = later('use space', spaceJob.useSpace);
    if (process.env.SHADOW_REVIEWER) {
      const questions = createQuestionRouter({ anthropic, db, sendMessage, findDirectMessage, reviewerEmail: process.env.SHADOW_REVIEWER, log, qaNotes: createQaNotes({ hubspot }) });
      askQuestion = questions.ask;
      relayAnswer = questions.relayAnswer;
    } else {
      log('WARNING', 'questions are off: SHADOW_REVIEWER is not set');
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

  return { startBrief, startSpace, useSpace, requestAccess, askQuestion, relayAnswer, seenPerson, saveSpaceNote, buildHome };
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

  const handle = createRouter({
    ...features(audience),
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

  const server = http.createServer(async (req, res) => {
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
