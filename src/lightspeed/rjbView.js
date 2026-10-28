'use strict';

// Compact "RJB view" of a LightSpeed deal lookup result.
// Input: the full lookup response ({ ok, result: { found: [ ... ] } }) or a single found[] entry.
// Output: the small object the RJB agent reads instead of the raw ~80 KB deal.

const STORES = {
  ROA1: 'Utah',
  ROA2: 'South Carolina',
  ROA3: 'Arizona',
  ROA4: 'Colorado',
};

const PDI_PATTERN = /\bPDI\b|pre-delivery/i;
const CHARGE_SALES_PATTERN = /charge\s*sales/i;

// LightSpeed uses 1000-01-01 as "no date".
function cleanDate(value) {
  if (!value || String(value).startsWith('1000-01-01')) return null;
  return String(value).slice(0, 10);
}

function cleanText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  return text.length ? text : null;
}

function repairOrder(line) {
  if (!line.RepairOrderNumber) return null;
  return { number: line.RepairOrderNumber, status: cleanText(line.rostatus) };
}

function laborLine(line) {
  const out = {
    title: cleanText(line.RepairOrderJobTitle) || cleanText(line.Description),
    description: cleanText(line.Description),
    price: Number(line.RetailPrice) || 0,
    repairOrder: repairOrder(line),
  };
  // RO status from LightSpeed is per repair order, not per job; a job-level status is not in the deal feed.
  if (!out.repairOrder) out.requestStatus = cleanText(line.rostatus);
  return out;
}

// Splits labor lines into mods (what the Roamer gets) and prep (PDI and its findings).
function classifyLabor(labor, flags) {
  const mods = [];
  const prep = [];

  for (const line of labor || []) {
    const type = cleanText(line.SetupInstall) || 'Unknown';
    const item = laborLine(line);
    const text = `${item.title || ''} ${item.description || ''}`;

    if (PDI_PATTERN.test(item.title || '')) {
      if (type !== 'Prep') {
        flags.push(`PDI line labeled "${type}" instead of Prep: "${item.title}"`);
      }
      if (!item.repairOrder) {
        flags.push(`PDI line not on a repair order (likely a leftover template line): "${item.title}"`);
        continue;
      }
      prep.push({ kind: 'PDI', ...item });
      continue;
    }

    if (type === 'Dealer Add' || type === 'Customer Add') {
      mods.push({ type, includedAtNoCharge: false, ...item });
    } else if (CHARGE_SALES_PATTERN.test(text)) {
      // "Charge sales" = a mod the Roamer would normally pay for, included to close the deal.
      mods.push({ type: 'Included', includedAtNoCharge: true, ...item });
    } else if (type === 'Prep') {
      prep.push({ kind: 'Finding', ...item });
    } else {
      mods.push({ type, includedAtNoCharge: false, ...item });
      flags.push(`Labor line with unrecognized type "${type}": "${item.title}"`);
    }

    if (!item.repairOrder) {
      flags.push(`Line not on a repair order yet: "${item.title}"`);
    }
  }

  const order = { 'Customer Add': 0, 'Dealer Add': 1, Included: 2 };
  mods.sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3));
  return { mods, prep };
}

function toRjbView(lookup) {
  const found = lookup && lookup.result ? (lookup.result.found || [])[0] : lookup;
  if (!found || !found.deal) {
    throw new Error('toRjbView: no deal found in lookup result');
  }

  const deal = found.deal;
  const unit = (deal.Units || [])[0] || {};
  const customer = found.customer || {};
  const flags = [];

  if ((deal.Units || []).length > 1) {
    flags.push(`Deal has ${deal.Units.length} units; only the first is shown`);
  }

  const { mods, prep } = classifyLabor(unit.Labor, flags);
  const dateReceived = cleanDate(unit.DateReceived);

  return {
    view: 'rjb',
    version: 1,
    deal: {
      dealNo: deal.DealNo,
      store: found.store || null,
      experienceCenter: STORES[found.store] || null,
      state: deal.dealstate,
      stage: deal.stagename,
      opened: cleanDate(deal.OriginatingDate),
      deliveryDate: cleanDate(deal.DeliveryDate),
      lastModified: deal.lastmodifieddate || null,
      salesCoach: cleanText(deal.SalesmanName),
      salesManager: cleanText(deal.salesmanager),
      source: cleanText(deal.source),
      deposit: Number(unit.deposit) || Number(deal.totaldownpayment) || 0,
      salesNotes: cleanText(deal.customerextraline),
      customerNotes: cleanText(deal.customernotes),
    },
    roamer: {
      name: cleanText(customer.CustFullName),
      firstName: cleanText(customer.FirstName),
      city: cleanText(customer.City),
      state: cleanText(customer.State),
    },
    unit: {
      year: unit.Year || null,
      make: cleanText(unit.Make),
      model: cleanText(unit.Model),
      type: cleanText(unit.unittype),
      newUsed: unit.Newused === 'N' ? 'New' : unit.Newused === 'U' ? 'Used' : cleanText(unit.Newused),
      stockNumber: cleanText(unit.stocknumber),
      vin: cleanText(unit.VIN),
      dateReceived,
      onLot: Boolean(dateReceived),
      daysInStore: unit.DaysInStore ?? null,
    },
    mods,
    prep,
    partsLineCount: (unit.Parts || []).length,
    flags,
  };
}

module.exports = { toRjbView };
