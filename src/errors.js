'use strict';

// Errors in logs: verbose about what failed, never about what a Roamer or Team Member wrote.
// Library error messages can quote their input (Node's JSON parse errors quote a slice of
// the body, which can be Chat message text), so a message is logged only when this hub
// wrote it and marked it safe. Everything else is described by its type, status, provider
// error code, request ID, and where in the code it happened.

// An error whose message this hub wrote, from values known to hold no Roamer details
// (methods, paths, statuses, counts, IDs).
function safeError(message) {
  const err = new Error(message);
  err.safe = true;
  return err;
}

// Stack frames as "function (file:line)", without the first line, which repeats the message.
function frames(stack) {
  return String(stack || '')
    .split('\n')
    .slice(1)
    .map((line) => /^\s*at (?:(.+?) \()?(?:.*[\\/])?([^\\/()]+?):(\d+):\d+\)?$/.exec(line))
    .filter(Boolean)
    .slice(0, 8)
    .map(([, fn, file, line]) => `${fn ? `${fn} ` : ''}(${file}:${line})`);
}

// The fields of an error that are safe to log, for `log(severity, message, { error: errorFields(err) })`.
function errorFields(err) {
  if (!err || typeof err !== 'object') return { type: typeof err };
  const out = { type: err.name || (err.constructor && err.constructor.name) || 'Error' };
  if (err.safe) out.message = err.message;
  // HTTP status: Anthropic SDK (status), Google libraries (status, or response.status).
  const status = err.status || (err.response && err.response.status);
  if (status) out.status = status;
  // A short code, such as ECONNRESET or a Google API status, is a label, not data.
  if (typeof err.code === 'string' || typeof err.code === 'number') out.code = err.code;
  // Google's error labels, never its message: the status ("INVALID_ARGUMENT"), the reason
  // ("ACCESS_TOKEN_SCOPE_INSUFFICIENT"), and the names of fields it rejected.
  const google = err.response && err.response.data && err.response.data.error;
  if (google && typeof google === 'object') {
    if (typeof google.status === 'string') out.googleStatus = google.status;
    const details = Array.isArray(google.details) ? google.details : [];
    const reasons = details.map((d) => d && d.reason).filter((r) => typeof r === 'string');
    if (reasons.length) out.googleReasons = reasons;
    const fields = details.flatMap((d) => (d && Array.isArray(d.fieldViolations) ? d.fieldViolations : [])).map((v) => v && v.field).filter((f) => typeof f === 'string');
    if (fields.length) out.googleFields = fields;
  }
  // Anthropic's error type, such as "overloaded_error", and its request ID for support.
  const providerType = err.error && err.error.error && err.error.error.type;
  if (typeof providerType === 'string') out.providerType = providerType;
  const requestId = err.requestID || err.request_id || (err.headers && typeof err.headers.get === 'function' && err.headers.get('request-id'));
  if (requestId) out.requestId = String(requestId);
  const where = frames(err.stack);
  if (where.length) out.stack = where;
  return out;
}

// Anthropic says the account is out of prepaid credits: a billing error (402), or the older
// 400 "credit balance is too low". The message is read here only to classify; it is not logged.
function isOutOfCredits(err) {
  if (!err || typeof err !== 'object') return false;
  const providerType = err.error && err.error.error && err.error.error.type;
  if (err.status === 402 || providerType === 'billing_error') return true;
  return err.status === 400 && /credit balance/i.test(String(err.message || ''));
}

module.exports = { safeError, errorFields, isOutOfCredits };
