'use strict';

// The hub's one way to LightSpeed: the integration project's read-only lookup function,
// `rjbDealLookup` (Google Cloud project hs-ls-integration). The hub holds no LightSpeed
// credential. It calls the function as its own service account, basecamp-router, with a
// Google-signed identity token, and that function lets nobody else in. It answers for one
// store and one deal number with only the fields the hub may see (deal facts, the unit,
// labor lines, a short parts list; no Roamer contact details, no finance terms, no dealer
// cost). LightSpeed is the source of truth for deal facts and is never changed from here.

const { GoogleAuth } = require('google-auth-library');
const { safeError } = require('../errors');

// The hub's store codes as LightSpeed's function names them.
const STORE_CODES = { UT: 'ROA1', SC: 'ROA2', AZ: 'ROA3', CO: 'ROA4' };

// The function aims to answer within 10 seconds; past this the hub gives up.
const TIMEOUT_MS = 20 * 1000;

// `url` is the function's address (RJB_LOOKUP_URL), which is also the audience its token is
// made for. `auth` is a GoogleAuth (on Cloud Run the token comes from the metadata server).
function createDealLookup({ url, auth = new GoogleAuth(), timeoutMs = TIMEOUT_MS }) {
  if (!/^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(url || '')) throw safeError('the LightSpeed lookup URL looks wrong');
  let client = null;

  // { ok: true, found: [{ store, feed, deal }] } (empty when the store has no such deal; an
  // open deal comes before a closed one), or { ok: false, reason }, a short label with no
  // data in it. A LightSpeed failure is always the second, never "not found".
  return async function lookupDeal({ store = 'UT', dealNumber }) {
    const code = STORE_CODES[store];
    if (!code) throw safeError(`unknown store ${store}`);
    if (!/^\d{1,10}$/.test(String(dealNumber || ''))) throw safeError('invalid deal number');
    let res;
    try {
      client = client || (await auth.getIdTokenClient(url));
      res = await client.request({ url, method: 'POST', data: { store: code, dealNo: String(dealNumber) }, timeout: timeoutMs, validateStatus: () => true });
    } catch (err) {
      return { ok: false, reason: /timeout|ETIMEDOUT|aborted/i.test(`${err && err.code} ${err && err.name} ${err && err.message}`) ? 'lookup_timeout' : 'lookup_unreachable' };
    }
    const body = res.data;
    if (res.status === 200 && body && body.ok === true && body.result && Array.isArray(body.result.found)) return { ok: true, found: body.result.found };
    // Only a short label from the function is passed on; anything else is named by its status.
    const reason = body && typeof body.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(body.reason) ? body.reason : `http_${res.status}`;
    return { ok: false, reason };
  };
}

module.exports = { createDealLookup, STORE_CODES, TIMEOUT_MS };
