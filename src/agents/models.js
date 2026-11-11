'use strict';

// Every model Basecamp calls and what each costs, in one place, so a model or a price is
// changed once. The Roamer brief runs on Opus, /wow on Sonnet, and the narrow jobs (routing
// a question, the reuse and brief checks, reading a reminder's time, drafting a text, what's
// new) on Haiku.

const MODELS = {
  brief: 'claude-opus-5-5',
  wow: 'claude-sonnet-5-5',
  small: 'claude-haiku-5-5',
};

// US dollars per million tokens. Check Anthropic's pricing page if these look off; the
// logged token counts are exact either way. The models below the first three are the ones a
// brief can fall back to when the first declines, priced so a fallback is still counted.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
};

// Haiku 5.5 costs more per token once a prompt passes this many tokens.
const HAIKU_LONG_PROMPT = 100000;
const HAIKU_LONG_PRICE = { input: 0.5, output: 2.5 };

function priceOf(model, usage) {
  const name = String(model || '');
  if (name.startsWith('claude-haiku-5-5') && usage && usage.input_tokens > HAIKU_LONG_PROMPT) return HAIKU_LONG_PRICE;
  // A model id may carry a date after its name.
  const known = Object.keys(PRICES).find((id) => name === id || name.startsWith(`${id}-`));
  return known ? PRICES[known] : null;
}

// What one call cost, in US dollars; null when there is no usage or the model has no price here.
function costOf(usage, model) {
  if (!usage) return null;
  const price = priceOf(model, usage);
  if (!price) return null;
  return ((usage.input_tokens || 0) * price.input + (usage.output_tokens || 0) * price.output) / 1e6;
}

module.exports = { MODELS, PRICES, costOf, priceOf };
