'use strict';

// The WOW idea library `/wow` tailors from, and the list of what ROA does at every delivery
// (never suggested as a WOW). Kept in a Google Sheet the team edits ("ROA WOW Ideas",
// WOW_SHEET_ID): the Ideas tab has Idea (general, no names), Fits when, Kind, Tier, Active,
// Times used, Added by; the "Standard at every delivery" tab lists the baseline. Basecamp
// reads both on every `/wow`, adds 1 to Times used when an idea is chosen, and adds a row
// when a new idea it suggested is chosen. Without a sheet it falls back to the database
// library and the standards in agents/wowPlan.js. No Roamer details are ever written here.

const { GoogleAuth } = require('google-auth-library');
const { safeError } = require('./errors');
const { STARTER_IDEAS, STANDARD_AT_DELIVERY } = require('./agents/wowPlan');

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const IDEAS = 'Ideas';
const STANDARDS = 'Standard at every delivery';
const q = (tab) => `'${tab.replace(/'/g, "''")}'`;

// `sheetId` is the spreadsheet's id; `auth` a GoogleAuth with the spreadsheets scope.
function createSheetLibrary({ sheetId, auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) }) {
  if (!/^[\w-]{20,}$/.test(sheetId || '')) throw safeError('WOW sheet id looks wrong');
  const base = `${API}/${sheetId}/values`;
  async function call(method, url, data) {
    const client = await auth.getClient();
    const res = await client.request({ url, method, data });
    return res.data;
  }

  // Active ideas, most used first. An idea's id is its row ("row-5") when it was read; a
  // chosen idea is found again by its words before it is counted (useIdea).
  async function listIdeas() {
    const data = await call('GET', `${base}/${encodeURIComponent(`${q(IDEAS)}!A2:G`)}`);
    return (data.values || [])
      .map((r, i) => ({ id: `row-${i + 2}`, idea: (r[0] || '').trim(), fitsWhen: (r[1] || '').trim(), category: (r[2] || '').trim(), tier: (r[3] || '').trim(), active: !/^no$/i.test((r[4] || '').trim()), uses: Number(r[5]) || 0, addedBy: r[6] || '' }))
      .filter((i) => i.idea && i.active)
      .sort((a, b) => b.uses - a.uses);
  }

  async function standards() {
    const data = await call('GET', `${base}/${encodeURIComponent(`${q(STANDARDS)}!A2:A`)}`);
    return (data.values || []).map((r) => (r[0] || '').trim()).filter(Boolean);
  }

  // A chosen library idea: Times used goes up by one. The team sorts, inserts, and deletes
  // rows, so the row is found again by the idea's words (`idea`) at the moment it is chosen:
  // the row it was on when suggested if that still holds it, else wherever it moved to. An
  // idea no longer in the sheet is added back as new. Without `idea` (a card drawn before
  // it was carried), the row number is trusted as before.
  async function useIdea({ ideaId, idea = '', fitsWhen = '', category = '', tier = '' }) {
    const m = /^row-(\d+)$/.exec(ideaId || '');
    if (!m) throw safeError('useIdea: invalid idea id');
    let row = Number(m[1]);
    const wanted = String(idea || '').trim().toLowerCase();
    if (wanted) {
      const rows = (await call('GET', `${base}/${encodeURIComponent(`${q(IDEAS)}!A2:A`)}`)).values || [];
      const at = (n) => String((rows[n - 2] || [])[0] || '').trim().toLowerCase();
      if (at(row) !== wanted) {
        const moved = rows.findIndex((r) => String(r[0] || '').trim().toLowerCase() === wanted);
        if (moved < 0) {
          await addIdea({ idea: String(idea).trim(), fitsWhen, category, tier });
          return null;
        }
        row = moved + 2;
      }
    }
    const cell = `${q(IDEAS)}!F${row}`;
    const now = await call('GET', `${base}/${encodeURIComponent(cell)}`);
    const uses = Number(((now.values || [])[0] || [])[0]) || 0;
    await call('PUT', `${base}/${encodeURIComponent(cell)}?valueInputOption=RAW`, { values: [[uses + 1]] });
    return `row-${row}`;
  }

  // A new idea Basecamp suggested and a Team Member chose: added for the team to see and refine.
  async function addIdea({ idea, fitsWhen, category, tier }) {
    await call('POST', `${base}/${encodeURIComponent(`${q(IDEAS)}!A:G`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      values: [[idea, fitsWhen || '', category, tier, 'Yes', 1, 'Basecamp']],
    });
  }

  return { listIdeas, standards, useIdea, addIdea, source: 'sheet' };
}

// The database library, for when no sheet is set.
function createDbLibrary({ db }) {
  return {
    listIdeas: () => db.listWowIdeas(STARTER_IDEAS),
    standards: async () => STANDARD_AT_DELIVERY,
    useIdea: ({ ideaId }) => db.useWowIdea({ ideaId }),
    addIdea: ({ idea, category, tier, by }) => db.useWowIdea({ ideaId: null, idea, category, tier, by }),
    source: 'database',
  };
}

module.exports = { createSheetLibrary, createDbLibrary };
