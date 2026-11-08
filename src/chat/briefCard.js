'use strict';

// Renders a Roamer brief as a Google Chat card (cards v2), as Blake approved it
// (2026-11-07): a header with the Roamer and deal, then five sections, Who they are, What
// excites them, Journey so far, Open questions, and Mods, then outlined buttons into
// HubSpot. No dates or channels on the card; the HubSpot note keeps each item's source.
// Card text supports a small HTML subset, so all record text is escaped first.

const { noDashes, shortDate } = require('../agents/roamerBrief');
const { secondary, label } = require('./style');

// HubSpot portal for rvsofamerica.com, used to build record links.
const HUBSPOT_PORTAL_ID = '39605104';

// Mods shown before "Show more".
const VISIBLE_ROWS = 5;

const MOD_STATUS = {
  approved: { icon: 'check_circle', label: 'Approved' },
  pending: { icon: 'schedule', label: 'Pending' },
  interested: { icon: 'lightbulb', label: 'Interested' },
  declined: { icon: 'cancel', label: 'Declined' },
};

function escape(text) {
  return noDashes(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const paragraph = (text) => ({ textParagraph: { text } });
const none = (text) => paragraph(`<i>${text}</i>`);
const bullets = (lines) => paragraph(lines.map((l) => `• ${escape(l)}`).join('<br>'));

// Who they are, with the tags under it as chips.
function whoSection(brief) {
  const widgets = [brief.who ? paragraph(escape(brief.who)) : none('Not enough in the record yet.')];
  const tags = (brief.tags || []).slice(0, 5);
  if (tags.length) widgets.push({ chipList: { chips: tags.map((t) => ({ label: noDashes(t) })) } });
  return { header: label('Who they are'), widgets };
}

function listSection(title, lines, empty) {
  return { header: label(title), widgets: [lines && lines.length ? bullets(lines) : none(empty)] };
}

function textSection(title, text, empty) {
  return { header: label(title), widgets: [text ? paragraph(escape(text)) : none(empty)] };
}

// Mods heard in conversation, each with its status. They are not yet checked against
// the deal in LightSpeed, and the section says so.
function modsSection(mods) {
  const header = label('Mods');
  const caveat = none('From conversations; not yet checked against the deal in LightSpeed.');
  if (!mods.length) return { header, widgets: [none('No mods discussed yet.')] };
  const widgets = mods.map((m) => {
    const status = MOD_STATUS[m.status] || MOD_STATUS.interested;
    const price = m.price && m.price.trim() ? ` · ${escape(m.price.trim())}` : '';
    return {
      decoratedText: {
        startIcon: { materialIcon: { name: status.icon } },
        text: `${escape(m.name)}${price}`,
        bottomLabel: status.label,
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

const link = (text, url) => secondary(text, { openLink: { url } });

// Asked when a deal has more than one contact: one button per contact, and the tapped one
// is read as the Roamer. The button carries the contact ID; Basecamp checks it is still on
// the deal before reading anything.
function renderContactChoice({ dealNumber, store, choices, contactCount, endpoint }) {
  const shown = contactCount > choices.length ? ` (the first ${choices.length} are shown)` : '';
  const buttons = choices.map((c) => ({
    text: noDashes(c.name).slice(0, 60),
    type: 'OUTLINED',
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

  const record = `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record`;
  const buttons = [link('Open deal', `${record}/0-3/${context.deal.id}`)];
  if (context.contact) buttons.push(link('Open Roamer', `${record}/0-1/${context.contact.id}`));
  // The deal's Delivery record (the custom object 2-59426991), once the deal has one.
  if (context.deliveryId) buttons.push(link('Open Delivery', `${record}/2-59426991/${context.deliveryId}`));

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
            whoSection(brief),
            listSection('What excites them', brief.excites, 'Nothing yet in the record.'),
            textSection('Journey so far', brief.journey_summary, 'Nothing yet in the record.'),
            listSection('Open questions', brief.open_questions, 'None open in the record.'),
            modsSection(brief.mods || []),
            // No source counts or timestamps here: Blake keeps the card to what the team acts on.
            { widgets: [{ buttonList: { buttons } }] },
          ],
        },
      },
    ],
  };
}

module.exports = { renderBriefCard, renderContactChoice, HUBSPOT_PORTAL_ID, VISIBLE_ROWS };
