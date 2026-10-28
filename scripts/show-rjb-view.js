'use strict';

// Prints the RJB view of a saved deal lookup and how much it shrank.
// Usage: node scripts/show-rjb-view.js [path-to-lookup.json]

const fs = require('fs');
const path = require('path');
const { toRjbView } = require('../src/lightspeed/rjbView');

const file = process.argv[2] || path.join(__dirname, '..', 'test', 'fixtures', 'deal-lookup-sample.json');
const raw = fs.readFileSync(file, 'utf8');
const out = JSON.stringify(toRjbView(JSON.parse(raw)), null, 2);

// Rough token estimate: about 4 characters per token for JSON.
const tokens = (s) => Math.round(s.length / 4);

console.log(out);
console.log(`\nraw:  ${raw.length.toLocaleString()} chars, ~${tokens(raw).toLocaleString()} tokens`);
console.log(`view: ${out.length.toLocaleString()} chars, ~${tokens(out).toLocaleString()} tokens`);
