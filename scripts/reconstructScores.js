/**
 * POINT-IN-TIME COMPOSITE RECONSTRUCTION — standalone, not wired into
 * fetchData.js or .github/workflows/daily.yml. Run manually:
 *   node scripts/reconstructScores.js
 *
 * Rebuilds what screener.js's composite score WOULD have been on each
 * monthly rebalance date from 2024-10-01 through today, using only data
 * that was actually knowable on that date - so this can be backtested
 * without a look-ahead bug.
 *
 * Reuses the REAL scoring engine rather than reimplementing it:
 *   - scoreUniverse() is require()'d directly from screener.js (its
 *     require.main guard means main() never runs - see screener.js's own
 *     comment on that export). Percentile ranking, sector-relative
 *     grouping, bucket weighting, and shrink-toward-neutral are therefore
 *     GUARANTEED identical to the live system, not a reimplementation that
 *     could quietly drift from it.
 *   - Point-in-time SEC fundamentals come from providers/sec.js's
 *     deriveFundamentals(submissions, facts, { asOfMs }), which filters
 *     every fact to `filed <= asOfMs` before any of the live selection
 *     logic (period reconciliation, growth floors, debt reconciliation,
 *     etc.) ever sees it - see that file's 2026-09-22 additions for detail.
 *     Each ticker's raw submissions+companyfacts is fetched from SEC ONCE
 *     (cached to secfacts/<TICKER>.json) and re-derived in-memory for every
 *     rebalance date, since SEC's companyfacts response already contains a
 *     company's entire filing history.
 *
 * Two factors are EXCLUDED for every ticker on every date, per the
 * 2026-09-22 analysis: `sentiment` and `analyst` (Finnhub snapshot-only,
 * no historical archive). Since those are the Sentiment bucket's only two
 * metrics, that whole bucket (weight 0.10) is always null. `beta` (the
 * Risk bucket's only metric, weight 0.10) is excluded too, by decision -
 * Finnhub's live value is an undocumented-window black box that can't be
 * confidently reproduced from Polygon history alone. Structural ceiling on
 * every reconstructed composite's coverage: 1 - 0.10 - 0.10 = 0.80.
 *
 * Coverage threshold override (RECONSTRUCTION ONLY): screener.js's live
 * MAIN_SCORE_MIN_COVERAGE (0.80) is never imported or modified - this
 * script computes its own eligibility flag from scoreUniverse()'s exposed
 * compositeCoverage field, using 0.60 instead. Rationale: the two excluded
 * buckets are missing identically for every stock on every date (a
 * structural property of what's reconstructable, not a per-company data
 * gap), so gating at 0.80 would place every single reconstructed score
 * exactly on the eligibility line with zero margin - a per-company SEC
 * filing gap on top of that would then be indistinguishable from the
 * structural exclusion itself. `composite`'s NUMERIC VALUE is unaffected
 * either way (shrinkToNeutral scales continuously by actual coverage,
 * regardless of any threshold) - only which stocks this script calls
 * "eligible" changes.
 *
 * Tickers are included starting from prices/<TICKER>.json's first
 * available price date, excluded before it (see backfillPrices.js).
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const { scoreUniverse } = require(path.join(REPO_ROOT, 'screener.js'));
const sec = require(path.join(REPO_ROOT, 'providers', 'sec.js'));

const UNIVERSE_PATH = path.join(REPO_ROOT, 'universe.json');
const PRICES_DIR = path.join(REPO_ROOT, 'prices');
const SECFACTS_DIR = path.join(REPO_ROOT, 'secfacts'); // raw SEC cache, own dir - see below
const SCORES_DIR = path.join(REPO_ROOT, 'scores');

// secfacts/ and scores/ are deliberately NOT under cache/ - daily.yml's
// "Publish state" step rsyncs cache/ wholesale to origin/state on every
// live run, and this one-off backtest's raw SEC dumps + reconstructed
// scores have no business bloating that branch or mixing with the live
// pipeline's own state (same reasoning as backfillPrices.js's prices/).

const RECONSTRUCTION_START = '2024-10-01';
const EXCLUDED_BUCKETS = ['sentiment', 'risk'];
const EXCLUDED_BUCKET_WEIGHTS = { sentiment: 0.10, risk: 0.10 };
const STRUCTURAL_COVERAGE_CEILING = 1 - EXCLUDED_BUCKET_WEIGHTS.sentiment - EXCLUDED_BUCKET_WEIGHTS.risk; // 0.80

// Reconstruction-only override of screener.js's live MAIN_SCORE_MIN_COVERAGE
// (0.80) - see file header for why. screener.js itself is untouched.
const RECONSTRUCTION_MIN_COVERAGE = 0.60;

const DAY_MS = 24 * 60 * 60 * 1000;

function loadUniverse() {
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
  return Array.isArray(universe.constituents) ? universe.constituents.filter((c) => c && c.ticker) : [];
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Monthly rebalance dates: the 1st of every month from RECONSTRUCTION_START
// through the most recent month-start on or before today.
function monthlyRebalanceDates() {
  const dates = [];
  const start = new Date(RECONSTRUCTION_START + 'T00:00:00Z');
  const today = new Date();
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const limit = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  while (cursor.getTime() <= limit.getTime()) {
    dates.push(ymd(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return dates;
}

// Last bar dated on or before targetYmd. bars must be sorted ascending by
// date (backfillPrices.js's output already is). Returns null if every bar
// postdates the target (e.g. the trailing lookback for ret3m/ret6m reaches
// earlier than this ticker's earliest available price).
function priceOnOrBefore(bars, targetYmd) {
  let result = null;
  for (const bar of bars) {
    if (bar.date > targetYmd) break;
    result = bar;
  }
  return result;
}

function daysBeforeYmd(targetYmd, days) {
  const ms = new Date(targetYmd + 'T00:00:00Z').getTime() - days * DAY_MS;
  return ymd(new Date(ms));
}

// Approximate 13-week/26-week trailing returns from Polygon closes.
// NOTE: Finnhub's own '13WeekPriceReturnDaily'/'26WeekPriceReturnDaily'
// (what the live system actually uses) is an undocumented calculation -
// this is a best-effort analog (trailing 91/182 calendar days, nearest
// close on or before each endpoint), not a guaranteed match to Finnhub's
// exact methodology. Flagged in every output file's `methodologyNotes`.
function trailingReturn(bars, asOfYmd, lookbackDays) {
  const end = priceOnOrBefore(bars, asOfYmd);
  const start = priceOnOrBefore(bars, daysBeforeYmd(asOfYmd, lookbackDays));
  if (!end || !start || !(start.close > 0)) return null;
  return +(((end.close / start.close) - 1) * 100).toFixed(4);
}

async function fetchRawSecFacts(ticker) {
  const outPath = path.join(SECFACTS_DIR, ticker + '.json');
  if (fs.existsSync(outPath)) {
    try {
      return JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (err) {
      console.warn('  ! secfacts/' + ticker + '.json unreadable (' + err.message + ') - refetching');
    }
  }

  const map = await sec.ensureCikMap();
  const secTicker = ticker.toUpperCase().replace(/\./g, '-');
  const entry = map[secTicker] || map[ticker.toUpperCase()];
  if (!entry) return { submissions: null, facts: null, reason: 'not in SEC ticker/CIK map' };

  const [submissions, facts] = await Promise.all([
    sec.fetchSubmissions(entry.cik),
    sec.fetchCompanyFacts(entry.cik),
  ]);
  const raw = { submissions, facts };
  writeJsonAtomic(outPath, raw);
  return raw;
}

// One ticker's reconstructed inputs for one rebalance date. Returns null
// fields (never fabricated placeholders) for anything unavailable as of D.
function buildTickerRecord(constituent, rawFacts, priceData, asOfYmd) {
  const asOfMs = new Date(asOfYmd + 'T23:59:59Z').getTime(); // end of day D - includes filings dated D itself

  const derived = rawFacts.facts
    ? sec.deriveFundamentals(rawFacts.submissions, rawFacts.facts, { asOfMs })
    : {};

  const bars = (priceData && priceData.bars) || [];
  const priceBar = priceOnOrBefore(bars, asOfYmd);
  const price = priceBar ? priceBar.close : null;

  const pe = price !== null && derived.secEps > 0 ? +(price / derived.secEps).toFixed(2) : null;
  const pb = price !== null && derived.secBookValuePerShare > 0 ? +(price / derived.secBookValuePerShare).toFixed(2) : null;
  const ret3m = trailingReturn(bars, asOfYmd, 91);
  const ret6m = trailingReturn(bars, asOfYmd, 182);

  return {
    ticker: constituent.ticker,
    name: derived.name || constituent.name || constituent.ticker,
    sector: derived.sector || constituent.sector || 'Unknown',
    pe,
    pb,
    ret3m,
    ret6m,
    roe: derived.roe ?? null,
    debtEquity: derived.debtEquity ?? null,
    revenueGrowth: derived.revenueGrowth ?? null,
    epsGrowth: derived.epsGrowth ?? null,
    fcfGrowth: derived.fcfGrowth ?? null,
    operatingMargin: derived.operatingMargin ?? null,
    marginTrend: derived.marginTrend ?? null,
    // Always null: unreconstructable (sentiment/analyst) or excluded by
    // decision (beta) - see file header. Present so scoreUniverse() and
    // any downstream consumer see an explicit, deliberate null, not a
    // silently missing field.
    sentiment: null,
    analyst: null,
    beta: null,
    // Point-in-time inputs, kept for audit - not part of companies.json's
    // live contract, but useful to see exactly what fed pe/pb here.
    priceAsOf: priceBar ? priceBar.date : null,
    secEpsAsOf: derived.secEps ?? null,
    secBookValuePerShareAsOf: derived.secBookValuePerShare ?? null,
  };
}

async function reconstructDate(asOfYmd, constituents, rawFactsByTicker, priceByTicker) {
  const eligible = constituents.filter((c) => {
    const p = priceByTicker[c.ticker];
    return p && p.earliestReturned && p.earliestReturned <= asOfYmd;
  });

  const companies = eligible.map((c) =>
    buildTickerRecord(c, rawFactsByTicker[c.ticker] || {}, priceByTicker[c.ticker], asOfYmd)
  );

  const scored = scoreUniverse(companies); // no turnaround baseline - same precedent as research.js's call

  let shrunkCount = 0;
  let eligibleCount = 0;
  let coverageSum = 0;
  let coverageCount = 0;

  const tickers = {};
  for (const c of scored) {
    const coverage = c.compositeCoverage || 0;
    const reconstructedEligible = coverage >= RECONSTRUCTION_MIN_COVERAGE;
    const shrunkBelowStructuralCeiling = coverage < STRUCTURAL_COVERAGE_CEILING - 1e-9;
    if (reconstructedEligible) eligibleCount++;
    if (shrunkBelowStructuralCeiling) shrunkCount++;
    if (coverage > 0) { coverageSum += coverage; coverageCount++; }

    tickers[c.ticker] = {
      composite: c.composite,
      compositeRaw: c.compositeRaw,
      compositeCoverage: coverage,
      reconstructedEligible,
      shrunkBelowStructuralCeiling,
      bucketScores: c.bucketScores,
      metricScores: c.metricScores,
      inputs: {
        pe: c.pe, pb: c.pb, roe: c.roe, debtEquity: c.debtEquity,
        revenueGrowth: c.revenueGrowth, epsGrowth: c.epsGrowth, fcfGrowth: c.fcfGrowth,
        operatingMargin: c.operatingMargin, marginTrend: c.marginTrend,
        ret3m: c.ret3m, ret6m: c.ret6m,
        priceAsOf: c.priceAsOf,
      },
    };
  }

  return {
    date: asOfYmd,
    generatedAt: new Date().toISOString(),
    excludedBuckets: EXCLUDED_BUCKETS,
    excludedBucketWeights: EXCLUDED_BUCKET_WEIGHTS,
    structuralCoverageCeiling: STRUCTURAL_COVERAGE_CEILING,
    reconstructionMinCoverage: RECONSTRUCTION_MIN_COVERAGE,
    liveMinCoverageForComparison: 0.80, // screener.js's own MAIN_SCORE_MIN_COVERAGE, unmodified - shown for context only
    methodologyNotes: [
      'Fundamentals (roe, debtEquity, operatingMargin, marginTrend, revenueGrowth, epsGrowth, fcfGrowth, secEps, secBookValuePerShare) selected from SEC XBRL facts with filed <= this date, mirroring providers/sec.js live selection logic exactly (same function, deriveFundamentals()).',
      'pe/pb computed from a Polygon close on or before this date divided by the point-in-time SEC EPS/book-value-per-share above - never a Finnhub live snapshot.',
      'ret3m/ret6m are a best-effort 91-day/182-day trailing-return analog from Polygon closes, not a guaranteed match to Finnhub\'s own undisclosed 13-week/26-week calculation.',
      'sentiment and analyst are always null (Finnhub snapshot-only, no historical archive). beta is always null (excluded by decision - see script header).',
    ],
    universeSize: constituents.length,
    eligibleTickerCount: eligible.length,
    reconstructionEligibleCount: eligibleCount,
    shrunkBelowStructuralCeilingCount: shrunkCount,
    meanCompositeCoverage: coverageCount ? +(coverageSum / coverageCount).toFixed(4) : null,
    tickers,
  };
}

async function main() {
  const constituents = loadUniverse();
  console.log('\n  Universe: ' + constituents.length + ' tickers\n');

  // Phase 1: ensure every ticker's raw SEC facts are fetched (resumable -
  // secfacts/<TICKER>.json existing is the "already done" marker, same
  // pattern as backfillPrices.js's prices/<TICKER>.json).
  console.log('  Phase 1: fetching raw SEC submissions + companyfacts (once per ticker)...\n');
  const rawFactsByTicker = {};
  let fetched = 0, cachedCount = 0, missing = 0;
  for (const c of constituents) {
    const before = fs.existsSync(path.join(SECFACTS_DIR, c.ticker + '.json'));
    const raw = await fetchRawSecFacts(c.ticker);
    rawFactsByTicker[c.ticker] = raw;
    if (!raw.facts) { missing++; console.log('  - ' + c.ticker + '   no SEC data (' + (raw.reason || 'missing companyfacts') + ')'); }
    else if (before) cachedCount++;
    else { fetched++; console.log('  - ' + c.ticker + '   fetched'); }
  }
  console.log('\n  Phase 1 done: ' + fetched + ' fetched, ' + cachedCount + ' already cached, ' + missing + ' unavailable\n');

  // Phase 2: load prices/<TICKER>.json (from backfillPrices.js's output).
  const priceByTicker = {};
  for (const c of constituents) {
    const p = path.join(PRICES_DIR, c.ticker + '.json');
    if (fs.existsSync(p)) {
      try { priceByTicker[c.ticker] = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch (err) { console.warn('  ! prices/' + c.ticker + '.json unreadable (' + err.message + ')'); }
    }
  }
  const withPrices = Object.keys(priceByTicker).length;
  console.log('  Phase 2: ' + withPrices + '/' + constituents.length + ' tickers have prices/<TICKER>.json\n');
  if (!withPrices) {
    console.error('  No price data found. Run scripts/backfillPrices.js first.\n');
    process.exit(1);
  }

  // Phase 3: reconstruct each monthly rebalance date (resumable - skips a
  // date whose scores/<DATE>.json already exists).
  // Optional CLI override for a single-date trial run (e.g.
  // `node scripts/reconstructScores.js --date=2024-10-01`) instead of the
  // full monthly range. No override -> normal full-range behavior.
  const dateArg = process.argv.slice(2).find((a) => a.startsWith('--date='));
  const dates = dateArg ? [dateArg.slice('--date='.length)] : monthlyRebalanceDates();
  console.log('  Phase 3: reconstructing ' + dates.length + ' rebalance dates (' + dates[0] + ' -> ' + dates[dates.length - 1] + ')...\n');

  for (const asOfYmd of dates) {
    const outPath = path.join(SCORES_DIR, asOfYmd + '.json');
    if (fs.existsSync(outPath)) {
      console.log('  - ' + asOfYmd + '   (cached, skipping)');
      continue;
    }
    const result = await reconstructDate(asOfYmd, constituents, rawFactsByTicker, priceByTicker);
    writeJsonAtomic(outPath, result);
    console.log('  - ' + asOfYmd + '   ' + result.eligibleTickerCount + ' eligible tickers, ' +
      result.reconstructionEligibleCount + ' score-eligible (coverage >= ' + RECONSTRUCTION_MIN_COVERAGE + '), ' +
      result.shrunkBelowStructuralCeilingCount + ' shrunk below the ' + STRUCTURAL_COVERAGE_CEILING + ' structural ceiling, ' +
      'mean coverage ' + result.meanCompositeCoverage);
  }

  console.log('\n  Done. Wrote to ' + SCORES_DIR + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  Fatal error: ' + err.message);
    process.exit(1);
  });
}
