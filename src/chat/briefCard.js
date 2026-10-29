'use strict';

// Renders a Roamer brief as a Google Chat card (cards v2): a header with the Roamer and
// deal, the headline, Wow, Mods, and Journey as collapsible sections with one row per item, and
// buttons into HubSpot. Card text supports a small HTML subset, so all record text is
// escaped first.

const { noDashes, shortDate, basisLine } = require('../agents/roamerBrief');

// HubSpot portal for rvsofamerica.com, used to build record links.
const HUBSPOT_PORTAL_ID = '39605104';

// Rows shown before "Show more" in each section.
const VISIBLE_ROWS = 5;

// Arctic palette. Chat may show a card on a light or a dark background and our colors
// stay fixed, so these are mid-tones that read on both. Wow and Journey differ in
// lightness as well as hue so they stay distinct for color-blind readers.
const COLORS = { wow: '#2E9BD6', mods: '#23858A', journey: '#4A6F94', button: '#2E7DB8', muted: '#80868b' };

const MOD_STATUS = {
  approved: { icon: 'check_circle', label: 'Approved' },
  pending: { icon: 'schedule', label: 'Pending' },
  interested: { icon: 'lightbulb', label: 'Interested' },
  declined: { icon: 'cancel', label: 'Declined' },
};

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255, alpha: 1 };
}

const ICONS = { call: 'call', text: 'sms', email: 'mail', note: 'description' };

