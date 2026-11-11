'use strict';

// What Basecamp's AI costs, counted as it is spent. Every model call adds its cost to the
// day's total in Basecamp's database (by job and by model) and, when the call was about a
// deal, to that deal's total. With a daily limit set (AI_DAILY_LIMIT_USD), AI jobs stop for
// the rest of the day once the total reaches it, and Blake is told once. Dollars and counts
// only: nothing a Roamer or Team Member wrote is kept here.

const { errorFields } = require('./errors');

const TIME_ZONE = 'America/Denver';
// How long a reading of today's total is trusted before the database is asked again, so a
// second instance's spend is seen within a minute.
const FRESH_MS = 60 * 1000;

// The day where the Experience Center is, as YYYY-MM-DD. A day's spend is counted in Utah time.
const dayOf = (at) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const money = (n) => `$${(Number(n) || 0).toFixed(n >= 0.1 || !n ? 2 : n >= 0.01 ? 3 : 4)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;

const SAY = {
  limitReached: (limit) => `Basecamp's AI reached today's spending limit of ${money(limit)} and is paused until tomorrow. Home, notes, and approving texts still work. Raise AI_DAILY_LIMIT_USD if today needs more.`,
  none: (days) => `No AI spend recorded in the last ${days} days.`,
  failed: "I couldn't read the spend records just now. Blake can see what happened in the logs.",
};

// `db` is Basecamp's records (db.js). `limitUsd` is the daily ceiling, or null for none.
// `notify(text)` tells Blake when the limit is reached.
function createMeter({ db, log, limitUsd = null, notify = async () => {}, now = () => new Date() }) {
  const limit = Number(limitUsd) > 0 ? Number(limitUsd) : null;
  let seen = null; // { day, totalUsd, at }

  // Adds one call's cost. Never throws: a failed count is logged, and the job it counted goes on.
  async function record({ job, model, costUsd, dealId = null }) {
    if (typeof costUsd !== 'number' || !(costUsd >= 0)) {
      if (model) log('WARNING', 'AI call not priced', { job, model });
      return;
    }
    try {
      const at = now();
      const day = dayOf(at);
      const r = await db.addSpend({ day, job, model, costUsd, dealId, limitUsd: limit });
      seen = { day, totalUsd: r.totalUsd, at: at.getTime() };
      if (r.crossed) {
        log('WARNING', 'AI daily limit reached', { day, totalUsd: r.totalUsd, limitUsd: limit });
        await notify(SAY.limitReached(limit)).catch((e) => log('ERROR', 'could not tell Blake the AI limit was reached', { error: errorFields(e) }));
      }
    } catch (err) {
      log('ERROR', 'could not record AI spend', { job, error: errorFields(err) });
    }
  }

  // Whether today's spend has reached the limit. False with no limit, and when the records
  // can't be read: a database problem must not look like a spending problem.
  async function overLimit() {
    if (!limit) return false;
    const at = now();
    const day = dayOf(at);
    if (!seen || seen.day !== day || at.getTime() - seen.at > FRESH_MS) {
      try {
        const doc = await db.getSpend(day);
        seen = { day, totalUsd: (doc && doc.totalUsd) || 0, at: at.getTime() };
      } catch (err) {
        log('WARNING', 'could not read AI spend', { error: errorFields(err) });
        return Boolean(seen && seen.day === day && seen.totalUsd >= limit);
      }
    }
    return seen.totalUsd >= limit;
  }

  // The last `days` days of spend as a Chat message: the total, today against the limit,
  // then by job and by day.
  async function report(days = 7) {
    try {
      const at = now();
      const wanted = Array.from({ length: days }, (_, i) => dayOf(new Date(at.getTime() - i * 24 * 60 * 60 * 1000)));
      const docs = (await Promise.all(wanted.map((d) => db.getSpend(d)))).map((doc, i) => ({ day: wanted[i], ...(doc || {}) }));
      const spent = docs.filter((d) => d.calls);
      if (!spent.length) return SAY.none(days);
      const total = spent.reduce((n, d) => n + (d.totalUsd || 0), 0);
      const calls = spent.reduce((n, d) => n + (d.calls || 0), 0);
      const jobs = {};
      for (const d of spent) {
        for (const [job, j] of Object.entries(d.jobs || {})) {
          jobs[job] = jobs[job] || { usd: 0, calls: 0 };
          jobs[job].usd += j.usd || 0;
          jobs[job].calls += j.calls || 0;
        }
      }
      const today = docs[0].totalUsd || 0;
      return [
        `*AI spend, last ${days} days:* ${money(total)} across ${calls} ${calls === 1 ? 'call' : 'calls'}`,
        limit ? `Today: ${money(today)} of the ${money(limit)} daily limit` : `Today: ${money(today)} (no daily limit set)`,
        '',
        '*By job*',
        ...Object.entries(jobs)
          .sort((a, b) => b[1].usd - a[1].usd)
          .map(([job, j]) => `• ${job}: ${money(j.usd)} (${j.calls})`),
        '',
        '*By day*',
        ...spent.map((d) => `• ${shortDay(d.day)}: ${money(d.totalUsd)} (${d.calls})`),
      ].join('\n');
    } catch (err) {
      log('ERROR', 'spend report failed', { error: errorFields(err) });
      return SAY.failed;
    }
  }

  return { record, overLimit, report, limitUsd: limit };
}

// The Anthropic client with the meter riding on it, so every agent that is handed the
// client counts what it spends without each job passing a meter around.
function withMeter(anthropic, meter) {
  return { messages: anthropic.messages, beta: anthropic.beta, meter };
}

module.exports = { createMeter, withMeter, dayOf, money, SAY };
