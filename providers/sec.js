/**
 * SEC EDGAR adapter. Free, no API key, no daily quota - the primary source
 * for fundamentals now. Supplies name/sector and computes roe/debtEquity from
 * raw filed figures. Also derives secEps/secBookValuePerShare as a fallback
 * input for the orchestrator's price-based pe/pb computation (SEC has no
 * price itself - that still has to come from Finnhub/FMP).
 */

const fs = require('fs');
const path = require('path');
const { createHttpClient } = require('./httpClient');

// SEC requires a descriptive User-Agent (app name + contact) on every request,
// or it returns 403. Override via .env if you want your own contact on record.
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'ScreenerResearchTool/1.0 (contreraskelly515@gmail.com)';

const SEC_WWW = 'https://www.sec.gov';
const SEC_DATA = 'https://data.sec.gov';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CIK_MAP_FILE = path.join(CACHE_DIR, 'sec-cik-map.json');
const CIK_MAP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // ticker/CIK assignments barely ever change

// SEC's fair-use guidance caps shared traffic at ~10 req/sec; pacing well under that.
const client = createHttpClient({
  name: 'sec',
  pacingMs: 250,
  maxAttempts: 2,
  treatAny429AsQuota: false, // SEC 429s are pure rate limiting, not a "you're out for the day" signal
  headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
});

const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/* ---- ticker -> CIK map: fetched once, cached for a month ---- */
let cikMapPromise = null;

