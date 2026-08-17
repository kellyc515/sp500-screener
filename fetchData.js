/**
 * STOCK SCREENER — DATA FETCHER (multi-source, cache-first, refresh-tiered)
 * Orchestrates the provider adapters in providers/, merges their fields into
 * a per-field-group cache, and writes companies.json for screener.js.
 * Run:  node fetchData.js   (then: node screener.js)
 *
 * Active providers: SEC (fundamentals) + Finnhub (valuation, analyst, news).
 * FMP was retired to backup/fmp.js on 2026-08-10 - see that file's header for
 * why and how to re-enable it. Not imported here anymore.
 */

const fs = require('fs');
const path = require('path');

/* ---- load .env (no dependency; shell-exported vars still win) ---- */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(path.join(__dirname, '.env'));

const finnhub = require('./providers/finnhub');
const sec = require('./providers/sec');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

const TICKER_DELAY_MS = 350;
const CACHE_DIR = path.join(__dirname, 'cache');
const UNIVERSE_PATH = path.join(__dirname, 'universe.json');

// Refresh tiers: how old a cached group can be before we bother calling a provider again.
const DAILY_MAX_AGE_MS = 20 * 60 * 60 * 1000;      // analyst, sentiment/news, price/returns, pe/pb/beta (price-derived)
const WEEKLY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // fundamentals: roe, debtEquity, sector, name

function loadUniverse() {
  if (!fs.existsSync(UNIVERSE_PATH)) {
    console.error('\n  universe.json not found. Build it first:');
    console.error('    node buildUniverse.js\n');
    process.exit(1);
  }
  let universe;
  try {
    universe = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
  } catch (err) {
    console.error('\n  universe.json is unreadable (' + err.message + '). Rebuild it:');
    console.error('    node buildUniverse.js\n');
    process.exit(1);
  }
  const tickers = Array.isArray(universe.constituents) ? universe.constituents.map((c) => c.ticker).filter(Boolean) : [];
  if (!tickers.length) {
    console.error('\n  universe.json has no constituents. Rebuild it:');
    console.error('    node buildUniverse.js\n');
    process.exit(1);
  }
  return tickers;
}

const TICKERS = loadUniverse();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

/* ---- cache: never let a failed request overwrite a good cached value ---- */
function readCache(name) {
  const file = path.join(CACHE_DIR, name);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('  ! cache/' + name + ' unreadable (' + err.message + ') - starting empty');
    return {};
  }
}

function writeCacheAtomic(name, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function mergeCacheEntry(cache, ticker, fields, source) {
  const entry = cache[ticker] || {};
  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    // The two display-only annual quality ratios deliberately overwrite with
    // null when a newer filing fails their strict economic-validity checks;
    // preserving an older numeric value would misrepresent it as current.
    const nullIsMeaningful = k === 'roic' || k === 'fcfConversion';
    if ((v === null || v === undefined) && !nullIsMeaningful) continue; // preserve existing null-protection for every established field
    entry[k] = v;
    changed = true;
  }
  if (changed) {
    entry.source = source;
    entry.updatedAt = nowISO();
  }
  cache[ticker] = entry;
  return entry;
}

