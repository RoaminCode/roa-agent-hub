'use strict';

// Aloware, for exactly one thing: sending a text a Team Member approved, word for word
// (authorized by Blake 2026-10-28). Always as the company (`user_id: -1`), never as a
// Team Member or the contact's owner. The token opens the whole Aloware account, so this
// client has one method and no general request; a test fails if another appears.
// While in shadow mode only the numbers on `allowedNumbers` (Blake's and Shane's) can be
// texted; any other number is refused here, whatever the caller asks.

const { safeError } = require('./errors');

const SEND_URL = 'https://app.aloware.io/api/v1/webhook/sms-gateway/send';
const COMPANY = -1;
const MAX_CHARS = 160;
const TIMEOUT_MS = 20 * 1000;

// "+1 (801) 555-0100" and "8015550100" are the same number: +18015550100.
function toE164(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function createAloware({ token, allowedNumbers = [], fetchImpl = fetch }) {
  if (!token) throw new Error('createAloware: token is required');
  const allowed = new Set(allowedNumbers.map(toE164).filter(Boolean));

  // Sends one approved text. `lineId` is the Aloware line it goes out on. Returns when
  // Aloware has accepted it (202); Aloware then logs it to the HubSpot contact.
  async function sendApproved({ lineId, to, message }) {
    const number = toE164(to);
    if (!number) throw safeError('sendApproved: not a phone number');
    if (!allowed.has(number)) throw safeError('sendApproved: refused, that number is not on the allowed list');
    if (!/^\d+$/.test(String(lineId))) throw safeError('sendApproved: invalid line');
    const text = String(message || '');
    if (!text.trim()) throw safeError('sendApproved: empty message');
    if (text.length > MAX_CHARS) throw safeError(`sendApproved: message over ${MAX_CHARS} characters`);
    const res = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ line_id: Number(lineId), to: number, message: text, user_id: COMPANY }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 202 && !res.ok) {
      // The status is enough to debug; the body could echo the message.
      const err = safeError(`Aloware send failed: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return { to: number, lineId: String(lineId) };
  }

  return { sendApproved };
}

module.exports = { createAloware, toE164, MAX_CHARS, COMPANY };
