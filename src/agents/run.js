'use strict';

// One call to a model that must answer in a JSON shape, shared by every narrow job, so the
// checks are the same everywhere: a refusal, an answer cut off at the token limit, and
// output that is not the JSON asked for each come back as { ok: false, reason }. Every call
// is priced (agents/models.js) and counted toward Basecamp's spend (spend.js) when the
// client carries a meter. Each job keeps its own instructions, schema, and checks on what
// the JSON says.

const { costOf } = require('./models');

// Counts one finished call: its cost, and where it goes in the spend records. `anthropic`
// carries the meter when spend is being tracked (server.js); tests and scripts have none.
// Returns { usage, costUsd, model }. `model` is the one that answered, which can differ
// from the one asked when a brief falls back.
async function settle({ anthropic, job, asked, message, dealId = null }) {
  const usage = message.usage;
  const model = message.model || asked;
  const costUsd = costOf(usage, model);
  if (anthropic.meter) await anthropic.meter.record({ job, model, costUsd, dealId });
  return { usage, costUsd, model };
}

// { ok: true, out, usage, costUsd, model } or { ok: false, reason, usage, costUsd, model }.
// `reason` is "refusal", "too_long" (stopped at max_tokens, so the JSON is incomplete), or
// "bad_output". `effort` is set for models that think by default, where thinking counts
// toward `maxTokens`. `dealId`, when known, adds the cost to that deal's total.
async function runStructured({ anthropic, job, model, system, schema, user, maxTokens, timeout, effort = null, dealId = null }) {
  const message = await anthropic.messages.create(
    {
      model,
      max_tokens: maxTokens,
      output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    },
    { timeout },
  );
  const spent = await settle({ anthropic, job, asked: model, message, dealId });
  if (message.stop_reason === 'refusal') return { ok: false, reason: 'refusal', ...spent };
  if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'too_long', ...spent };
  let out;
  try {
    // Read by type: a model that thinks first puts thinking blocks ahead of the text.
    out = JSON.parse(message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  } catch {
    return { ok: false, reason: 'bad_output', ...spent };
  }
  if (out === null || typeof out !== 'object') return { ok: false, reason: 'bad_output', ...spent };
  return { ok: true, out, ...spent };
}

module.exports = { runStructured, settle };
