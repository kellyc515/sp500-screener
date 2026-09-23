/**
 * TOP-20 COMPOSITE MOMENTUM BACKTEST — standalone, not wired into daily.yml,
 * fetchData.js, or the other scripts/ tools. Run manually:
 *   node scripts/backtest.js
 *
 * Strategy: on each monthly rebalance date (from scripts/reconstructScores.js's
 * scores/<DATE>.json), buy the top 20 score-eligible tickers by reconstructed
 * composite, equal-weighted, hold until the next rebalance date. Benchmark:
 * SPY over the same dates, same entry/exit-price method.
 *
 * Two periods, reported SEPARATELY, never blended:
 *   - PRIMARY (2025-01-01 onward): the Momentum bucket (ret3m/ret6m) is live
 *     for essentially the whole universe by this point (see the 2026-09-23
 *     per-date coverage table - ret3m first goes non-null 2025-01-01, ret6m
 *     2025-04-01).
 *   - SECONDARY (2024-10-01 - 2024-12-01): momentum was structurally
 *     unavailable for every ticker (prices/<TICKER>.json's price floor is
 *     2024-09-23, too recent for any 91/182-day lookback) - composite here
 *     rests on Valuation+Quality+Growth only. Kept separate rather than
 *     lumped into "the backtest" so an early-period artifact never quietly
 *     drags down (or inflates) the momentum-live numbers.
 *
 * Each period is self-contained: only rebalance dates inside that period's
 * own date list are used, producing (dateCount - 1) completed monthly
 * holding intervals. The period's LAST rebalance date's picks are reported
 * as an open/unclosed position (informational only) - not counted in that
 * period's total return, drawdown, or win-rate, since there is no completed
 * return to measure yet (see OPEN POSITION note in the output).
 *
 * No transaction costs in this version (TRANSACTION_COST_BPS = 0), but see
 * applyTransactionCosts() below - turnover is already computed per rebalance
 * specifically so a future cost assumption only needs to change that one
 * constant, not the surrounding accounting.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCORES_DIR = path.join(REPO_ROOT, 'scores');
const PRICES_DIR = path.join(REPO_ROOT, 'prices');
const OUT_PATH = path.join(REPO_ROOT, 'backtest-results.json');

const TOP_N = 20;
const BENCHMARK_TICKER = 'SPY';
const PRIMARY_PERIOD_START = '2025-01-01';

// v1: no costs. A future version would deduct roughly
// (turnoverCount / TOP_N) * (TRANSACTION_COST_BPS / 10000) * 2 (round trip)
// from each period's raw return - see applyTransactionCosts().
const TRANSACTION_COST_BPS = 0;

function loadScoresIndex() {
  if (!fs.existsSync(SCORES_DIR)) {
    console.error('\n  No scores/ directory found. Run scripts/reconstructScores.js first.\n');
    process.exit(1);
  }
  const dates = fs.readdirSync(SCORES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .sort();
  if (!dates.length) {
    console.error('\n  scores/ is empty. Run scripts/reconstructScores.js first.\n');
    process.exit(1);
  }
  const byDate = {};
  for (const d of dates) {
    byDate[d] = JSON.parse(fs.readFileSync(path.join(SCORES_DIR, d + '.json'), 'utf8'));
  }
  return { dates, byDate };
}

const priceCache = new Map();
function loadPrices(ticker) {
  if (priceCache.has(ticker)) return priceCache.get(ticker);
  const p = path.join(PRICES_DIR, ticker + '.json');
  let data = null;
  if (fs.existsSync(p)) {
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (err) { console.warn('  ! prices/' + ticker + '.json unreadable (' + err.message + ')'); }
  }
  priceCache.set(ticker, data);
  return data;
}

// First bar with date >= targetYmd. bars must be sorted ascending (every
// backfillPrices.js output already is). Null if every bar predates target -
// this is the "if no bar exists that day, use the next available trading
// day" rule from the spec, applied by searching forward.
function priceOnOrAfter(bars, targetYmd) {
  for (const bar of bars) {
    if (bar.date >= targetYmd) return bar;
  }
  return null;
}

function tickerReturn(ticker, entryYmd, exitYmd) {
  const priceData = loadPrices(ticker);
  if (!priceData || !Array.isArray(priceData.bars)) return { value: null, reason: 'no price data' };
  const entryBar = priceOnOrAfter(priceData.bars, entryYmd);
  const exitBar = priceOnOrAfter(priceData.bars, exitYmd);
  if (!entryBar) return { value: null, reason: 'no bar on/after entry date ' + entryYmd };
  if (!exitBar) return { value: null, reason: 'no bar on/after exit date ' + exitYmd };
  if (!(entryBar.close > 0)) return { value: null, reason: 'non-positive entry price' };
  return {
    value: (exitBar.close / entryBar.close) - 1,
    entryDate: entryBar.date,
    entryPrice: entryBar.close,
    exitDate: exitBar.date,
    exitPrice: exitBar.close,
  };
}

// Top TOP_N score-eligible (reconstructedEligible) tickers by composite,
// descending. score-eligible uses reconstructScores.js's own 0.60
// reconstruction-only coverage override - not screener.js's live 0.80.
function topHoldings(scoreDateData) {
  return Object.entries(scoreDateData.tickers)
    .filter(([, t]) => t.reconstructedEligible)
    .sort((a, b) => b[1].composite - a[1].composite)
    .slice(0, TOP_N)
    .map(([ticker, t]) => ({ ticker, composite: t.composite }));
}

// No-op today (TRANSACTION_COST_BPS = 0) - the hook a future cost
// assumption plugs into without touching the return-computation logic above.
function applyTransactionCosts(rawReturn, turnoverCount, positionCount) {
  if (!TRANSACTION_COST_BPS || !turnoverCount) return rawReturn;
  const turnoverFraction = turnoverCount / positionCount;
  const costDrag = turnoverFraction * (TRANSACTION_COST_BPS / 10000) * 2; // round trip
  return rawReturn - costDrag;
}

function maxDrawdown(periodReturns) {
  let equity = 1, peak = 1, worst = 0;
  for (const r of periodReturns) {
    equity *= (1 + r);
    peak = Math.max(peak, equity);
    worst = Math.min(worst, (equity - peak) / peak);
  }
  return worst; // negative fraction, e.g. -0.123 = -12.3%
}

function compoundReturn(periodReturns) {
  return periodReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
}

// One period (e.g. primary or secondary): walks its own date list only,
// producing one row per completed [dates[i], dates[i+1]) holding interval.
// The final date's picks are returned separately as `openPosition` - a
// rebalance without a completed return yet, not part of any statistic.
function runPeriod(label, dates, scoresByDate) {
  const rows = [];
  let previousHoldings = null;

  for (let i = 0; i < dates.length - 1; i++) {
    const entryDate = dates[i];
    const exitDate = dates[i + 1];
    const holdings = topHoldings(scoresByDate[entryDate]);
    const tickers = holdings.map((h) => h.ticker);

    const tickerReturns = [];
    const missing = [];
    for (const ticker of tickers) {
      const r = tickerReturn(ticker, entryDate, exitDate);
      if (r.value === null) missing.push({ ticker, reason: r.reason });
      else tickerReturns.push(r.value);
    }
    const portfolioReturnRaw = tickerReturns.length
      ? tickerReturns.reduce((a, x) => a + x, 0) / tickerReturns.length
      : null;

    const benchmark = tickerReturn(BENCHMARK_TICKER, entryDate, exitDate);

    const turnover = previousHoldings === null
      ? null
      : tickers.filter((t) => !previousHoldings.includes(t)).length;

    const portfolioReturn = portfolioReturnRaw === null
      ? null
      : applyTransactionCosts(portfolioReturnRaw, turnover, TOP_N);

    rows.push({
      entryDate,
      exitDate,
      holdingCount: tickers.length,
      missingHoldings: missing,
      portfolioReturn,
      portfolioReturnRaw,
      benchmarkReturn: benchmark.value,
      turnover,
      beatBenchmark: portfolioReturn !== null && benchmark.value !== null
        ? portfolioReturn > benchmark.value
        : null,
    });

    previousHoldings = tickers;
  }

  const lastDate = dates[dates.length - 1];
  const openPosition = {
    asOfDate: lastDate,
    holdings: topHoldings(scoresByDate[lastDate]),
    note: 'Established at this period\'s final rebalance date - no completed holding period exists yet, so this is excluded from every statistic below.',
  };

  const validPortfolioReturns = rows.map((r) => r.portfolioReturn).filter((r) => r !== null);
  const validBenchmarkReturns = rows.map((r) => r.benchmarkReturn).filter((r) => r !== null);
  const comparablePairs = rows.filter((r) => r.beatBenchmark !== null);

  return {
    label,
    dateRange: [dates[0], lastDate],
    completedHoldingPeriods: rows.length,
    rows,
    openPosition,
    stats: {
      strategyTotalReturn: rows.length === validPortfolioReturns.length ? compoundReturn(validPortfolioReturns) : null,
      benchmarkTotalReturn: rows.length === validBenchmarkReturns.length ? compoundReturn(validBenchmarkReturns) : null,
      strategyMaxDrawdown: validPortfolioReturns.length ? maxDrawdown(validPortfolioReturns) : null,
      benchmarkMaxDrawdown: validBenchmarkReturns.length ? maxDrawdown(validBenchmarkReturns) : null,
      monthsBeatBenchmark: comparablePairs.filter((r) => r.beatBenchmark).length,
      monthsComparable: comparablePairs.length,
      winRate: comparablePairs.length ? comparablePairs.filter((r) => r.beatBenchmark).length / comparablePairs.length : null,
      meanTurnover: (() => {
        const t = rows.map((r) => r.turnover).filter((v) => v !== null);
        return t.length ? t.reduce((a, x) => a + x, 0) / t.length : null;
      })(),
    },
  };
}

function pct(x, digits = 2) {
  return x === null || x === undefined ? 'n/a' : (x * 100).toFixed(digits) + '%';
}

function printPeriodTable(period) {
  console.log('\n=== ' + period.label + ' (' + period.dateRange[0] + ' -> ' + period.dateRange[1] + ') ===\n');
  console.log('Entry -> Exit'.padEnd(24) + 'Strategy'.padStart(10) + 'SPY'.padStart(10) + 'Beat?'.padStart(8) + 'Turnover'.padStart(10));
  for (const r of period.rows) {
    console.log(
      (r.entryDate + ' -> ' + r.exitDate).padEnd(24) +
      pct(r.portfolioReturn).padStart(10) +
      pct(r.benchmarkReturn).padStart(10) +
      (r.beatBenchmark === null ? 'n/a' : r.beatBenchmark ? 'yes' : 'no').padStart(8) +
      (r.turnover === null ? 'n/a' : String(r.turnover) + '/' + TOP_N).padStart(10)
    );
  }
  console.log('\nOpen position as of ' + period.openPosition.asOfDate + ' (excluded from stats): ' +
    period.openPosition.holdings.map((h) => h.ticker).join(', '));
  console.log('\nTotal return   - strategy: ' + pct(period.stats.strategyTotalReturn) + '   SPY: ' + pct(period.stats.benchmarkTotalReturn));
  console.log('Max drawdown   - strategy: ' + pct(period.stats.strategyMaxDrawdown) + '   SPY: ' + pct(period.stats.benchmarkMaxDrawdown));
  console.log('Win rate       - strategy beat SPY in ' + period.stats.monthsBeatBenchmark + '/' + period.stats.monthsComparable +
    ' months (' + pct(period.stats.winRate) + ')');
  console.log('Mean turnover  - ' + (period.stats.meanTurnover === null ? 'n/a' : period.stats.meanTurnover.toFixed(1) + '/' + TOP_N + ' holdings per rebalance'));
}

function main() {
  if (!loadPrices(BENCHMARK_TICKER)) {
    console.error('\n  prices/' + BENCHMARK_TICKER + '.json not found. Fetch it first:');
    console.error('    node scripts/backfillPrices.js ' + BENCHMARK_TICKER + '\n');
    process.exit(1);
  }

  const { dates, byDate } = loadScoresIndex();
  const secondaryDates = dates.filter((d) => d < PRIMARY_PERIOD_START);
  const primaryDates = dates.filter((d) => d >= PRIMARY_PERIOD_START);

  if (primaryDates.length < 2) {
    console.error('\n  Fewer than 2 rebalance dates on/after ' + PRIMARY_PERIOD_START + ' - nothing to backtest in the primary period.\n');
    process.exit(1);
  }

  const primary = runPeriod('PRIMARY (momentum live)', primaryDates, byDate);
  printPeriodTable(primary);

  let secondary = null;
  if (secondaryDates.length >= 2) {
    secondary = runPeriod('SECONDARY (no momentum, Valuation+Quality+Growth only)', secondaryDates, byDate);
    printPeriodTable(secondary);
  } else {
    console.log('\n  Skipping secondary period - fewer than 2 rebalance dates before ' + PRIMARY_PERIOD_START + '.');
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    strategy: {
      topN: TOP_N,
      rebalanceFrequency: 'monthly (uses whatever rebalance dates exist in scores/)',
      weighting: 'equal-weight',
      benchmark: BENCHMARK_TICKER,
      transactionCostBps: TRANSACTION_COST_BPS,
      priceRule: 'close on rebalance date, or next available trading day on/after it',
    },
    primary,
    secondary,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  console.log('\nFull results written -> ' + OUT_PATH + '\n');
}

if (require.main === module) {
  main();
}
