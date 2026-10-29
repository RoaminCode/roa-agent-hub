'use strict';

// Basecamp's App Home: "Utah deals" in shadow mode, "My deals" once Team Members have
// access. Open deals grouped by how soon they deliver, each with
// the Roamer, trailer, delivery, last contact, Sales Coach, and a Brief button. Built from
// one HubSpot search on every open; no AI until someone taps Brief.

const { noDashes, shortDate } = require('../agents/roamerBrief');
const { COLORS } = require('./briefCard');

// Past this many days without contact, a deal gets a quiet amber heads-up, but only
// when delivery is within FLAG_WITHIN_DAYS (or past due). Further out, a quiet week is
// normal and a flag would be noise.
const QUIET_DAYS = 7;
const FLAG_WITHIN_DAYS = 42;
const AMBER = '#C27C0E';
// Deals delivering in under URGENT_DAYS (or past due) get their own group in the
// orange of Basecamp's mic. Chat cards cannot color a tile's background, so the group
// title, a delivery line, and a filled icon carry it instead.
const URGENT_DAYS = 3;
const URGENT = '#E2692E';
const TIME_ZONE = 'America/Denver';

const isUrgent = (days) => days !== null && days < URGENT_DAYS;

const GROUPS = [
  { key: 'now', title: 'On deck', color: URGENT, test: isUrgent },
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

// The orange line on an urgent tile.
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
  return {
    text: 'Brief',
    type: 'FILLED_TONAL',
    onClick: {
      action: {
        function: endpoint,
        // The name rides along so the "read up on" message can say whose brief is coming.
        parameters: [
          { key: 'action', value: 'brief' },
          { key: 'dealNumber', value: String(deal.dealNumber) },
          { key: 'roamer', value: noDashes(deal.roamer || '').slice(0, 60) },
        ],
      },
    },
  };
}

// One deal's tile: the Roamer with the Sales Coach at top right, then delivery on its own
// row, then last contact on its own row with the Brief button.
function dealWidgets(deal, today, endpoint, sent, briefsPaused) {
  const days = deal.projectedDelivery ? daysBetween(today, deal.projectedDelivery) : null;
  const contacted = deal.lastContacted ? localDate(deal.lastContacted, TIME_ZONE) : null;
  const quietFor = contacted ? daysBetween(contacted, today) : null;
  const urgent = isUrgent(days);

  const roamer = {
    decoratedText: {
      startIcon: { materialIcon: urgent ? { name: 'rv_hookup', fill: true } : { name: 'rv_hookup' } },
      topLabel: [deal.dealNumber, deal.trailer, deal.contacts > 1 ? `${deal.contacts} contacts` : null].filter(Boolean).map(noDashes).join(' · '),
      text: `<b>${escape(deal.roamer || 'Roamer')}</b>`,
      wrapText: true,
    },
  };
  // The deal owner, not whoever made the last contact.
  const coach = {
    decoratedText: { topLabel: 'Sales Coach', text: escape(deal.salesCoach || 'Not set'), wrapText: true },
  };
  const top = {
    columns: {
      columnItems: [
        { horizontalSizeStyle: 'FILL_AVAILABLE_SPACE', horizontalAlignment: 'START', verticalAlignment: 'CENTER', widgets: [roamer] },
        { horizontalSizeStyle: 'FILL_MINIMUM_SPACE', horizontalAlignment: 'END', verticalAlignment: 'CENTER', widgets: [coach] },
      ],
    },
  };

  let deliveryText = 'No delivery date';
  if (days !== null) {
    deliveryText = urgent
      ? `<font color="${URGENT}"><b>${deliversLabel(days)}</b></font> · ${shortDate(deal.projectedDelivery)}`
      : `Delivery ${shortDate(deal.projectedDelivery)} (${whenLabel(days)})`;
  }
  const delivery = { decoratedText: { startIcon: { materialIcon: { name: 'event' } }, text: deliveryText, wrapText: true } };

  const by = deal.lastContactBy ? `, ${escape(deal.lastContactBy)} (${deal.lastContactChannel})` : '';
  const flagged = days !== null && days <= FLAG_WITHIN_DAYS;
  let contactText;
  if (!contacted) {
    contactText = flagged ? `<font color="${AMBER}">No contact logged yet</font>` : 'No contact logged yet';
  } else if (flagged && quietFor > QUIET_DAYS) {
    contactText = `<font color="${AMBER}">No contact in ${quietFor} days · last ${shortDate(contacted)}${by}</font>`;
  } else {
    contactText = `Last contact ${shortDate(contacted)}${by}`;
  }
  const contact = { decoratedText: { startIcon: { materialIcon: { name: 'forum' } }, text: contactText, wrapText: true } };
  if (deal.dealNumber && !briefsPaused) contact.decoratedText.button = briefButton(deal, endpoint, sent.has(String(deal.dealNumber)));

  return { days, widgets: [top, delivery, contact] };
}
// With `briefsPaused`, tiles have no Brief button and the footer says why.
function renderHome({ deals, endpoint, shadow, sent = new Set(), now = new Date(), briefsPaused = false }) {
  const today = todayIn(TIME_ZONE, now);
  const rows = deals.map((d) => dealWidgets(d, today, endpoint, sent, briefsPaused));

  const sections = [];

  // Each deal is its own section, which Chat draws as its own rounded tile. The group
  // title rides on the first tile of its group. Sections cannot collapse together, so
  // there is no "Show more"; revisit if lists grow long.
  for (const group of GROUPS) {
    const deals = rows.filter((r) => group.test(r.days)).map((r) => r.widgets);
    if (!deals.length) continue;
    const header = `<font color="${group.color || COLORS.wow}"><b>${group.title.toUpperCase()}</b></font> <font color="${COLORS.muted}">${deals.length}</font>`;
    deals.forEach((widgets, i) => sections.push(i === 0 ? { header, widgets } : { widgets }));
  }

  if (!deals.length) sections.push({ widgets: [{ textParagraph: { text: '<i>No open deals right now.</i>' } }] });

  sections.push({
    widgets: [
      {
        textParagraph: {
          text: `<font color="${COLORS.muted}">${
            shadow ? 'Shadow mode: showing every open Utah deal. ' : ''
          }${
            briefsPaused
              ? "Roamer briefs are paused for now while Basecamp's AI funding is sorted out."
              : 'Tap Brief and the Roamer brief arrives in the Messages tab in about a minute.'
          }</font>`,
        },
      },
    ],
  });

  return {
    header: { title: shadow ? 'Utah deals' : 'My deals', subtitle: `${deals.length} open · ${shortDate(today)}` },
    sections,
  };
}

// Shown on Home to anyone not yet allowed to use Basecamp.
function renderNotAllowedHome() {
  return { sections: [{ widgets: [{ textParagraph: { text: "Basecamp isn't available to you yet." } }] }] };
}

module.exports = { renderHome, renderNotAllowedHome, todayIn, daysBetween, localDate, whenLabel, deliversLabel, QUIET_DAYS, FLAG_WITHIN_DAYS };
