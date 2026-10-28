'use strict';

// HTTP entry point for Cloud Run.
// Environment:
//   CHAT_AUDIENCE   the endpoint URL configured in the Chat app (required)
//   ALLOWED_USERS   comma-separated emails allowed to use Basecamp (shadow mode: Blake only)
//   PORT            set by Cloud Run

const http = require('http');
const { createVerifier } = require('./chat/verify');
const { createRouter } = require('./router');

const MAX_BODY_BYTES = 1024 * 1024;

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

function start() {
  const audience = process.env.CHAT_AUDIENCE;
  if (!audience) {
    console.error('CHAT_AUDIENCE is not set; refusing to start without request verification');
    process.exit(1);
  }

  const handle = createRouter({
    verify: createVerifier({ audience }),
    allowedUsers: (process.env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
  });

  const server = http.createServer(async (req, res) => {
    // Not /healthz: Cloud Run reserves paths ending in "z" and never forwards them.
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
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
