'use strict';

// HTTP entry point for Cloud Run.
// Environment:
//   CHAT_AUDIENCE   the endpoint URL configured in the Chat app (required)
//   ALLOWED_USERS   comma-separated emails allowed to use Basecamp (shadow mode: Blake only)
//   PROJECT_NUMBER  Google Cloud project number, to accept Workspace add-on signed requests
//   HUBSPOT_ACCESS_TOKEN, ANTHROPIC_API_KEY
//                   from Secret Manager; without both, briefs are turned off
//   PORT            set by Cloud Run

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
const { createBriefJob } = require('./briefJob');
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
        reject(new Error('body too large'));
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

  let startBrief;
  if (!hubspot || !ANTHROPIC_API_KEY) {
    log('WARNING', 'briefs are off: HUBSPOT_ACCESS_TOKEN or ANTHROPIC_API_KEY is not set');
    startBrief = (job) =>
      spaceFor(job)
        .then((space) => sendMessage(space, "Briefs aren't switched on yet."))
        .catch(() => {});
  } else {
    const runBrief = createBriefJob({
      loadContext: createDealContext({ hubspot }),
      anthropic: new Anthropic({ apiKey: ANTHROPIC_API_KEY }),
      sendMessage,
      log,
      // Bump v when the avatar image changes.
      avatarUrl: `${new URL(audience).origin}/avatar.png?v=2`,
    });
    startBrief = (job) => {
      spaceFor(job)
        .then((spaceName) => runBrief({ ...job, spaceName }))
        .catch((err) => log('ERROR', 'could not find where to send the brief', { dealNumber: job.dealNumber, error: err.message }));
    };
  }

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
  async function buildHome({ sent } = {}) {
    if (!listOpenDeals) return { sections: [{ widgets: [{ textParagraph: { text: "Home isn't switched on yet." } }] }] };
    try {
      // Shadow mode: everyone allowed sees every open Utah deal.
      return renderHome({ deals: await openDeals(), endpoint: audience, shadow: true, sent });
    } catch (err) {
      log('ERROR', 'home failed', { error: err.message });
      return { sections: [{ widgets: [{ textParagraph: { text: "I couldn't load deals from HubSpot just now. Close and reopen Home to try again." } }] }] };
    }
  }

  return { startBrief, buildHome };
}

function start() {
  const audience = process.env.CHAT_AUDIENCE;
  if (!audience) {
    console.error('CHAT_AUDIENCE is not set; refusing to start without request verification');
    process.exit(1);
  }

  const handle = createRouter({
    ...features(audience),
    verify: createVerifier({
      audience,
      projectNumber: process.env.PROJECT_NUMBER,
      onReject: (details) =>
        console.log(JSON.stringify({ severity: 'WARNING', message: 'chat verification failed', ...details })),
    }),
    allowedUsers: (process.env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
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
      console.error(JSON.stringify({ severity: 'ERROR', message: 'request failed', error: err.message }));
      send(res, 400, { error: 'bad request' });
    }
  });

  const port = Number(process.env.PORT) || 8080;
  server.listen(port, () => console.log(JSON.stringify({ severity: 'INFO', message: `Basecamp listening on ${port}` })));
}

if (require.main === module) start();

module.exports = { start };