function escape(text) {
  return noDashes(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function itemSection(title, color, items) {
  const header = `<font color="${color}"><b>${title.toUpperCase()}</b></font>`;
  if (!items.length) {
    return { header, widgets: [{ textParagraph: { text: '<i>Nothing yet in the record.</i>' } }] };
  }
  const widgets = items.map((i) => ({
    decoratedText: {
      startIcon: { materialIcon: { name: ICONS[i.channel] || 'chat' } },
      text: escape(i.detail),
      bottomLabel: `${shortDate(i.date)}, ${i.channel}`,
      wrapText: true,
    },
  }));
  const section = { header, widgets };
  if (widgets.length > VISIBLE_ROWS) {
    section.collapsible = true;
    section.uncollapsibleWidgetsCount = VISIBLE_ROWS;
  }
  return section;
}

// Mods heard in conversation, each with its status. They are not yet checked against
// the deal in LightSpeed, and the section says so.
function modsSection(mods) {
  const header = `<font color="${COLORS.mods}"><b>MODS</b></font>`;
  const caveat = { textParagraph: { text: `<font color="${COLORS.muted}"><i>From conversations; not yet checked against the deal in LightSpeed.</i></font>` } };
  if (!mods.length) {
    return { header, widgets: [{ textParagraph: { text: '<i>No mods discussed yet.</i>' } }] };
  }
  const widgets = mods.map((m) => {
    const status = MOD_STATUS[m.status] || MOD_STATUS.interested;
    const price = m.price && m.price.trim() ? ` · ${escape(m.price.trim())}` : '';
    return {
      decoratedText: {
        startIcon: { materialIcon: { name: status.icon } },
        text: `${escape(m.name)}${price}`,
        bottomLabel: `${status.label} · ${shortDate(m.date)}, ${m.channel}`,
        wrapText: true,
      },
    };
  });
  const section = { header, widgets: [...widgets, caveat] };
  if (widgets.length > VISIBLE_ROWS) {
    section.collapsible = true;
    section.uncollapsibleWidgetsCount = VISIBLE_ROWS;
  }
  return section;
}

// Headline, then tags as chips, then key facts in two columns.
function summarySection(brief) {
  const widgets = [{ textParagraph: { text: `<b>${escape(brief.headline)}</b>` } }];
  const tags = (brief.tags || []).slice(0, 5);
  if (tags.length) widgets.push({ chipList: { chips: tags.map((t) => ({ label: noDashes(t) })) } });
  const facts = (brief.key_facts || []).slice(0, 4);
  if (facts.length) {
    const fact = (f) => ({ decoratedText: { topLabel: noDashes(f.label), text: escape(f.value), wrapText: true } });
    const column = (list) => ({
      horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
      horizontalAlignment: 'START',
      verticalAlignment: 'TOP',
      widgets: list.map(fact),
    });
    widgets.push({
      columns: { columnItems: [column(facts.filter((_, i) => i % 2 === 0)), column(facts.filter((_, i) => i % 2 === 1))] },
    });
  }
  return { widgets };
}

function link(text, url) {
  return { text, type: 'FILLED', color: rgb(COLORS.button), onClick: { openLink: { url } } };
}

// Asked when a deal has more than one contact: one button per contact, and the tapped one
// is read as the Roamer. The button carries the contact ID; Basecamp checks it is still on
// the deal before reading anything.
function renderContactChoice({ dealNumber, store, choices, contactCount, endpoint }) {
  const shown = contactCount > choices.length ? ` (the first ${choices.length} are shown)` : '';
  const buttons = choices.map((c) => ({
    text: noDashes(c.name).slice(0, 60),
    type: 'FILLED_TONAL',
    onClick: {
      action: {
        function: endpoint,
        parameters: [
          { key: 'action', value: 'brief' },
          { key: 'from', value: 'picker' },
          { key: 'dealNumber', value: String(dealNumber) },
          { key: 'store', value: store },
          { key: 'contactId', value: c.id },
          { key: 'roamer', value: noDashes(c.name).slice(0, 60) },
        ],
      },
    },
  }));
  return {
    fallbackText: `Deal ${dealNumber} has ${contactCount} contacts in HubSpot. Which one is the Roamer?`,
    cardsV2: [
      {
        cardId: `choose-${dealNumber}`,
        card: {
          sections: [
            {
              widgets: [
                { textParagraph: { text: `Deal ${escape(String(dealNumber))} has ${contactCount} contacts in HubSpot${shown}. <b>Which one is the Roamer?</b>` } },
                { buttonList: { buttons } },
              ],
            },
          ],
        },
      },
    ],
  };
}

function renderBriefCard({ dealNumber, context, brief, avatarUrl }) {
  const c = (context.contact && context.contact.properties) || {};
  const d = context.deal.properties;
  const name = [c.firstname, c.lastname].filter(Boolean).join(' ') || 'Roamer';
  const subtitle = [
    `Deal ${dealNumber}`,
    d.projected_delivery_date ? `Delivery ${shortDate(String(d.projected_delivery_date))}` : null,
    context.salesCoach ? `Sales Coach ${context.salesCoach}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const basis = basisLine(context);

  const record = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record`;
  const buttons = [link('Open deal in HubSpot', `${record}/0-3/${context.deal.id}`)];
  if (context.contact) buttons.push(link('Open Roamer in HubSpot', `${record}/0-1/${context.contact.id}`));

  const header = { title: name, subtitle };
  if (avatarUrl) Object.assign(header, { imageUrl: avatarUrl, imageType: 'CIRCLE', imageAltText: 'Basecamp' });

  return {
    fallbackText: `Roamer brief for deal ${dealNumber}: ${name}`,
    cardsV2: [
      {
        cardId: `brief-${dealNumber}`,
        card: {
          header,
          sections: [
            summarySection(brief),
            itemSection('Wow', COLORS.wow, brief.wow),
            modsSection(brief.mods || []),
            itemSection('Journey', COLORS.journey, brief.journey),
            {
              widgets: [
                { textParagraph: { text: `<font color="${COLORS.muted}">${escape(basis)}</font>` } },
                { buttonList: { buttons } },
              ],
            },
          ],
        },
      },
    ],
  };
}

module.exports = { renderBriefCard, renderContactChoice, HUBSPOT_PORTAL_ID, VISIBLE_ROWS, COLORS };
