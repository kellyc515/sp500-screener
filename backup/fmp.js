/**
 * Financial Modeling Prep adapter.
 * Supplies fundamentals (as a fallback behind SEC) and price/returns (primary,
 * since no free source in this project covers those yet).
 *
 * RETIRED TO BACKUP on 2026-08-10. FMP was quota-exhausted on every run since
 * Phase 1.3 introduced SEC/Finnhub as primary sources - across weeks of runs
 * it contributed zero real field values (its one call per run consistently
 * hit a 429 and got disabled for the rest of the run). fetchData.js no longer
 * imports this file or requires FMP_API_KEY.
 *
 * To re-enable (e.g. after adding a paid FMP tier):
 *   1. Move this file back to providers/fmp.js
 *   2. In fetchData.js: re-add `const fmp = require('./providers/fmp');`,
 *      the MAX_FMP_REFRESHES_PER_RUN constant, the fmpBudget object +
 *      fmpBudgetAvailable(), and the FMP gap-check/fallback branches in
 *      fetchFundamentals() and fetchValuation() (see git history / the
 *      conversation that added Phase 1.3-1.4 for the exact branches, or
 *      reconstruct: call fmp.fetchFundamentals()/fmp.fetchPriceChange() only
 *      for fields SEC/Finnhub left null, gated by a per-run call budget).
 *   3. Add fmp back to the [sec, finnhub, ...] health-print loop and the
 *      startup FMP_API_KEY check in fetchData.js.
 *   4. Uncomment FMP_API_KEY in .env.example and set a real key in .env.
 */

const { createHttpClient } = require('./httpClient');

const FMP_BASE = 'https://financialmodelingprep.com/stable';

// Any FMP 429 has consistently meant daily-quota exhaustion in this project,
// not a burst limit - so there's no point retrying it.
const client = createHttpClient({ name: 'fmp', pacingMs: 1100, maxAttempts: 1, treatAny429AsQuota: true });

const key = () => process.env.FMP_API_KEY;
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

function pick(obj, candidates) {
  for (const k of candidates) {
    if (obj[k] !== undefined && obj[k] !== null) return num(obj[k]);
  }
  return null;
}

// FMP's ratios endpoint has returned ROE as either a decimal fraction (0.28)
// or a percentage number (28) depending on endpoint version. Treat anything
// with |value| < 5 as a fraction and scale it up, since no real company has
// an ROE between -500% and +500% expressed as a whole-number percent below 5.
function normalizeRoe(v) {
  if (v === null) return null;
  return Math.abs(v) < 5 ? +(v * 100).toFixed(2) : +v.toFixed(2);
}

async function fetchProfile(sym) {
  const r = await client.getJSON(FMP_BASE + '/profile?symbol=' + sym + '&apikey=' + key(), sym + ' profile');
  if (!r.ok) return {};
  const p = Array.isArray(r.data) ? r.data[0] : null;
  if (!p) return {};
  return { name: p.companyName || null, sector: p.sector || null, beta: num(p.beta) };
}

async function fetchRatios(sym) {
  const r = await client.getJSON(FMP_BASE + '/ratios?symbol=' + sym + '&apikey=' + key(), sym + ' ratios');
  if (!r.ok) return {};
  const arr = Array.isArray(r.data) ? r.data : [];
  if (!arr.length) return {};
  const latest = [...arr].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  return {
    pe: pick(latest, ['priceToEarningsRatio', 'peRatio', 'priceEarningsRatioTTM', 'peRatioTTM']),
    pb: pick(latest, ['priceToBookRatio', 'pbRatio', 'priceToBookRatioTTM']),
    roe: normalizeRoe(pick(latest, ['returnOnEquity', 'roe', 'returnOnEquityTTM'])),
    debtEquity: pick(latest, ['debtToEquityRatio', 'debtEquityRatio', 'debtEquityRatioTTM']),
  };
}

async function fetchFundamentals(sym) {
  const profile = await fetchProfile(sym);
  const ratios = await fetchRatios(sym);
  return { ...profile, ...ratios };
}

async function fetchPriceChange(sym) {
  const r = await client.getJSON(FMP_BASE + '/stock-price-change?symbol=' + sym + '&apikey=' + key(), sym + ' price-change');
  if (!r.ok) return {};
  const o = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!o) return {};
  return { ret3m: num(o['3M']), ret6m: num(o['6M']) };
}

module.exports = {
  name: 'fmp',
  health: client.health,
  fetchFundamentals,
  fetchPriceChange,
};
