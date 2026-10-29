'use strict';

// Minimal HubSpot API client. Read-only for now: GET, plus POST only to search and
// batch-read endpoints, which read data. Agents never edit HubSpot fields; when note
// writing arrives it gets its own narrow method, not a general POST.

const BASE = 'https://api.hubapi.com';
const READ_POST = /\/(search|batch\/read)$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHubSpotClient({ token, fetchImpl = fetch, wait = sleep }) {
  if (!token) throw new Error('createHubSpotClient: token is required');

  async function request(method, path, body) {
    if (method === 'POST' && !READ_POST.test(path)) {
      throw new Error(`HubSpot client refuses POST to ${path}: only search and batch read are allowed`);
    }
    const send = () =>
      fetchImpl(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    let res = await send();
    // HubSpot caps searches per second. One wait and retry covers a burst like App Home's.
    if (res.status === 429) {
      const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      await wait(after > 0 ? Math.min(after, 5) * 1000 : 1000);
      res = await send();
    }
    if (!res.ok) {
      // The status and path are enough to debug; response bodies can hold Roamer details.
      throw new Error(`HubSpot ${method} ${path.split('?')[0]} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
  };
}

module.exports = { createHubSpotClient };
