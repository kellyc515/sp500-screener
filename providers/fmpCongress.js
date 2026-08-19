/**
 * Financial Modeling Prep congressional-trading adapter.
 * Supplies recent Senate/House stock trade disclosures - a self-contained,
 * purely display-only dataset that never feeds scoring.
 *
 * Two bulk calls per run (senate-latest + house-latest, page=0 - the only
 * page allowed on the free tier), not a per-ticker call, so this is nowhere
 * near the 250/day free quota that sank the old per-ticker FMP fundamentals
 * integration (see backup/fmp.js). Page 0 returns the newest ~100
 * disclosures per chamber (roughly the last 1-2 weeks); fetchData.js
 * accumulates + dedupes these into cache/congressTrades.json across runs so
 * coverage builds up over time without needing paid pagination.
 */

const { createHttpClient } = require('./httpClient');

const FMP_BASE = 'https://financialmodelingprep.com/stable';

const client = createHttpClient({ name: 'fmp-congress', pacingMs: 1100, maxAttempts: 1, treatAny429AsQuota: true });

const key = () => process.env.FMP_API_KEY;

// A single PTR filing can list several transactions (different tickers, or
// the same ticker bought and sold on different dates), and can share one
// `link` across all of them - so the dedup id is the full row shape, not
// just the link.
function normalizeRecord(raw, chamber) {
  const ticker = String(raw.symbol || '').trim().toUpperCase();
  const transactionDate = raw.transactionDate || null;
  const link = raw.link || null;
  if (!ticker || !transactionDate || !link) return null;

  const member = [raw.firstName, raw.lastName].filter(Boolean).join(' ').trim() || raw.office || null;
  if (!member) return null;

  const type = raw.type || null;
  const amount = raw.amount || null;

  return {
    id: [link, ticker, transactionDate, type, amount].join('|'),
    chamber,
    ticker,
    member,
    district: raw.district || null,
    assetDescription: raw.assetDescription || null,
    type,
    amount,
    transactionDate,
    disclosureDate: raw.disclosureDate || null,
    link,
  };
}

async function fetchLatest(chamber) {
  const endpoint = chamber === 'Senate' ? 'senate-latest' : 'house-latest';
  const url = FMP_BASE + '/' + endpoint + '?page=0&apikey=' + key();
  const r = await client.getJSON(url, chamber + ' latest trades');
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.map((raw) => normalizeRecord(raw, chamber)).filter(Boolean);
}

async function fetchAllLatest() {
  const senate = await fetchLatest('Senate');
  const house = await fetchLatest('House');
  return [...senate, ...house];
}

module.exports = {
  name: 'fmp-congress',
  health: client.health,
  fetchAllLatest,
};
