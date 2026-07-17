#!/usr/bin/env node
/* CATALOG-DELTA-001 P3 — extract the Universal Reporting Catalog from Brand Reference v8
 * (the catalog of record) into a machine-readable manifest for the portal Gallery and
 * War Room Canvas. Counts live in generators: this file IS the count authority.
 * Run: node generate-catalog-manifest.js  → resources/catalog-manifest.json
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'resources/SaSMaster_Brand_Reference_v8.html'), 'utf8');
// split-based: each segment runs to the next cat-card open (nested divs defeat lazy regex)
const cards = html.split('<div class="cat-card">').slice(1);
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

const entries = cards.map((c) => {
  const g = (re) => { const m = c.match(re); return m ? strip(m[1]) : null; };
  const id = g(/<div class="cat-id">([\s\S]*?)<\/div>/);
  const desc = g(/<div class="cat-desc">([\s\S]*?)<\/div>/) || '';
  return {
    id,
    name: g(/<div class="cat-name">([\s\S]*?)<\/div>/),
    family: g(/<div class="cat-family[^>]*">([\s\S]*?)<\/div>/),
    description: desc,
    chart_library: g(/<span class="cat-lib[^>]*">([\s\S]*?)<\/span>/),
    tags: [...c.matchAll(/<span class="cat-tag[^>]*">([\s\S]*?)<\/span>/g)].map((m) => strip(m[1])),
    gating: /pending-source/.test(desc) ? 'pending-source'
      : /REVIEW REQUIRED/.test(desc) ? 'licensing-review'
      : /gap card/i.test(desc) ? 'gap-carded' : 'live',
  };
}).filter((e) => e.id);

const byFamily = {};
for (const e of entries) byFamily[e.family] = (byFamily[e.family] || 0) + 1;

const out = {
  generated_at: new Date().toISOString(),
  source: 'resources/SaSMaster_Brand_Reference_v8.html (catalog of record)',
  generator: 'generate-catalog-manifest.js',
  total_entries: entries.length,
  by_family: byFamily,
  entries,
};
fs.writeFileSync(path.join(__dirname, 'resources/catalog-manifest.json'), JSON.stringify(out, null, 1));
console.log(`catalog-manifest.json: ${entries.length} entries`, byFamily);
