'use strict';

// Basecamp's App Home: "Utah deals" in shadow mode, "My deals" once Team Members have
// access. Open deals grouped by how soon they deliver, one tile each with the Roamer,
// deal number, trailer, Sales Coach, delivery, and last contact, then the Brief and deal
// space buttons. Built from one HubSpot search on every open; no AI until someone taps
// Brief. No counts or dates in the header (Blake keeps cards to what the team acts on), and
// no orange: urgency and quiet deals are bold text and an icon.

const { noDashes, shortDate } = require('../agents/roamerBrief');
const { primary, secondary, label } = require('./style');

// Past this many days without contact, a deal gets a heads-up, but only when delivery is
// within FLAG_WITHIN_DAYS (or past due). Further out, a quiet week is normal and a flag
// would be noise.
const QUIET_DAYS = 7;
const FLAG_WITHIN_DAYS = 42;
// Deals delivering in under URGENT_DAYS (or past due) get their own group, with a bold
// delivery line and a filled calendar icon.
const URGENT_DAYS = 3;
const TIME_ZONE = 'America/Denver';

const isUrgent = (days) => days !== null && days < URGENT_DAYS;

const GROUPS = [
  { key: 'now', title: 'On deck', test: isUrgent },
  { key: 'soon', title: 'This week', test: (days) => days !== null && days >= URGENT_DAYS && days <= 7 },
  { key: 'next', title: 'Next two weeks', test: (days) => days !== null && days > 7 && days <= 21 },
  { key: 'later', title: 'Later', test: (days) => days !== null && days > 21 },
  { key: 'none', title: 'No delivery date', test: (days) => days === null },
];