function readCikMapCache() {
  if (!fs.existsSync(CIK_MAP_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CIK_MAP_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeCikMapCache(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = CIK_MAP_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CIK_MAP_FILE);
}

async function loadOrFetchCikMap() {
  const cached = readCikMapCache();
  if (cached && cached.updatedAt) {
    const age = Date.now() - new Date(cached.updatedAt).getTime();
    if (Number.isFinite(age) && age < CIK_MAP_MAX_AGE_MS) return cached.tickers;
  }

  const r = await client.getJSON(SEC_WWW + '/files/company_tickers.json', 'SEC ticker/CIK map');
  if (!r.ok) return cached ? cached.tickers : {}; // fall back to a stale map rather than nothing

  const tickers = {};
  for (const row of Object.values(r.data)) {
    if (!row || !row.ticker || row.cik_str === undefined) continue;
    tickers[String(row.ticker).toUpperCase()] = {
      cik: String(row.cik_str).padStart(10, '0'),
      title: row.title || null,
    };
  }
  writeCikMapCache({ tickers, updatedAt: new Date().toISOString() });
  return tickers;
}

function ensureCikMap() {
  if (!cikMapPromise) cikMapPromise = loadOrFetchCikMap();
  return cikMapPromise;
}

/* ---- XBRL figure helpers ----
 * A single XBRL concept can carry multiple unit-keyed arrays at once - not
 * just "USD vs everything else". A per-share concept like EarningsPerShareDiluted
 * normally only has 'USD/shares', but a company's filing history can contain a
 * stray/legacy alternate-unit entry under the same concept name (confirmed for
 * FDX: EarningsPerShareDiluted had both 'shares' and 'USD/shares' keys, the
 * 'shares' one holding two old mistagged values from FY2008/2009). The old
 * fallback `tag.units.USD || Object.values(tag.units)[0]` silently took
 * whichever unit happened to be first in object-insertion order whenever USD
 * wasn't present - for FDX that grabbed the bogus 'shares' array and produced
 * an epsGrowth of -91.39% against a real XBRL-verified +10.4%.
 * Every call site now states its expected unit explicitly (`preferredUnit`)
 * instead of relying on insertion order. Omitting it preserves the exact old
 * fallback behavior, which is still correct for the plain-USD tags that were
 * never actually broken.
 */
function unitsArray(tag, preferredUnit) {
  if (!tag || !tag.units) return null;
  const arr = preferredUnit
    ? tag.units[preferredUnit]
    : (tag.units.USD || Object.values(tag.units)[0]);
  return Array.isArray(arr) && arr.length ? arr : null;
}

// Point-in-time figures (balance-sheet items like equity, debt, liabilities):
// most recent filed value regardless of form.
function latestInstant(tag, preferredUnit) {
  const arr = unitsArray(tag, preferredUnit);
  if (!arr) return null;
  const sorted = [...arr].sort((a, b) => (a.end < b.end ? 1 : -1));
  return num(sorted[0].val);
}

// Duration figures (income-statement items like net income): prefer a clean
// annual (10-K, full fiscal year) total over a quarterly one, so we don't
// understate the ratio by dividing an annual denominator by a quarterly figure.
function latestAnnual(tag, preferredUnit) {
  const arr = unitsArray(tag, preferredUnit);
  if (!arr) return null;
  const annual = arr.filter((e) => e.fp === 'FY' && e.form && e.form.startsWith('10-K'));
  const pool = annual.length ? annual : arr;
  const sorted = [...pool].sort((a, b) => (a.end < b.end ? 1 : -1));
  return num(sorted[0].val);
}


function annualSeries(tag, preferredUnit) {
  const arr = unitsArray(tag, preferredUnit);
  if (!arr) return [];

  const annual = arr
    .filter((e) => {
      if (
        !e ||
        e.fp !== 'FY' ||
        !e.form ||
        !e.form.startsWith('10-K') ||
        !e.start ||
        !e.end ||
        e.val === null ||
        e.val === undefined
      ) return false;

      // A true annual duration should be roughly one fiscal year.
      // This rejects quarter/transition facts that SEC Company Facts can
      // sometimes label FY because they appeared inside a 10-K.
      const start = new Date(e.start);
      const end = new Date(e.end);
      const days = (end - start) / (1000 * 60 * 60 * 24);

      return Number.isFinite(days) && days >= 300 && days <= 400;
    })
    .sort((a, b) => String(b.end).localeCompare(String(a.end)));

  const unique = [];
  const seen = new Set();

  for (const row of annual) {
    // Same economic period can appear again in later 10-K comparative data.
    const key = `${row.start}|${row.end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    unique.push({
      start: row.start,
      end: row.end,
      value: num(row.val),
      fy: row.fy ?? null,
      fp: row.fp ?? null,
      form: row.form || null,
      filed: row.filed || null,
      accn: row.accn || null,
      frame: row.frame || null,
    });
  }

  return unique;
}

function firstAnnualSeries(usGaap, tagNames, preferredUnit) {
  const candidates = [];

  for (const tagName of tagNames) {
    const series = annualSeries(usGaap[tagName], preferredUnit);
    if (!series.length) continue;

    candidates.push({
      tagName,
      series,
      latestEnd: series[0].end
    });
  }

  if (!candidates.length) return [];

  // Prefer the tag containing the newest real annual observation.
  // If multiple tags are equally current, preserve the supplied tag priority.
  candidates.sort((a, b) =>
    String(b.latestEnd).localeCompare(String(a.latestEnd))
  );

  return candidates[0].series.map((row) => ({ ...row, tagName: candidates[0].tagName }));
}


// Match two annual SEC fact series by the exact economic period.
// This prevents ratios from mixing values from different fiscal years
// or differently-sized reporting periods.

// Build one consolidated annual revenue series from all supported SEC revenue tags.
//
// A company can report several revenue concepts for the SAME fiscal period.
// Some may represent only a small component of total revenue (common with REITs).
// For each exact start/end period, keep the largest positive revenue observation,
// which is generally the consolidated top-line figure we want for screening.
function bestRevenueSeries(usGaap) {
  const revenueTags = [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet',
    'Revenues'
  ];

  const byPeriod = new Map();

  for (const tagName of revenueTags) {
    const series = annualSeries(usGaap[tagName], 'USD');

    for (const row of series) {
      if (
        row.value === null ||
        !Number.isFinite(row.value) ||
        row.value <= 0
      ) continue;

      const key = `${row.start}|${row.end}`;
      const existing = byPeriod.get(key);

      if (!existing || row.value > existing.value) {
        byPeriod.set(key, {
          start: row.start,
          end: row.end,
          value: row.value,
          sourceTag: tagName,
          fy: row.fy,
          fp: row.fp,
          form: row.form,
          filed: row.filed,
          accn: row.accn,
          frame: row.frame,
        });
      }
    }
  }

  return [...byPeriod.values()].sort((a, b) =>
    String(b.end).localeCompare(String(a.end))
  );
}

// Separate allowlist for the display-only annual quality metrics. Including
// assessed tax is required for issuers such as NCLH, but keeping it out of
// bestRevenueSeries() ensures this addition cannot change the existing
// revenueGrowth scoring input.
function bestQualityMetricRevenueSeries(usGaap) {
  const base = bestRevenueSeries(usGaap);
  const includingTax = annualSeries(usGaap.RevenueFromContractWithCustomerIncludingAssessedTax, 'USD')
    .map((row) => ({ ...row, sourceTag: 'RevenueFromContractWithCustomerIncludingAssessedTax' }));
  const byPeriod = new Map();
  for (const row of [...base, ...includingTax]) {
    if (!Number.isFinite(row.value) || row.value <= 0) continue;
    const key = `${row.start}|${row.end}`;
    const existing = byPeriod.get(key);
    if (!existing || row.value > existing.value) byPeriod.set(key, row);
  }
  return [...byPeriod.values()].sort((a, b) => String(b.end).localeCompare(String(a.end)));
}

// Match two already-built annual series by exact start/end dates.
function matchAnnualSeries(numeratorSeries, denominatorSeries) {
  if (!numeratorSeries.length || !denominatorSeries.length) return [];

  const denominatorByPeriod = new Map();

  for (const row of denominatorSeries) {
    denominatorByPeriod.set(
      `${row.start}|${row.end}`,
      row
    );
  }

  const matched = [];

  for (const numerator of numeratorSeries) {
    const denominator = denominatorByPeriod.get(
      `${numerator.start}|${numerator.end}`
    );

    if (!denominator) continue;

    matched.push({
      start: numerator.start,
      end: numerator.end,
      numerator: numerator.value,
      denominator: denominator.value
    });
  }

  return matched.sort((a, b) =>
    String(b.end).localeCompare(String(a.end))
  );
}

function matchedAnnualPeriods(usGaap, numeratorTags, denominatorTags, preferredUnit) {
  const numeratorSeries = firstAnnualSeries(usGaap, numeratorTags, preferredUnit);
  const denominatorSeries = firstAnnualSeries(usGaap, denominatorTags, preferredUnit);

  if (!numeratorSeries.length || !denominatorSeries.length) return [];

  const denominatorByPeriod = new Map();

  for (const row of denominatorSeries) {
    const key = `${row.start || ''}|${row.end || ''}`;
    if (!denominatorByPeriod.has(key)) {
      denominatorByPeriod.set(key, row);
    }
  }

  const matched = [];

  for (const numerator of numeratorSeries) {
    const key = `${numerator.start || ''}|${numerator.end || ''}`;
    const denominator = denominatorByPeriod.get(key);

    if (!denominator) continue;

    matched.push({
      start: numerator.start,
      end: numerator.end,
      numerator: numerator.value,
      denominator: denominator.value
    });
  }

  return matched.sort((a, b) =>
    String(b.end).localeCompare(String(a.end))
  );
}

// Minimum-magnitude floors for the near-zero-base version of the
// negative/tiny-denominator bug class (see positiveBaseGrowthPct below).
// EPS_GROWTH_MIN_BASE: dollars per share - a flat floor is appropriate
// since EPS is already roughly cross-company comparable.
// FCF_GROWTH_MIN_BASE_RATIO: fraction of that period's OCF - a relative
// floor is required here instead, since a "near-zero FCF" year scales with
// company size (a coincidence of OCF landing close to CapEx), not a fixed
// dollar amount.
const EPS_GROWTH_MIN_BASE = 0.25;
const FCF_GROWTH_MIN_BASE_RATIO = 0.10;

function growthPct(current, prior) {
  if (
    current === null ||
    prior === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(prior) ||
    prior === 0
  ) return null;

  return +(((current - prior) / Math.abs(prior)) * 100).toFixed(2);
}


// Percentage growth intended for earnings/cash-flow metrics.
// A zero or negative prior-period base does not produce a comparable
// percentage-growth signal, so return null instead of an explosive ratio.
// A prior base that clears zero but is still tiny has the same problem in
// the opposite direction: a near-zero denominator explodes the percentage
// even though the sign comes out "correct." `minBase`, when supplied, is
// the smallest |prior| this function will treat as a real base to grow
// from - anything smaller is nulled exactly like <= 0, never computed and
// never clipped/capped to a plausible-looking-but-still-fabricated number.
function positiveBaseGrowthPct(current, prior, minBase) {
  if (
    current === null ||
    prior === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(prior) ||
    prior <= 0 ||
    (minBase !== undefined && minBase !== null && prior < minBase)
  ) return null;

  return +(((current - prior) / prior) * 100).toFixed(2);
}

function ratioPct(numerator, denominator) {
  if (
    numerator === null ||
    denominator === null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) return null;

  return +((numerator / denominator) * 100).toFixed(2);
}

function firstAvailable(usGaap, tagNames, fn) {
  for (const t of tagNames) {
    const v = fn(usGaap[t]);
    if (v !== null) return v;
  }
  return null;
}

function sumLatestInstant(usGaap, tagNames, preferredUnit) {
  let sum = 0, found = false;
  for (const t of tagNames) {
    const v = latestInstant(usGaap[t], preferredUnit);
    if (v !== null) { sum += v; found = true; }
  }
  return found ? sum : null;
}

const ANNUAL_QUALITY_MAX_AGE_MS = 550 * 24 * 60 * 60 * 1000;
const BALANCE_DATE_TOLERANCE_DAYS = 3;
const DEBT_RECONCILIATION_REL_TOLERANCE = 0.01;
const DEBT_RECONCILIATION_ABS_TOLERANCE = 1_000_000;

function annualPeriodIsCurrent(end, nowMs = Date.now()) {
  const endMs = new Date(end).getTime();
  return Number.isFinite(endMs) &&
    endMs <= nowMs + 14 * 24 * 60 * 60 * 1000 &&
    nowMs - endMs <= ANNUAL_QUALITY_MAX_AGE_MS;
}

function annualFactForPeriod(series, period, preferredAccn, preferLargest = false) {
  const matches = series.filter((row) => row.start === period.start && row.end === period.end);
  if (!matches.length) return null;
  const sameAccession = preferredAccn ? matches.filter((row) => row.accn === preferredAccn) : [];
  const pool = sameAccession.length ? sameAccession : matches;
  if (preferLargest) return [...pool].sort((a, b) => b.value - a.value)[0];
  return pool[0];
}

function instantFactAt(tag, preferredUnit, targetDate, preferredAccn) {
  const arr = unitsArray(tag, preferredUnit);
  if (!arr || !targetDate) return null;
  const targetMs = new Date(targetDate).getTime();
  if (!Number.isFinite(targetMs)) return null;

  const candidates = arr
    .filter((row) => row && row.end && row.val !== null && row.val !== undefined)
    .map((row) => ({
      value: num(row.val),
      end: row.end,
      form: row.form || null,
      filed: row.filed || null,
      accn: row.accn || null,
      frame: row.frame || null,
      offsetDays: Math.round((new Date(row.end).getTime() - targetMs) / (24 * 60 * 60 * 1000)),
    }))
    .filter((row) => Number.isFinite(row.value) && Math.abs(row.offsetDays) <= BALANCE_DATE_TOLERANCE_DAYS)
    .sort((a, b) => {
      const aSame = preferredAccn && a.accn === preferredAccn ? 1 : 0;
      const bSame = preferredAccn && b.accn === preferredAccn ? 1 : 0;
      if (aSame !== bSame) return bSame - aSame;
      if (Math.abs(a.offsetDays) !== Math.abs(b.offsetDays)) return Math.abs(a.offsetDays) - Math.abs(b.offsetDays);
      return String(b.filed).localeCompare(String(a.filed));
    });

  return candidates[0] || null;
}

function firstInstantFactAt(usGaap, tagNames, targetDate, preferredAccn) {
  for (const tagName of tagNames) {
    const fact = instantFactAt(usGaap[tagName], 'USD', targetDate, preferredAccn);
    if (fact) return { ...fact, tagName };
  }
  return null;
}

function debtValuesReconcile(total, components) {
  const componentTotal = components.reduce((sum, value) => sum + value, 0);
  const tolerance = Math.max(DEBT_RECONCILIATION_ABS_TOLERANCE, Math.abs(total) * DEBT_RECONCILIATION_REL_TOLERANCE);
  return Math.abs(total - componentTotal) <= tolerance;
}

function selectDebtAt(usGaap, targetDate, preferredAccn) {
  const get = (tagName) => {
    const fact = instantFactAt(usGaap[tagName], 'USD', targetDate, preferredAccn);
    return fact ? { ...fact, tagName } : null;
  };

  const families = [
    {
      totals: ['DebtAndCapitalLeaseObligations', 'LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities'],
      current: 'LongTermDebtAndCapitalLeaseObligationsCurrent',
      noncurrent: 'LongTermDebtAndCapitalLeaseObligations',
    },
    {
      totals: ['LongTermDebtAndFinanceLeaseObligations'],
      current: 'LongTermDebtAndFinanceLeaseObligationsCurrent',
      noncurrent: 'LongTermDebtAndFinanceLeaseObligationsNoncurrent',
    },
  ];

  for (const family of families) {
    const total = family.totals.map(get).find(Boolean) || null;
    const current = get(family.current);
    const noncurrent = get(family.noncurrent);
    const hasComponents = current && noncurrent;

    if (total && hasComponents && !debtValuesReconcile(total.value, [current.value, noncurrent.value])) {
      return { value: null, reason: 'consolidated debt total contradicts current/noncurrent components', facts: [total, current, noncurrent] };
    }
    if (total) return { value: total.value, reason: null, method: [total.tagName], facts: [total, current, noncurrent].filter(Boolean) };
    if (hasComponents) return { value: current.value + noncurrent.value, reason: null, method: [current.tagName, noncurrent.tagName], facts: [current, noncurrent] };
  }

  const current = get('LongTermDebtCurrent');
  const noncurrent = get('LongTermDebtNoncurrent');
  const shortTerm = get('ShortTermBorrowings');
  const facts = [current, noncurrent, shortTerm].filter(Boolean);
  if (!current || !noncurrent) {
    return {
      value: null,
      reason: facts.length
        ? 'incomplete conventional current/noncurrent debt representation'
        : 'no supported debt representation at balance date',
      facts,
    };
  }

  return {
    value: current.value + noncurrent.value + (shortTerm ? shortTerm.value : 0),
    reason: null,
    method: facts.map((fact) => fact.tagName),
    facts,
  };
}

function balanceInputsAt(usGaap, targetDate, preferredAccn) {
  const debt = selectDebtAt(usGaap, targetDate, preferredAccn);
  const equity = firstInstantFactAt(usGaap, [
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    'StockholdersEquity',
  ], targetDate, preferredAccn);
  const cash = firstInstantFactAt(usGaap, ['CashAndCashEquivalentsAtCarryingValue'], targetDate, preferredAccn);
  const assets = firstInstantFactAt(usGaap, ['Assets'], targetDate, preferredAccn);

  const investedCapital = Number.isFinite(debt.value) && equity && cash
    ? debt.value + equity.value - cash.value
    : null;

  return { targetDate, debt, equity, cash, assets, investedCapital };
}

function priorBalanceDate(periodStart) {
  const startMs = new Date(periodStart).getTime();
  return Number.isFinite(startMs) ? new Date(startMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
}

/* ---- per-company lookups ---- */
async function fetchSubmissions(cik) {
  const r = await client.getJSON(SEC_DATA + '/submissions/CIK' + cik + '.json', 'CIK' + cik + ' submissions');
  return r.ok ? r.data : null;
}

async function fetchCompanyFacts(cik) {
  const r = await client.getJSON(SEC_DATA + '/api/xbrl/companyfacts/CIK' + cik + '.json', 'CIK' + cik + ' companyfacts');
  return r.ok ? r.data : null;
}

async function fetchFundamentals(sym, options = {}) {
  const map = await ensureCikMap();
  // SEC's own files use dash for share classes (BRK-B); tickers coming from
  // universe.json / most market data use dot notation (BRK.B) - normalize.
  const secTicker = sym.toUpperCase().replace(/\./g, '-');
  const entry = map[secTicker] || map[sym.toUpperCase()];
  if (!entry) return {}; // not in SEC's map (e.g. wrong ticker/exchange) - let FMP cover it entirely

  const displayMetricsOnly = options.displayMetricsOnly === true;
  const [submissions, facts] = displayMetricsOnly
    ? [null, await fetchCompanyFacts(entry.cik)]
    : await Promise.all([
      fetchSubmissions(entry.cik),
      fetchCompanyFacts(entry.cik),
    ]);

  const usGaap = facts && facts.facts && facts.facts['us-gaap'];
  const dei = facts && facts.facts && facts.facts['dei'];
  const rawSic = displayMetricsOnly ? options.sic : submissions && submissions.sic;
  const sicNumber = Number(rawSic);
  const sic = Number.isFinite(sicNumber) && sicNumber > 0 ? sicNumber : null;
  const qualityMetricEligibilityReason = !Number.isInteger(sic)
    ? 'missing valid SIC for comparability check'
    : sic >= 6000 && sic <= 6499
      ? 'excluded financial institution SIC 6000-6499'
      : sic === 6798
        ? 'excluded REIT SIC 6798'
        : null;
  const excludedQualityMetricSector = qualityMetricEligibilityReason !== null;

  let roe = null;
  let debtEquity = null;
  let secEps = null;
  let secBookValuePerShare = null;
  let revenueGrowth = null;
  let epsGrowth = null;
  let fcfGrowth = null;
  let operatingMargin = null;
  let marginTrend = null;
  let annualOcf = null;
  let annualCapex = null;
  let annualFcf = null;
  let annualFcfPeriodStart = null;
  let annualFcfPeriodEnd = null;
  let sharesOutstanding = null;
  let roic = null;
  let fcfConversion = null;
  let roicAudit = { reason: 'missing SEC company facts' };
  let fcfConversionAudit = { reason: 'missing SEC company facts' };

  if (usGaap) {
    const netIncome = firstAvailable(usGaap, ['NetIncomeLoss', 'ProfitLoss'], (tag) => latestAnnual(tag, 'USD'));
    const equity = firstAvailable(
      usGaap,
      ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
      (tag) => latestInstant(tag, 'USD')
    );
    // ROE and Debt/Equity are not economically meaningful for this scoring
    // model when shareholder equity is zero or negative. Keep them null rather
    // than allowing negative equity to create misleading profitability or
    // artificially attractive negative leverage ratios.
    if (
      netIncome !== null &&
      equity !== null &&
      Number.isFinite(equity) &&
      equity > 0
    ) {
      roe = +((netIncome / equity) * 100).toFixed(2);
    }

    const debt = sumLatestInstant(
      usGaap,
      ['LongTermDebtNoncurrent', 'LongTermDebtCurrent', 'ShortTermBorrowings', 'DebtCurrent'],
      'USD'
    );

    // debtEquity means ACTUAL debt / shareholder equity only.
    // Do not substitute Total Liabilities / Equity under the same field name.
    if (
      debt !== null &&
      Number.isFinite(debt) &&
      equity !== null &&
      Number.isFinite(equity) &&
      equity > 0
    ) {
      debtEquity = +(debt / equity).toFixed(3);
    }


    // Revenue growth: compare the two most recent comparable annual 10-K periods.
    const revenueSeries = bestRevenueSeries(usGaap);
    const qualityRevenueSeries = bestQualityMetricRevenueSeries(usGaap);

    if (revenueSeries.length >= 2) {
      revenueGrowth = growthPct(
        revenueSeries[0].value,
        revenueSeries[1].value
      );
    }
    // Free cash flow growth:
    // OCF and CapEx MUST represent the exact same annual periods.
    const fcfPeriods = matchedAnnualPeriods(
      usGaap,
      ['NetCashProvidedByUsedInOperatingActivities'],
      [
        'PaymentsToAcquirePropertyPlantAndEquipment',
        'PaymentsForAdditionsToPropertyPlantAndEquipment'
      ],
      'USD'
    );

    if (fcfPeriods.length >= 1) {
      const currentOcf = fcfPeriods[0].numerator;
      const currentCapex = fcfPeriods[0].denominator;
      if (Number.isFinite(currentOcf) && Number.isFinite(currentCapex)) {
        annualOcf = currentOcf;
        annualCapex = currentCapex;
        annualFcf = currentOcf - Math.abs(currentCapex);
        annualFcfPeriodStart = fcfPeriods[0].start || null;
        annualFcfPeriodEnd = fcfPeriods[0].end || null;
      }
    }

    if (fcfPeriods.length >= 2) {
      const currentFcf =
        fcfPeriods[0].numerator - Math.abs(fcfPeriods[0].denominator);

      const priorFcf =
        fcfPeriods[1].numerator - Math.abs(fcfPeriods[1].denominator);

      // Relative floor, not a flat dollar amount: FCF near zero because a
      // capital-intensive company's OCF and CapEx happened to land close
      // together that year is a coincidence of timing, not a meaningful
      // "base" to grow from - and that coincidence is just as likely for a
      // $2B company as a $200B one, so the floor has to scale with company
      // size. Using that same period's OCF as the scale reference (rather
      // than a separately-fetched revenue series) since it's already in
      // scope and directly related to what FCF is derived from.
      const priorOcf = fcfPeriods[1].numerator;
      const fcfMinBase = Number.isFinite(priorOcf)
        ? Math.abs(priorOcf) * FCF_GROWTH_MIN_BASE_RATIO
        : undefined;

      fcfGrowth = positiveBaseGrowthPct(currentFcf, priorFcf, fcfMinBase);
    }

    // Operating margin and margin trend:
    // Operating income and revenue MUST represent the exact same annual period.
    const operatingIncomeSeries = firstAnnualSeries(
      usGaap,
      ['OperatingIncomeLoss'],
      'USD'
    );

    const operatingMarginPeriods = matchAnnualSeries(
      operatingIncomeSeries,
      revenueSeries
    );

    if (operatingMarginPeriods.length >= 1) {
      operatingMargin = ratioPct(
        operatingMarginPeriods[0].numerator,
        operatingMarginPeriods[0].denominator
      );
    }

    if (operatingMarginPeriods.length >= 2) {
      const currentMargin = ratioPct(
        operatingMarginPeriods[0].numerator,
        operatingMarginPeriods[0].denominator
      );

      const priorMargin = ratioPct(
        operatingMarginPeriods[1].numerator,
        operatingMarginPeriods[1].denominator
      );

      if (currentMargin !== null && priorMargin !== null) {
        marginTrend = +(currentMargin - priorMargin).toFixed(2);
      }
    }

    // Display-only annual GAAP ROIC. This is intentionally calculated outside
    // the existing scoring metrics and returned with a full internal audit
    // trail so every accepted or rejected input can be reconciled later.
    const operatingIncomeFact = operatingIncomeSeries[0] || null;
    if (!operatingIncomeFact) {
      roicAudit = {
        reason: excludedQualityMetricSector
          ? qualityMetricEligibilityReason
          : 'missing annual operating income',
      };
    } else {
      const period = { start: operatingIncomeFact.start, end: operatingIncomeFact.end };
      const taxSeries = firstAnnualSeries(usGaap, ['IncomeTaxExpenseBenefit'], 'USD');
      const pretaxSeries = firstAnnualSeries(usGaap, [
        'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
        'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments',
      ], 'USD');
      const taxFact = annualFactForPeriod(taxSeries, period, operatingIncomeFact.accn);
      const pretaxFact = annualFactForPeriod(pretaxSeries, period, operatingIncomeFact.accn);
      const begin = balanceInputsAt(usGaap, priorBalanceDate(period.start), operatingIncomeFact.accn);
      const end = balanceInputsAt(usGaap, period.end, operatingIncomeFact.accn);
      const audit = {
        reason: null,
        period,
        operatingIncome: operatingIncomeFact,
        taxExpense: taxFact,
        pretaxIncome: pretaxFact,
        begin,
        end,
      };

      if (excludedQualityMetricSector) audit.reason = qualityMetricEligibilityReason;
      else if (!annualPeriodIsCurrent(period.end)) audit.reason = 'annual period is stale or future-dated';
      else if (!taxFact || !pretaxFact) audit.reason = 'missing matching-period tax expense or pretax income';
      else if (!Number.isFinite(pretaxFact.value) || pretaxFact.value <= 0) audit.reason = 'pretax income is not positive';
      else if (begin.debt.reason || end.debt.reason) audit.reason = begin.debt.reason || end.debt.reason;
      else if (!begin.equity || !begin.cash || !begin.assets || !end.equity || !end.cash || !end.assets) audit.reason = 'missing beginning or ending equity, cash, or assets';
      else {
        const effectiveTaxRate = taxFact.value / pretaxFact.value;
        const averageInvestedCapital = (begin.investedCapital + end.investedCapital) / 2;
        const averageAssets = (begin.assets.value + end.assets.value) / 2;
        audit.effectiveTaxRate = effectiveTaxRate;
        audit.averageInvestedCapital = averageInvestedCapital;
        audit.averageAssets = averageAssets;

        if (!Number.isFinite(effectiveTaxRate) || effectiveTaxRate < 0 || effectiveTaxRate > 0.50) audit.reason = 'effective tax rate is outside 0%-50%';
        else if (![begin.investedCapital, end.investedCapital, averageInvestedCapital, averageAssets].every(Number.isFinite) ||
          begin.investedCapital <= 0 || end.investedCapital <= 0 || averageInvestedCapital <= 0 || averageAssets <= 0) {
          audit.reason = 'invested capital or assets are missing, non-finite, or nonpositive';
        } else if (averageInvestedCapital < averageAssets * 0.01) audit.reason = 'average invested capital is below 1% of average assets';
        else {
          const nopat = operatingIncomeFact.value * (1 - effectiveTaxRate);
          const rawRoic = (nopat / averageInvestedCapital) * 100;
          audit.nopat = nopat;
          audit.rawValue = rawRoic;
          if (Number.isFinite(rawRoic)) roic = +rawRoic.toFixed(4);
          else audit.reason = 'ROIC result is non-finite';
        }
      }
      roicAudit = audit;
    }

    // Display-only annual GAAP FCF conversion versus matching-period annual
    // GAAP net income. Negative FCF is preserved when the denominator is a
    // sufficiently meaningful positive earnings base.
    const ocfSeries = firstAnnualSeries(usGaap, ['NetCashProvidedByUsedInOperatingActivities'], 'USD');
    const capexSeries = firstAnnualSeries(usGaap, [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsForAdditionsToPropertyPlantAndEquipment',
    ], 'USD');
    const netIncomeSeries = firstAnnualSeries(usGaap, ['NetIncomeLoss', 'ProfitLoss'], 'USD');
    const ocfFact = ocfSeries[0] || null;
    if (!ocfFact) {
      fcfConversionAudit = { reason: 'missing annual operating cash flow' };
    } else {
      const period = { start: ocfFact.start, end: ocfFact.end };
      const capexFact = annualFactForPeriod(capexSeries, period, ocfFact.accn);
      const netIncomeFact = annualFactForPeriod(netIncomeSeries, period, ocfFact.accn);
      const revenueFact = annualFactForPeriod(qualityRevenueSeries, period, ocfFact.accn, true);
      const audit = { reason: null, period, operatingCashFlow: ocfFact, capex: capexFact, netIncome: netIncomeFact, revenue: revenueFact };

      if (excludedQualityMetricSector) audit.reason = qualityMetricEligibilityReason;
      else if (!annualPeriodIsCurrent(period.end)) audit.reason = 'annual period is stale or future-dated';
      else if (!capexFact || !netIncomeFact || !revenueFact) audit.reason = 'missing matching-period CapEx, net income, or revenue';
      else if (!Number.isFinite(netIncomeFact.value) || netIncomeFact.value <= 0) audit.reason = 'net income is not positive';
      else {
        const revenueFloor = revenueFact.value * 0.001;
        audit.revenueFloor = revenueFloor;
        if (!Number.isFinite(revenueFloor) || netIncomeFact.value < revenueFloor) audit.reason = 'net income is below 0.1% of annual revenue';
        else {
          const annualFcfForConversion = ocfFact.value - Math.abs(capexFact.value);
          const rawConversion = (annualFcfForConversion / netIncomeFact.value) * 100;
          audit.annualFcf = annualFcfForConversion;
          audit.rawValue = rawConversion;
          if (Number.isFinite(rawConversion)) fcfConversion = +rawConversion.toFixed(4);
          else audit.reason = 'FCF conversion result is non-finite';
        }
      }
      fcfConversionAudit = audit;
    }


    // EPS: prefer the figure companies actually file over deriving one, since
    // filed EPS already accounts for the correct GAAP share-count methodology.
    secEps = firstAvailable(usGaap, ['EarningsPerShareDiluted', 'EarningsPerShareBasic'], (tag) => latestAnnual(tag, 'USD/shares'));
    if (secEps === null && netIncome !== null) {
      const weightedShares = firstAvailable(
        usGaap,
        ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'],
        (tag) => latestAnnual(tag, 'shares')
      );
      if (weightedShares) secEps = +(netIncome / weightedShares).toFixed(4);
    }


    // EPS growth: compare the two most recent comparable annual EPS figures.
    const epsSeries = firstAnnualSeries(
      usGaap,
      [
        'EarningsPerShareDiluted',
        'EarningsPerShareBasic'
      ],
      'USD/shares'
    );

    if (epsSeries.length >= 2) {
      // Absolute floor: EPS is already a per-share, roughly cross-company
      // figure, so a flat dollar minimum (rather than a relative one, as
      // used for FCF below) is appropriate here. $0.25 is chosen to
      // decisively cover a company sitting at practical breakeven (a few
      // cents per share) without nulling out genuinely modest-but-real
      // small earners well above that.
      epsGrowth = positiveBaseGrowthPct(
        epsSeries[0].value,
        epsSeries[1].value,
        EPS_GROWTH_MIN_BASE
      );
    }

    // Book value per share: equity / period-end shares outstanding. dei's cover-page
    // figure is preferred (most current); us-gaap's balance-sheet tag is the fallback.
    sharesOutstanding = (dei && latestInstant(dei.EntityCommonStockSharesOutstanding, 'shares'))
      ?? latestInstant(usGaap.CommonStockSharesOutstanding, 'shares');
    if (equity && sharesOutstanding) secBookValuePerShare = +(equity / sharesOutstanding).toFixed(4);
  }

  const name = (submissions && submissions.name) || (facts && facts.entityName) || null;
  const sector = (submissions && submissions.sicDescription) || null;
  return {
    name,
    sector,
    roe,
    debtEquity,
    secEps,
    secBookValuePerShare,
    revenueGrowth,
    epsGrowth,
    fcfGrowth,
    operatingMargin,
    marginTrend,
    annualOcf,
    annualCapex,
    annualFcf,
    annualFcfPeriodStart,
    annualFcfPeriodEnd,
    roic,
    fcfConversion,
    roicAudit,
    fcfConversionAudit,
    sharesOutstanding: Number.isFinite(sharesOutstanding) && sharesOutstanding > 0 ? sharesOutstanding : null,
    sic,
  };
}

// Controlled population entry point for the display-only annual quality
// metrics. It performs exactly one SEC Company Facts request, reuses the SIC
// already cached by the normal fundamentals pipeline, and returns no unrelated
// fields for persistence.
async function fetchDisplayQualityMetrics(sym, sic) {
  const result = await fetchFundamentals(sym, { displayMetricsOnly: true, sic });
  return {
    roic: result.roic ?? null,
    fcfConversion: result.fcfConversion ?? null,
    roicAudit: result.roicAudit || { reason: 'missing SEC CIK mapping' },
    fcfConversionAudit: result.fcfConversionAudit || { reason: 'missing SEC CIK mapping' },
  };
}

module.exports = {
  name: 'sec',
  health: client.health,
  fetchFundamentals,
  fetchDisplayQualityMetrics,
};