function isFresh(entry, maxAgeMs) {
  if (!entry || !entry.updatedAt) return false;
  const age = Date.now() - new Date(entry.updatedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < maxAgeMs;
}

// Freshness gate for one cache group: serves the cached entry untouched (no network call)
// when it's still within maxAgeMs, otherwise calls fetchFn and merges the result. A failed
// fetchFn returns {} so mergeCacheEntry falls back to whatever was already cached, and does
// NOT bump updatedAt - so a failed refresh is correctly still "stale" next run, not falsely fresh.
async function refreshGroup(label, cache, ticker, maxAgeMs, fetchFn, source, stats, tickerLog) {
  const cached = cache[ticker];
  if (isFresh(cached, maxAgeMs)) {
    stats.cacheHits++;
    tickerLog.cached.push(label);
    return cached;
  }
  stats.fetchAttempts++;
  tickerLog.fetched.push(label);
  const fresh = await fetchFn(ticker);
  return mergeCacheEntry(cache, ticker, fresh, source);
}

/* ---- fundamentals (weekly): SEC-primary ---- */
// name/sector/roe/debtEquity only now - pe/pb/beta moved to the daily valuation
// group below since they're price-derived and price moves daily, not weekly.
const FUNDAMENTALS_FIELDS = ['name', 'sector', 'roe', 'debtEquity', 'roic', 'fcfConversion'];
// secEps/secBookValuePerShare ride along in the same weekly-cached entry purely
// as internal fallback inputs for fetchValuation() - never part of companies.json.
const FUNDAMENTALS_MERGE_FIELDS = [
  ...FUNDAMENTALS_FIELDS,
  'secEps',
  'secBookValuePerShare',
  'revenueGrowth',
  'epsGrowth',
  'fcfGrowth',
  'operatingMargin',
  'marginTrend',
  'annualOcf',
  'annualCapex',
  'annualFcf',
  'annualFcfPeriodStart',
  'annualFcfPeriodEnd',
  'sharesOutstanding',
  'sic',
  'roicAudit',
  'fcfConversionAudit',
];

// Daily, price-derived valuation fields (ret3m/ret6m/ret1y/pctBelow52wHigh
// included: Finnhub's 13/26/52-week returns and 52-week high come from the
// same /stock/metric call as beta/EPS).
const VALUATION_FIELDS = ['pe', 'pb', 'beta', 'ret3m', 'ret6m', 'ret1y', 'pctBelow52wHigh', 'evEbitda', 'fcfYield'];

// SIC 6000-6499 covers banks, credit institutions, securities brokers and
// insurers. Conventional enterprise value/EBITDA is not comparable for these
// businesses because financing is part of operations. REITs (notably SIC
// 6798) are intentionally not excluded.
function isExcludedFinancialInstitution(sic) {
  return Number.isInteger(sic) && sic >= 6000 && sic <= 6499;
}

const EBITDA_SERIES_MAX_AGE_MS = 200 * 24 * 60 * 60 * 1000;
const ANNUAL_FCF_MAX_AGE_MS = 550 * 24 * 60 * 60 * 1000;

function hasCurrentPositiveTtmEbitda(rows, nowMs = Date.now()) {
  if (!Array.isArray(rows) || rows.length < 4) return false;
  const latestFour = rows.slice(0, 4);
  const dates = latestFour.map((row) => new Date(row.period).getTime());
  const values = latestFour.map((row) => row.value);
  if (dates.some((v) => !Number.isFinite(v)) || values.some((v) => !Number.isFinite(v))) return false;
  if (new Set(dates).size !== 4) return false;
  if (dates[0] > nowMs + 14 * 24 * 60 * 60 * 1000 || nowMs - dates[0] > EBITDA_SERIES_MAX_AGE_MS) return false;

  const spanDays = (dates[0] - dates[3]) / (24 * 60 * 60 * 1000);
  if (spanDays < 200 || spanDays > 400) return false;
  for (let i = 0; i < 3; i++) {
    const gapDays = (dates[i] - dates[i + 1]) / (24 * 60 * 60 * 1000);
    if (gapDays < 45 || gapDays > 140) return false;
  }

  return values.reduce((sum, value) => sum + value, 0) > 0;
}

function mergeFields(keys, ...sources) {
  const out = {};
  for (const k of keys) {
    for (const src of sources) {
      if (src && src[k] !== null && src[k] !== undefined) {
        out[k] = src[k];
        break;
      }
    }
  }
  return out;
}

async function fetchFundamentals(sym) {
  const secFields = await sec.fetchFundamentals(sym);
  return mergeFields(FUNDAMENTALS_MERGE_FIELDS, secFields);
}

/* ---- valuation (daily): Finnhub-primary ---- */
// Live price x (Finnhub epsTTM / book-value-per-share) for pe/pb, Finnhub's
// own beta, and Finnhub's pre-computed 13/26-week returns for ret3m/ret6m -
// all from the two calls below. Where Finnhub's basic-financials call is
// missing eps/book-value, falls back to the SEC-derived figures already
// cached on this ticker's weekly fundamentals entry (zero extra SEC calls).
// Never fakes a ratio: missing/non-positive inputs stay null.
async function fetchValuation(sym, fundamentalsEntry) {
  const quote = await finnhub.fetchQuote(sym);
  if (quote.price === null || quote.price === undefined) return {}; // no live price - nothing to compute

  const metrics = await finnhub.fetchMetrics(sym);
  const eps = metrics.epsTTM ?? fundamentalsEntry.secEps ?? null;
  const bookValue = metrics.bookValuePerShare ?? fundamentalsEntry.secBookValuePerShare ?? null;

  // Percent below 52-week high: missing/non-positive high stays null (never
  // faked, same rule as every other ratio here). A stale high that's
  // somehow below the current live price would otherwise produce a negative
  // "percent below" - clamp to 0 rather than show that nonsense.
  let pctBelow52wHigh = null;
  if (metrics.week52High !== null && metrics.week52High !== undefined && metrics.week52High > 0) {
    const raw = ((metrics.week52High - quote.price) / metrics.week52High) * 100;
    pctBelow52wHigh = +Math.max(0, raw).toFixed(2);
  }

  let evEbitda = null;
  if (
    fundamentalsEntry.sic !== null &&
    fundamentalsEntry.sic !== undefined &&
    !isExcludedFinancialInstitution(fundamentalsEntry.sic) &&
    Number.isFinite(metrics.evEbitdaTTM) &&
    metrics.evEbitdaTTM > 0 &&
    metrics.evEbitdaTTM <= 200 &&
    Number.isFinite(metrics.ebitdPerShareTTM) &&
    metrics.ebitdPerShareTTM > 0 &&
    hasCurrentPositiveTtmEbitda(metrics.quarterlyEbitda)
  ) {
    evEbitda = metrics.evEbitdaTTM;
  }

  let fcfYield = null;
  const calculatedMarketCapitalization = Number.isFinite(fundamentalsEntry.sharesOutstanding) &&
    fundamentalsEntry.sharesOutstanding > 0 && Number.isFinite(quote.price) && quote.price > 0
    ? quote.price * fundamentalsEntry.sharesOutstanding
    : null;
  const finnhubMarketCapitalization = Number.isFinite(metrics.marketCapitalization) && metrics.marketCapitalization > 0
    ? metrics.marketCapitalization * 1e6
    : null;
  const marketCapComparisonRatio = calculatedMarketCapitalization !== null && finnhubMarketCapitalization !== null
    ? calculatedMarketCapitalization / finnhubMarketCapitalization
    : null;
  const marketCapsConsistent = Number.isFinite(marketCapComparisonRatio) &&
    marketCapComparisonRatio >= 0.75 && marketCapComparisonRatio <= 1.25;
  const annualFcfPeriodMs = new Date(fundamentalsEntry.annualFcfPeriodEnd).getTime();
  const annualFcfCurrent = Number.isFinite(annualFcfPeriodMs) &&
    annualFcfPeriodMs <= Date.now() + 14 * 24 * 60 * 60 * 1000 &&
    Date.now() - annualFcfPeriodMs <= ANNUAL_FCF_MAX_AGE_MS;
  if (
    Number.isFinite(fundamentalsEntry.annualFcf) &&
    annualFcfCurrent &&
    !isExcludedFinancialInstitution(fundamentalsEntry.sic) &&
    Number.isFinite(fundamentalsEntry.sharesOutstanding) &&
    fundamentalsEntry.sharesOutstanding > 0 &&
    marketCapsConsistent
  ) {
    const equityMarketValue = calculatedMarketCapitalization;
    if (Number.isFinite(equityMarketValue) && equityMarketValue > 0) {
      fcfYield = +((fundamentalsEntry.annualFcf / equityMarketValue) * 100).toFixed(4);
    }
  }

  return {
    pe: eps !== null && eps > 0 ? +(quote.price / eps).toFixed(2) : null,
    pb: bookValue !== null && bookValue > 0 ? +(quote.price / bookValue).toFixed(2) : null,
    beta: metrics.beta ?? null,
    ret3m: metrics.ret3m ?? null,
    ret6m: metrics.ret6m ?? null,
    ret1y: metrics.ret1y ?? null,
    pctBelow52wHigh,
    evEbitda,
    fcfYield,
    // Internal audit trail only; none of these fields enter companies.json.
    annualOcf: fundamentalsEntry.annualOcf ?? null,
    annualCapex: fundamentalsEntry.annualCapex ?? null,
    annualFcfPeriodStart: fundamentalsEntry.annualFcfPeriodStart ?? null,
    annualFcfPeriodEnd: fundamentalsEntry.annualFcfPeriodEnd ?? null,
    secSharesOutstanding: fundamentalsEntry.sharesOutstanding ?? null,
    calculatedMarketCapitalization,
    finnhubMarketCapitalization,
    marketCapComparisonRatio,
    // Not part of companies.json's 21-field output (pe/pb/ret1y/pctBelow52wHigh
    // already derive from it) - cached here purely so the report's detail
    // panel can show a real, timestamped price without a live browser-side
    // fetch (see conversation).
    price: quote.price,
  };
}

/* ---- run ---- */
async function main() {
  if (!FINNHUB_KEY) {
    console.error('\n  Missing API key. Set it in .env (see .env.example):');
    console.error('    FINNHUB_API_KEY=your_finnhub_key\n');
    process.exit(1);
  }

  const fundamentalsCache = readCache('fundamentals.json'); // name, sector, roe, debtEquity (+ secEps/secBookValuePerShare)
  const quoteCache = readCache('quote.json');                // pe, pb, beta, ret3m, ret6m
  const analystCache = readCache('analyst.json');             // analyst
  const newsCache = readCache('news.json');                   // sentiment

  const companies = [];
  const stats = {
    fundamentals: { cacheHits: 0, fetchAttempts: 0 },
    quote: { cacheHits: 0, fetchAttempts: 0 },
    analyst: { cacheHits: 0, fetchAttempts: 0 },
    news: { cacheHits: 0, fetchAttempts: 0 },
  };
  console.log('\n  Fetching ' + TICKERS.length + ' tickers...\n');

  for (const sym of TICKERS) {
    const tickerLog = { cached: [], fetched: [] };

    const fundamentals = await refreshGroup('fundamentals', fundamentalsCache, sym, WEEKLY_MAX_AGE_MS, fetchFundamentals, 'sec', stats.fundamentals, tickerLog);
    const quote = await refreshGroup('quote', quoteCache, sym, DAILY_MAX_AGE_MS, (t) => fetchValuation(t, fundamentals), 'finnhub', stats.quote, tickerLog);
    const analystEntry = await refreshGroup('analyst', analystCache, sym, DAILY_MAX_AGE_MS, finnhub.fetchAnalyst, 'finnhub', stats.analyst, tickerLog);
    const newsEntry = await refreshGroup('news', newsCache, sym, DAILY_MAX_AGE_MS, finnhub.fetchSentiment, 'finnhub', stats.news, tickerLog);

    const tag = [
      tickerLog.cached.length ? 'cache: ' + tickerLog.cached.join(',') : null,
      tickerLog.fetched.length ? 'fetch: ' + tickerLog.fetched.join(',') : null,
    ].filter(Boolean).join('  ');
    console.log('  - ' + sym + (tag ? '   (' + tag + ')' : ''));

    companies.push({
      ticker: sym,
      name: fundamentals.name || sym,
      sector: fundamentals.sector || 'Unknown',
      pe: quote.pe ?? null,
      pb: quote.pb ?? null,
      ret3m: quote.ret3m ?? null,
      ret6m: quote.ret6m ?? null,
      ret1y: quote.ret1y ?? null,
      pctBelow52wHigh: quote.pctBelow52wHigh ?? null,
      evEbitda: quote.evEbitda ?? null,
      fcfYield: quote.fcfYield ?? null,
      roe: fundamentals.roe ?? null,
      debtEquity: fundamentals.debtEquity ?? null,
      roic: fundamentals.roic ?? null,
      fcfConversion: fundamentals.fcfConversion ?? null,
      revenueGrowth: fundamentals.revenueGrowth ?? null,
      epsGrowth: fundamentals.epsGrowth ?? null,
      fcfGrowth: fundamentals.fcfGrowth ?? null,
      operatingMargin: fundamentals.operatingMargin ?? null,
      marginTrend: fundamentals.marginTrend ?? null,
      sentiment: newsEntry.sentiment ?? null,
      analyst: analystEntry.analyst ?? null,
      beta: quote.beta ?? null,
    });

    // write after every ticker so an interrupted run doesn't lose already-fetched data
    writeCacheAtomic('fundamentals.json', fundamentalsCache);
    writeCacheAtomic('quote.json', quoteCache);
    writeCacheAtomic('analyst.json', analystCache);
    writeCacheAtomic('news.json', newsCache);

    await sleep(TICKER_DELAY_MS);
  }

  const outPath = path.join(__dirname, 'companies.json');
  fs.writeFileSync(outPath, JSON.stringify(companies, null, 2));

  const withValuation = companies.filter((c) => c.pe !== null || c.pb !== null || c.beta !== null).length;
  const withFullValuation = companies.filter((c) => c.pe !== null && c.pb !== null && c.beta !== null).length;
  const withReturns = companies.filter((c) => c.ret3m !== null || c.ret6m !== null).length;
  const withFullReturns = companies.filter((c) => c.ret3m !== null && c.ret6m !== null).length;
  const secFundamentals = companies.filter((c) => c.roe !== null || c.debtEquity !== null).length;
  console.log('\n  Wrote ' + companies.length + ' companies -> ' + outPath);
  console.log('  (' + secFundamentals + ' have roe/debtEquity, ' + withValuation + ' have at least one of pe/pb/beta (' + withFullValuation + ' all three), '
    + withReturns + ' have at least one of ret3m/ret6m (' + withFullReturns + ' both))');

  console.log('\n  Provider health:');
  for (const p of [sec, finnhub]) {
    const h = p.health;
    console.log('  ' + p.name.padEnd(9) + h.state + (h.detail ? ' (' + h.detail + ')' : ''));
  }

  console.log('\n  Refresh summary (' + TICKERS.length + ' tickers):');
  const fmtStat = (label, tierHours, s) =>
    '  ' + label.padEnd(13) + 'cache: ' + String(s.cacheHits).padStart(2) +
    '   fetched: ' + String(s.fetchAttempts).padStart(2) +
    '   (max age ' + tierHours + 'h)';
  console.log(fmtStat('fundamentals', Math.round(WEEKLY_MAX_AGE_MS / 3600000), stats.fundamentals));
  console.log(fmtStat('quote', Math.round(DAILY_MAX_AGE_MS / 3600000), stats.quote));
  console.log(fmtStat('analyst', Math.round(DAILY_MAX_AGE_MS / 3600000), stats.analyst));
  console.log(fmtStat('news', Math.round(DAILY_MAX_AGE_MS / 3600000), stats.news));

  console.log('\n  Next:  node screener.js\n');
}

main().catch((err) => {
  console.error('\n  Fatal error: ' + err.message);
  process.exit(1);
});