function escape(text) {
  return noDashes(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Today's date where the Experience Centers are, as YYYY-MM-DD.
function todayIn(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// A real calendar date as YYYY-MM-DD (not "2026-02-30", which Date would roll forward).
function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

// Null when either date is unreadable, so the deal still shows, as having no date.
function daysBetween(from, to) {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// A timestamp (when someone made contact) as a date where the Experience Center is. HubSpot
// stores it in UTC, so an evening contact in Utah would otherwise read as the next day.
// A plain YYYY-MM-DD is already a date and is kept.
function localDate(value, timeZone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return isCalendarDate(value) ? value : null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : todayIn(timeZone, at);
}

// The bold delivery line on an urgent tile.
function deliversLabel(days) {
  if (days === 0) return 'Delivers today';
  if (days === 1) return 'Delivers tomorrow';
  if (days > 1) return `Delivers in ${days} days`;
  return days === -1 ? '1 day past delivery date' : `${-days} days past delivery date`;
}

function whenLabel(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  if (days === -1) return '1 day past';
  return `${-days} days past`;
}

// After a tap, the button reads "In Messages" and is disabled: Home cannot update itself when
// the brief lands, so the label has to stay true until Home is reopened.
function briefButton(deal, endpoint, sent) {
  if (sent) return { text: 'In Messages', type: 'OUTLINED', disabled: true, icon: { materialIcon: { name: 'check' } }, onClick: { action: { function: endpoint } } };
  return primary('Brief', {
    action: {
      function: endpoint,
      // The name rides along so the "read up on" message can say whose brief is coming.
      parameters: [
        { key: 'action', value: 'brief' },
        { key: 'dealNumber', value: String(deal.dealNumber) },
        { key: 'roamer', value: noDashes(deal.roamer || '').slice(0, 60) },
      ],
    },
  });
}

// The deal space button on a tile. `space` is null when the deal has no space yet, else
// { uri, member }. In a space: a link. Not in it: ask the space to add you. No space: create
// it, for people whose briefs are on (creating one can write a brief). After a tap the
// button reads where the answer went and cannot be tapped again.
function spaceButton(deal, endpoint, space, sent, briefsPaused) {
  const n = String(deal.dealNumber);
  const tap = (action) => ({ action: { function: endpoint, parameters: [{ key: 'action', value: action }, { key: 'dealNumber', value: n }] } });
  const done = (text) => ({ text, type: 'OUTLINED', disabled: true, icon: { materialIcon: { name: 'check' } }, onClick: { action: { function: endpoint } } });
  if (space && space.member) {
    if (!space.uri) return null;
    return { ...secondary('Space', { openLink: { url: space.uri } }), icon: { materialIcon: { name: 'forum' } } };
  }
  if (space) return sent.has(`join:${n}`) ? done('Asked') : secondary('Request access', tap('join'));
  if (briefsPaused) return null;
  return sent.has(`space:${n}`) ? done('In Messages') : secondary('Create space', tap('space'));
}

// One deal's tile: the Roamer, then deal number, trailer, and Sales Coach under the name;
// then delivery; then last contact; then the Brief and deal space buttons in a row.
function dealWidgets(deal, today, endpoint, sent, briefsPaused, spaces) {
  const days = deal.projectedDelivery ? daysBetween(today, deal.projectedDelivery) : null;
  const contacted = deal.lastContacted ? localDate(deal.lastContacted, TIME_ZONE) : null;
  const quietFor = contacted ? daysBetween(contacted, today) : null;
  const urgent = isUrgent(days);

  // The Sales Coach is the deal owner, not whoever made the last contact.
  const roamer = {
    decoratedText: {
      text: `<b>${escape(deal.roamer || 'Roamer')}</b>`,
      bottomLabel: [deal.dealNumber, deal.trailer, deal.contacts > 1 ? `${deal.contacts} contacts` : null, `Sales Coach ${deal.salesCoach || 'not set'}`]
        .filter(Boolean)
        .map(noDashes)
        .join(' · '),
      wrapText: true,
    },
  };

  let deliveryText = 'No delivery date';
  if (days !== null) {
    deliveryText = urgent ? `<b>${deliversLabel(days)} · ${shortDate(deal.projectedDelivery)}</b>` : `Delivery ${shortDate(deal.projectedDelivery)} (${whenLabel(days)})`;
  }
  const delivery = { decoratedText: { startIcon: { materialIcon: urgent ? { name: 'event', fill: true } : { name: 'event' } }, text: deliveryText, wrapText: true } };

  const by = deal.lastContactBy ? `, ${escape(deal.lastContactBy)} (${deal.lastContactChannel})` : '';
  const flagged = days !== null && days <= FLAG_WITHIN_DAYS;
  let contactText;
  let quiet = false;
  if (!contacted) {
    quiet = flagged;
    contactText = flagged ? '<b>No contact logged yet</b>' : 'No contact logged yet';
  } else if (flagged && quietFor > QUIET_DAYS) {
    quiet = true;
    contactText = `<b>No contact in ${quietFor} days</b> · last ${shortDate(contacted)}${by}`;
  } else {
    contactText = `Last contact ${shortDate(contacted)}${by}`;
  }
  const contact = { decoratedText: { startIcon: { materialIcon: { name: quiet ? 'error' : 'forum' } }, text: contactText, wrapText: true } };

  const widgets = [roamer, delivery, contact];
  const buttons = [];
  if (deal.dealNumber && !briefsPaused) buttons.push(briefButton(deal, endpoint, sent.has(String(deal.dealNumber))));
  // Without `spaces` (deal spaces could not be read), tiles show no space button.
  if (deal.dealNumber && spaces) {
    const button = spaceButton(deal, endpoint, spaces.get(String(deal.dealNumber)) || null, sent, briefsPaused);
    if (button) buttons.push(button);
  }
  if (buttons.length) widgets.push({ buttonList: { buttons } });
  return { days, widgets };
}
// Why briefs are off, as the Home footer says it.
const BRIEFS_OFF = {
  paused: "Roamer briefs are paused for now while Basecamp's AI funding is sorted out.",
  notBriefUser: "Roamer briefs are off for you for now, to save Basecamp's AI credits for a test.",
};

// With `briefsOff` ('paused' or 'notBriefUser'), tiles have no Brief button and the footer
// says why. `spaces` is Map(dealNumber -> { uri, member }) for deals with a deal space.
function renderHome({ deals, endpoint, shadow, sent = new Set(), now = new Date(), briefsOff = null, spaces = null }) {
  const briefsPaused = Boolean(briefsOff);
  const today = todayIn(TIME_ZONE, now);
  const rows = deals.map((d) => dealWidgets(d, today, endpoint, sent, briefsPaused, spaces));

  const sections = [];

  // Each deal is its own section, which Chat draws as its own rounded tile. The group
  // title rides on the first tile of its group. Sections cannot collapse together, so
  // there is no "Show more"; revisit if lists grow long.
  for (const group of GROUPS) {
    const deals = rows.filter((r) => group.test(r.days)).map((r) => r.widgets);
    if (!deals.length) continue;
    const header = label(group.title);
    deals.forEach((widgets, i) => sections.push(i === 0 ? { header, widgets } : { widgets }));
  }

  if (!deals.length) sections.push({ widgets: [{ textParagraph: { text: '<i>No open deals right now.</i>' } }] });

  sections.push({
    widgets: [
      {
        textParagraph: {
          text: `${shadow ? 'Shadow mode: showing every open Utah deal. ' : ''}${
            briefsPaused ? BRIEFS_OFF[briefsOff] || BRIEFS_OFF.paused : 'Tap Brief and the Roamer brief arrives in the Messages tab in about a minute.'
          }`,
        },
      },
    ],
  });

  return { header: { title: shadow ? 'Utah deals' : 'My deals' }, sections };
}

// Shown on Home to anyone not yet allowed to use Basecamp.
function renderNotAllowedHome() {
  return { sections: [{ widgets: [{ textParagraph: { text: "Basecamp isn't available to you yet." } }] }] };
}

module.exports = { renderHome, renderNotAllowedHome, todayIn, daysBetween, localDate, whenLabel, deliversLabel, QUIET_DAYS, FLAG_WITHIN_DAYS };
