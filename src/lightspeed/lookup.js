'use strict';

// The hub's one way to LightSpeed: the integration project's read-only lookup function,
// `rjbDealLookup` (Google Cloud project hs-ls-integration). The hub holds no LightSpeed
// credential. It calls the function as its own service account, basecamp-router, with a
// Google-signed identity token, and that function lets nobody else in. It answers two
// questions, each for one store, with only the fields the hub may see:
//   a deal by its number: deal facts, the unit, labor lines, a short parts list
//   a repair order by its number: its jobs once it is paid, and tech time on it either way
// No Roamer contact details, no finance terms, no costs or prices. LightSpeed is the source
// of truth for deal facts and is never changed from here.

const { GoogleAuth } = require('google-auth-library');
const { safeError } = require('../errors');

// The hub's store codes as LightSpeed's function names them.
const STORE_CODES = { UT: 'ROA1', SC: 'ROA2', AZ: 'ROA3', CO: 'ROA4' };

// The function aims to answer within 12 seconds; past this the hub gives up.
const TIMEOUT_MS = 20 * 1000;

// `url` is the function's address (RJB_LOOKUP_URL), which is also the audience its token is
// made for. `auth` is a GoogleAuth (on Cloud Run the token comes from the metadata server).
function createLightSpeed({ url, auth = new GoogleAuth(), timeoutMs = TIMEOUT_MS }) {
  if (!/^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(url || '')) throw safeError('the LightSpeed lookup URL looks wrong');
  let client = null;

  // One call. Returns the function's `result` through `read`, or { ok: false, reason }, a
  // short label with no data in it. A LightSpeed failure is always the second, never "not found".
  async function call(data, read) {
    let res;
    try {
      client = client || (await auth.getIdTokenClient(url));
      res = await client.request({ url, method: 'POST', data, timeout: timeoutMs, validateStatus: () => true });
    } catch (err) {
      return { ok: false, reason: /timeout|ETIMEDOUT|aborted/i.test(`${err && err.code} ${err && err.name} ${err && err.message}`) ? 'lookup_timeout' : 'lookup_unreachable' };
    }
    const body = res.data;
    const got = res.status === 200 && body && body.ok === true && body.result ? read(body.result) : null;
    if (got) return { ok: true, ...got };
    // Only a short label from the function is passed on; anything else is named by its status.
    const reason = body && typeof body.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(body.reason) ? body.reason : `http_${res.status}`;
    return { ok: false, reason };
  }

  const storeCode = (store) => {
    const code = STORE_CODES[store];
    if (!code) throw safeError(`unknown store ${store}`);
    return code;
  };

  // { ok: true, found: [{ store, feed, deal }] }: empty when the store has no such deal; an
  // open deal comes before a closed one.
  async function lookupDeal({ store = 'UT', dealNumber }) {
    const code = storeCode(store);
    if (!/^\d{1,10}$/.test(String(dealNumber || ''))) throw safeError('invalid deal number');
    return call({ store: code, dealNo: String(dealNumber) }, (result) => (Array.isArray(result.found) ? { found: result.found } : null));
  }

  // { ok: true, ro: { roNumber, paid, clock } }. `paid` is the finished repair order with its
  // jobs, or null while it is not paid: LightSpeed gives no job list for an open one. `clock`
  // is tech time on it, paid or not: it shows work happened, not that a job is finished.
  async function lookupRepairOrder({ store = 'UT', roNumber }) {
    const code = storeCode(store);
    if (!/^\d{1,10}$/.test(String(roNumber || ''))) throw safeError('invalid repair order number');
    return call({ store: code, roNo: String(roNumber) }, (result) => {
      const ro = result.ro;
      return ro && typeof ro.roNumber === 'string' && ro.clock && Array.isArray(ro.clock.sessions) ? { ro } : null;
    });
  }

  return { lookupDeal, lookupRepairOrder };
}

// The deal lookup alone, for callers that need only that.
const createDealLookup = (options) => createLightSpeed(options).lookupDeal;

module.exports = { createLightSpeed, createDealLookup, STORE_CODES, TIMEOUT_MS };
