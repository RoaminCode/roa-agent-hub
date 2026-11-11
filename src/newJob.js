'use strict';

// "/new": what's new on a deal, posted in the thread it was asked in (straight into the
// space, Blake's call 2026-11-08: it summarizes the record, it does not answer a factual
// question). "/new" covers everything since the deal's last brief; "/new since Monday" (or
// "since 11/3", "yesterday", "this week", "last week", "5 days") from that day. In a direct
// message the deal comes first ("/new 51455 since Monday"). Only the items after that point
// are summarized, so it costs nothing when nothing is new. Logs steps, never Roamer details.

const { errorFields, isOutOfCredits } = require('./errors');
const { summarizeNew } = require('./agents/whatsNew');
const { recordDate, shortDate } = require('./agents/roamerBrief');

const TIME_ZONE = 'America/Denver';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const SAY = {
  dealFirst: 'In a direct message, name the deal first, for example: /new 51455 since Monday',
  notDealSpace: "This space isn't linked to a deal. Link it with \"use this space for <deal#>\", or send /new 51455 in a direct message with me.",
  noDeal: (n) => `I couldn't find deal ${n} in HubSpot.`,
  badSince: 'I didn\'t understand that date. Try "since Monday", "since 11/3", "yesterday", "this week", or "5 days".',
  nothing: (n, since) => `Nothing new on deal ${n} since ${since}.`,
  nothingWorth: (n, since) => `Deal ${n} has new items since ${since}, but nothing a Team Member needs (automated or reminder messages).`,
  failed: "I couldn't check what's new just now. Blake can see what happened in the logs.",
  noCredits: "I couldn't check what's new: Basecamp's AI credits have run out.",
};

// Today where the Experience Center is, as YYYY-MM-DD.
const today = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekday = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

// "since Monday" and friends, as the first day to include (YYYY-MM-DD, Utah time). Null for
// nothing given (since the last brief); { error } when it can't be read.
function parseSince(text, now = new Date()) {
  const t = String(text || '').trim().toLowerCase().replace(/^since\s+/, '').replace(/[?.!]+$/, '').trim();
  if (!t) return null;
  const d = today(now);
  if (t === 'today') return { from: d };
  if (t === 'yesterday') return { from: addDays(d, -1) };
  if (t === 'this week') return { from: addDays(d, -((weekday(d) + 6) % 7)) };
  if (t === 'last week') return { from: addDays(d, -7) };
  let m = /^(\d{1,3})\s+days?(?:\s+ago)?$/.exec(t);
  if (m) return { from: addDays(d, -Number(m[1])) };
  m = /^(?:last\s+)?([a-z]+)$/.exec(t);
  if (m) {
    const i = DAYS.findIndex((name) => name.startsWith(m[1]) && m[1].length >= 3);
    // The most recent one, today included.
    if (i >= 0) return { from: addDays(d, -((weekday(d) - i + 7) % 7)) };
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : d.slice(0, 4);
    let from = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    if (Number.isNaN(Date.parse(from))) return { error: true };
    // A month and day with no year that is still ahead means last year.
    if (!m[3] && from > d) from = `${Number(year) - 1}${from.slice(4)}`;
    return { from };
  }
  return { error: true };
}

function newCard({ dealNumber, sinceLabel, items }) {
  return {
    fallbackText: `What's new on deal ${dealNumber}`,
    cardsV2: [
      {
        cardId: `new-${dealNumber}`,
        card: {
          header: { title: `What's new on deal ${dealNumber}`, subtitle: `Since ${sinceLabel}` },
          sections: [
            {
              widgets: items.map((i) => ({
                decoratedText: { text: i.detail.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), bottomLabel: `${shortDate(i.date)} · ${i.channel}`, wrapText: true },
              })),
            },
          ],
        },
      },
    ],
  };
}

// `loadContext` reads the deal's record (hubspot/dealContext.js).
function createWhatsNew({ anthropic, db, loadContext, findDealSpace, log, summarize = summarizeNew, now = () => new Date() }) {
  return async function whatsNew({ spaceName, isDirectMessage, text = '', userEmail }) {
    let args = String(text || '').trim();
    let dealNumber = null;
    const started = Date.now();
    try {
      if (isDirectMessage) {
        const m = /^#?(\d{3,8})\b\s*([\s\S]*)$/.exec(args);
        if (!m) return SAY.dealFirst;
        dealNumber = m[1];
        args = m[2].trim();
        if (!(await findDealSpace({ dealNumber }))) return SAY.noDeal(dealNumber);
      } else {
        const space = await db.getSpace(spaceName);
        const deal = space && space.status === 'ready' ? await db.getDeal(space.dealId) : null;
        if (!deal || deal.spaceName !== spaceName) return SAY.notDealSpace;
        dealNumber = space.dealNumber;
      }
      const since = parseSince(args, now());
      if (since && since.error) return SAY.badSince;

      const context = await loadContext({ store: 'UT', dealNumber, rememberPick: true });
      if (!context.found || !context.items) return SAY.noDeal(dealNumber);
      // Since a date: items from that day on. Otherwise, items after the last brief's newest
      // item; with no brief, the last 7 days.
      let fresh;
      let sinceLabel;
      const lastBrief = context.briefNote && context.briefNote.signature && context.briefNote.signature.newestAt;
      if (since) {
        fresh = context.items.filter((i) => recordDate(i.at) >= since.from);
        sinceLabel = shortDate(since.from);
      } else if (lastBrief) {
        fresh = context.items.filter((i) => String(i.at || '') > lastBrief);
        sinceLabel = 'the last brief';
      } else {
        const from = addDays(today(now()), -7);
        fresh = context.items.filter((i) => recordDate(i.at) >= from);
        sinceLabel = shortDate(from);
      }
      if (!fresh.length) {
        log('INFO', 'whats new: nothing', { dealNumber, user: userEmail, ms: Date.now() - started });
        return SAY.nothing(dealNumber, sinceLabel);
      }
      const result = await summarize({ anthropic, items: fresh, dealId: context.deal ? context.deal.id : null });
      const usage = result.usage || {};
      log('INFO', result.ok ? 'whats new' : 'whats new failed', { dealNumber, reason: result.reason || null, items: fresh.length, listed: result.ok ? result.items.length : 0, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, costUsd: result.costUsd ?? null, user: userEmail, ms: Date.now() - started });
      if (!result.ok) return SAY.failed;
      if (!result.items.length) return SAY.nothingWorth(dealNumber, sinceLabel);
      return newCard({ dealNumber, sinceLabel, items: result.items });
    } catch (err) {
      log('ERROR', isOutOfCredits(err) ? 'whats new failed: out of AI credits' : 'whats new failed', { dealNumber, error: errorFields(err), ms: Date.now() - started });
      return isOutOfCredits(err) ? SAY.noCredits : SAY.failed;
    }
  };
}

module.exports = { createWhatsNew, parseSince, newCard, SAY };
