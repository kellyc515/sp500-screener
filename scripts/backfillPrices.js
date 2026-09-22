/**
 * ONE-OFF PRICE HISTORY BACKFILL (Polygon.io) — standalone, not wired into
 * fetchData.js or .github/workflows/daily.yml. Run manually:
 *   node scripts/backfillPrices.js
 *
 * Pulls daily AAPL-style aggregate bars (date + close only) per S&P 500
 * ticker from Polygon's /v2/aggs endpoint and writes one file per ticker to
 * prices/<TICKER>.json. Exists because neither Finnhub (candle history is
 * premium-only on this project's tier) nor FMP (only wired for congressional
 * trades) can supply multi-year daily price history - see the 2026-09-22
 * data-flow audit.
 *
 * Empirically confirmed (manual test call, 2026-09-22): this Polygon key's
 * plan returns daily bars back to 2024-09-23 and no further - requesting an
 * earlier `from` does NOT error (no NOT_AUTHORIZED), it silently returns
 * only what the plan allows. REQUEST_FROM below is that confirmed floor, not
 * a guess. A 200 response is therefore not proof of complete data - see
 * validateRange() below, which is why this script exists instead of trusting
 * response.ok alone.
 *
 * Resumable by construction: prices/<TICKER>.json existing IS the "already
 * done" marker, so a re-run just skips those and continues with whatever's
 * left - no separate progress/checkpoint file.
 */

const fs = require('fs');
const path = require('path');

/* ---- load .env (self-contained copy of fetchData.js's loader - kept
 * duplicated on purpose, this script stays standalone) ---- */
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
loadEnvFile(path.join(__dirname, '..', '.env'));

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';

const REPO_ROOT = path.join(__dirname, '..');
const UNIVERSE_PATH = path.join(REPO_ROOT, 'universe.json');
const PRICES_DIR = path.join(REPO_ROOT, 'prices');

// Confirmed empirically (see file header) - this is the actual floor this
// plan's key returns, not an assumption. If Polygon's plan is ever upgraded,
// update this and re-run - already-written tickers won't be touched until
// their files are removed (resume-by-file-existence, see main()).
const REQUEST_FROM = '2024-09-23';

// Weekend/holiday slack around REQUEST_FROM. A healthy response's earliest
// bar should land within a few calendar days of the requested `from` even
// though that's a Monday, not every calendar date is a trading day). Beyond
// this, treat it as a truncation signal worth a human look, not silently ok.
const TRUNCATION_TOLERANCE_DAYS = 7;

// Free/basic Polygon tiers cap requests per minute, not just per day.
const CALLS_PER_MINUTE = 5;
const MIN_CALL_INTERVAL_MS = Math.ceil(60000 / CALLS_PER_MINUTE);

const MAX_ATTEMPTS_PER_TICKER = 5;
const BASE_BACKOFF_MS = 15000;
const MAX_BACKOFF_MS = 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
const todayYMD = () => new Date().toISOString().slice(0, 10);
const msToYMD = (ms) => new Date(ms).toISOString().slice(0, 10);

function loadUniverse() {
  if (!fs.existsSync(UNIVERSE_PATH)) {
    console.error('\n  universe.json not found. Build it first:');
    console.error('    node buildUniverse.js\n');
    process.exit(1);
  }
  const universe = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf8'));
  const tickers = Array.isArray(universe.constituents) ? universe.constituents.map((c) => c.ticker).filter(Boolean) : [];
  if (!tickers.length) {
    console.error('\n  universe.json has no constituents. Rebuild it:');
    console.error('    node buildUniverse.js\n');
    process.exit(1);
  }
  return tickers;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Beyond REQUEST_FROM + tolerance -> flagged for review, not accepted
// silently just because the call returned 200. See file header for why.
function validateRange(earliestYMD) {
  const requestedMs = new Date(REQUEST_FROM).getTime();
  const earliestMs = new Date(earliestYMD).getTime();
  const driftDays = Math.round((earliestMs - requestedMs) / (24 * 60 * 60 * 1000));
  return { truncated: driftDays > TRUNCATION_TOLERANCE_DAYS, driftDays };
}

// Fatal: a bad/expired key fails identically for every ticker, so finding
// that out on ticker 1 of 503 (rather than burning the whole rate-limit
// budget rediscovering it 503 times) is the only sane response.
function abortOnAuthFailure(sym, status, bodyText) {
  console.error('\n  Fatal: HTTP ' + status + ' on ' + sym + ' - ' + bodyText);
  console.error('  Treating this as an auth failure (bad/expired POLYGON_API_KEY). Aborting the whole run.\n');
  process.exit(1);
}

// One ticker, one call, with its own retry/backoff budget for transient
// failures (429 rate limit, 5xx, network errors). Returns:
//   { outcome: 'success'|'truncated', bars, meta }  or
//   { outcome: 'failed', reason }
async function fetchTicker(sym) {
  const to = todayYMD();
  const url = POLYGON_BASE + '/v2/aggs/ticker/' + encodeURIComponent(sym) +
    '/range/1/day/' + REQUEST_FROM + '/' + to +
    '?adjusted=true&sort=asc&limit=50000&apiKey=' + POLYGON_API_KEY;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TICKER; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === MAX_ATTEMPTS_PER_TICKER) return { outcome: 'failed', reason: 'network error: ' + err.message };
      await sleep(Math.min(BASE_BACKOFF_MS * attempt, MAX_BACKOFF_MS));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      const bodyText = await res.text().catch(() => '');
      abortOnAuthFailure(sym, res.status, bodyText);
    }

    if (res.status === 429) {
      if (attempt === MAX_ATTEMPTS_PER_TICKER) return { outcome: 'failed', reason: 'HTTP 429 - rate limited, exhausted retries' };
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        : Math.min(BASE_BACKOFF_MS * attempt, MAX_BACKOFF_MS);
      console.warn('  ! ' + sym + ': HTTP 429 - backing off ' + Math.round(waitMs / 1000) + 's (attempt ' + attempt + '/' + MAX_ATTEMPTS_PER_TICKER + ')');
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      if (attempt === MAX_ATTEMPTS_PER_TICKER) return { outcome: 'failed', reason: 'HTTP ' + res.status };
      await sleep(Math.min(BASE_BACKOFF_MS * attempt, MAX_BACKOFF_MS));
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      return { outcome: 'failed', reason: 'bad JSON: ' + err.message };
    }

    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      return { outcome: 'failed', reason: 'no data returned (status: ' + (data.status || 'unknown') + ')' };
    }

    const bars = results
      .filter((row) => row && row.t != null && row.c != null)
      .map((row) => ({ date: msToYMD(row.t), close: row.c }));
    if (!bars.length) {
      return { outcome: 'failed', reason: 'results present but missing t/c fields' };
    }

    const earliest = bars[0].date;
    const latest = bars[bars.length - 1].date;
    const { truncated, driftDays } = validateRange(earliest);

    return {
      outcome: truncated ? 'truncated' : 'success',
      bars,
      meta: {
        requestedFrom: REQUEST_FROM,
        requestedTo: to,
        earliestReturned: earliest,
        latestReturned: latest,
        barCount: bars.length,
        truncated,
        driftDays,
      },
    };
  }

  return { outcome: 'failed', reason: 'exhausted retries' };
}

async function main() {
  if (!POLYGON_API_KEY) {
    console.error('\n  Missing API key. Set it in .env:');
    console.error('    POLYGON_API_KEY=your_polygon_key\n');
    process.exit(1);
  }

  // Optional CLI override for trial runs against a handful of tickers
  // (e.g. `node scripts/backfillPrices.js AAPL MSFT JPM`) instead of the
  // full universe. No override -> normal full-universe behavior.
  const cliTickers = process.argv.slice(2).map((s) => s.toUpperCase()).filter(Boolean);
  const tickers = cliTickers.length ? cliTickers : loadUniverse();
  fs.mkdirSync(PRICES_DIR, { recursive: true });

  const stats = { succeeded: 0, truncated: 0, failed: 0, skipped: 0 };
  const estMinutes = Math.round((tickers.length * MIN_CALL_INTERVAL_MS) / 60000);
  console.log('\n  Backfilling ' + tickers.length + ' tickers from ' + REQUEST_FROM + ' to ' + todayYMD() +
    ' (~' + CALLS_PER_MINUTE + ' calls/min, worst case ~' + estMinutes + ' min if none are already cached)...\n');

  let lastCallAt = 0;

  for (const sym of tickers) {
    const outPath = path.join(PRICES_DIR, sym + '.json');
    if (fs.existsSync(outPath)) {
      stats.skipped++;
      console.log('  - ' + sym + '   (cached, skipping)');
      continue;
    }

    const elapsed = Date.now() - lastCallAt;
    if (lastCallAt && elapsed < MIN_CALL_INTERVAL_MS) {
      await sleep(MIN_CALL_INTERVAL_MS - elapsed);
    }
    lastCallAt = Date.now();

    const result = await fetchTicker(sym);

    if (result.outcome === 'failed') {
      stats.failed++;
      console.log('  - ' + sym + '   FAILED: ' + result.reason);
      continue;
    }

    writeJsonAtomic(outPath, {
      ticker: sym,
      generatedAt: nowISO(),
      ...result.meta,
      bars: result.bars,
    });

    if (result.outcome === 'truncated') {
      stats.truncated++;
      console.log('  - ' + sym + '   TRUNCATED: earliest ' + result.meta.earliestReturned +
        ' (' + result.meta.driftDays + 'd after requested ' + REQUEST_FROM + '), ' + result.meta.barCount + ' bars');
    } else {
      stats.succeeded++;
      console.log('  - ' + sym + '   ok: ' + result.meta.barCount + ' bars (' +
        result.meta.earliestReturned + ' -> ' + result.meta.latestReturned + ')');
    }
  }

  console.log('\n  Summary: ' + stats.succeeded + ' succeeded, ' + stats.truncated + ' truncated, ' +
    stats.failed + ' failed, ' + stats.skipped + ' already cached (skipped).');
  if (stats.truncated) {
    console.log('  Truncated tickers returned data starting later than the ' + REQUEST_FROM +
      ' floor by more than ' + TRUNCATION_TOLERANCE_DAYS + ' days - could be a genuinely short trading' +
      ' history (recent IPO/spinoff) or a provider-side gap. Check prices/<TICKER>.json\'s' +
      ' earliestReturned/driftDays fields before trusting that ticker\'s history.');
  }
  if (stats.failed) {
    console.log('  Failed tickers wrote no file, so re-running this script will retry them automatically.');
  }
  console.log('');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n  Fatal error: ' + err.message);
    process.exit(1);
  });
}
