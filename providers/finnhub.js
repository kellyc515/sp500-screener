/**
 * Finnhub adapter. Supplies analyst consensus, news/sentiment, live price,
 * and basic-financials metrics (beta, EPS, book value/share, 13/26-week price
 * returns) - all confirmed on the free tier. /stock/candle (raw historical
 * bars) is premium-only (confirmed: 403 "You don't have access to this
 * resource") - the pre-computed 13/26-week return fields on /stock/metric are
 * the free-tier equivalent for ret3m/ret6m, and come from a call already made
 * for beta/EPS, so no extra request is needed to get them.
 */

const { createHttpClient } = require('./httpClient');

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

const client = createHttpClient({ name: 'finnhub', pacingMs: 1100, maxAttempts: 2, treatAny429AsQuota: false });

const key = () => process.env.FINNHUB_API_KEY;
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
// Strict parsing is intentionally limited to the two new display-only fields.
// Existing scoring inputs keep their established parsing behavior unchanged.
const finiteMetricNum = (v) => {
  if ((typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ymd = (d) => d.toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
const EBITDA_SERIES_MAX_AGE_MS = 200 * DAY_MS;

// Build the complete validation packet for display-only TTM EBITDA metrics.
// Finnhub reports quarterly EBITDA, enterprise value, and market cap in USD
// millions. Nothing here feeds an existing scoring input.
function validateTtmEbitda(quarterlyEbitda, rawMetrics, nowMs = Date.now()) {
  const enterpriseValue = finiteMetricNum(rawMetrics.enterpriseValue);
  const marketCapitalization = finiteMetricNum(rawMetrics.marketCapitalization);
  const evEbitdaTTM = finiteMetricNum(rawMetrics.evEbitdaTTM);
  const ebitdPerShareTTM = finiteMetricNum(rawMetrics.ebitdPerShareTTM);
  const audit = {
    reason: null,
    quarterlyEbitda,
    unit: 'USD millions',
    enterpriseValue,
    marketCapitalization,
    evEbitdaTTM,
    ebitdPerShareTTM,
    ttmEbitda: null,
    latestPeriod: quarterlyEbitda[0] ? quarterlyEbitda[0].period : null,
    spanDays: null,
    gapDays: [],
    evDerivedEbitda: null,
    crosscheckDifferencePct: null,
    companyScale: null,
    ebitdaCompanyScalePct: null,
  };

  if (quarterlyEbitda.length < 4 || quarterlyEbitda.some((row) => !Number.isFinite(row.value))) {
    audit.reason = 'quarterly_ebitda_incomplete_or_nonfinite';
    return audit;
  }

  const latestFour = quarterlyEbitda.slice(0, 4);
  const dates = latestFour.map((row) => new Date(row.period).getTime());
  if (dates.some((value) => !Number.isFinite(value))) {
    audit.reason = 'quarterly_ebitda_invalid_period';
    return audit;
  }
  if (new Set(dates).size !== 4) {
    audit.reason = 'quarterly_ebitda_duplicate_period';
    return audit;
  }
  if (dates[0] > nowMs + 14 * DAY_MS) {
    audit.reason = 'quarterly_ebitda_future_dated';
    return audit;
  }
  if (nowMs - dates[0] > EBITDA_SERIES_MAX_AGE_MS) {
    audit.reason = 'quarterly_ebitda_stale';
    return audit;
  }

  audit.spanDays = (dates[0] - dates[3]) / DAY_MS;
  audit.gapDays = [0, 1, 2].map((index) => (dates[index] - dates[index + 1]) / DAY_MS);
  if (audit.spanDays < 200 || audit.spanDays > 400) {
    audit.reason = 'quarterly_ebitda_period_span_invalid';
    return audit;
  }
  if (audit.gapDays.some((days) => days < 45 || days > 140)) {
    audit.reason = 'quarterly_ebitda_period_gap_invalid';
    return audit;
  }

  audit.ttmEbitda = latestFour.reduce((sum, row) => sum + row.value, 0);
  if (!Number.isFinite(audit.ttmEbitda) || audit.ttmEbitda <= 0) {
    audit.reason = 'quarterly_ebitda_nonpositive';
    return audit;
  }

  if (!Number.isFinite(enterpriseValue) || !Number.isFinite(evEbitdaTTM) || evEbitdaTTM === 0) {
    audit.reason = 'ev_ebitda_crosscheck_missing_or_zero';
    return audit;
  }
  audit.evDerivedEbitda = enterpriseValue / evEbitdaTTM;
  if (!Number.isFinite(audit.evDerivedEbitda) || audit.evDerivedEbitda <= 0) {
    audit.reason = 'ev_derived_ebitda_nonpositive';
    return audit;
  }
  audit.crosscheckDifferencePct = Math.abs(audit.evDerivedEbitda - audit.ttmEbitda) /
    Math.abs(audit.ttmEbitda) * 100;
  if (!Number.isFinite(audit.crosscheckDifferencePct) || audit.crosscheckDifferencePct > 10) {
    audit.reason = 'ebitda_crosscheck_contradiction';
    return audit;
  }
  if (!Number.isFinite(ebitdPerShareTTM) || ebitdPerShareTTM <= 0) {
    audit.reason = 'ebitda_per_share_missing_or_nonpositive';
    return audit;
  }

  audit.companyScale = Number.isFinite(marketCapitalization)
    ? Math.max(Math.abs(enterpriseValue), marketCapitalization)
    : null;
  audit.ebitdaCompanyScalePct = Number.isFinite(audit.companyScale) && audit.companyScale > 0
    ? audit.ttmEbitda / audit.companyScale * 100
    : null;
  if (!Number.isFinite(audit.ebitdaCompanyScalePct) || audit.ebitdaCompanyScalePct < 0.5) {
    audit.reason = 'quarterly_ebitda_too_small_relative_to_company_scale';
  }
  return audit;
}

async function fetchQuote(sym) {
  const r = await client.getJSON(FINNHUB_BASE + '/quote?symbol=' + sym + '&token=' + key(), sym + ' quote');
  if (!r.ok) return {};
  const price = num(r.data.c);
  // Finnhub returns c:0 (and every other field 0) for an unrecognized symbol
  // instead of an HTTP error - treat non-positive price as "no data", not real.
  if (price === null || price <= 0) return {};
  return { price };
}

async function fetchMetrics(sym) {
  const r = await client.getJSON(FINNHUB_BASE + '/stock/metric?symbol=' + sym + '&metric=all&token=' + key(), sym + ' metrics');
  if (!r.ok) return {};
  const m = (r.data && r.data.metric) || {};
  const quarterlyEbitda = ((((r.data || {}).series || {}).quarterly || {}).ebitda || [])
    .map((row) => ({ period: row && row.period, value: finiteMetricNum(row && row.v) }))
    .filter((row) => row.period && row.value !== null)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))
    .slice(0, 4);
  const ttmEbitdaAudit = validateTtmEbitda(quarterlyEbitda, m);
  return {
    beta: num(m.beta),
    epsTTM: num(m.epsTTM),
    bookValuePerShare: num(m.bookValuePerShareQuarterly ?? m.bookValuePerShareAnnual),
    ret3m: num(m['13WeekPriceReturnDaily']),
    ret6m: num(m['26WeekPriceReturnDaily']),
    // Same free-tier response as ret3m/ret6m above (this call already returns
    // 133 fields total; most go unused) - 52WeekPriceReturnDaily and
    // 52WeekHigh were sitting there unextracted. Raw pass-through only;
    // pctBelow52wHigh is computed in fetchData.js's fetchValuation(), which
    // is where price (a separate Finnhub call) is already combined with
    // these metrics for pe/pb, so it's the natural place to combine price
    // with week52High too rather than duplicating that pattern here.
    ret1y: finiteMetricNum(m['52WeekPriceReturnDaily']),
    week52High: finiteMetricNum(m['52WeekHigh']),
    evEbitdaTTM: finiteMetricNum(m.evEbitdaTTM),
    ebitdPerShareTTM: finiteMetricNum(m.ebitdPerShareTTM),
    enterpriseValue: finiteMetricNum(m.enterpriseValue),
    // Validation-only cross-check for class/share-count mismatches in the
    // SEC-shares x cached-price FCF-yield denominator. Finnhub reports this
    // field in USD millions; it is never used as the denominator itself.
    marketCapitalization: finiteMetricNum(m.marketCapitalization),
    quarterlyEbitda,
    ttmEbitda: ttmEbitdaAudit.reason === null ? ttmEbitdaAudit.ttmEbitda : null,
    ttmEbitdaLatestPeriod: ttmEbitdaAudit.latestPeriod,
    ttmEbitdaAudit,
  };
}

async function fetchAnalyst(sym) {
  const r = await client.getJSON(FINNHUB_BASE + '/stock/recommendation?symbol=' + sym + '&token=' + key(), sym + ' analyst');
  if (!r.ok) return {};
  const arr = r.data;
  if (!Array.isArray(arr) || arr.length === 0) return {};
  const latest = [...arr].sort((a, b) => (a.period < b.period ? 1 : -1))[0];
  const sb = latest.strongBuy || 0, b = latest.buy || 0, h = latest.hold || 0, s = latest.sell || 0, ss = latest.strongSell || 0;
  const total = sb + b + h + s + ss;
  if (!total) return {};
  const score = ((sb * 1 + b * 0.75 + h * 0.5 + s * 0.25 + ss * 0) / total) * 100;
  return { analyst: +score.toFixed(1) };
}

const POS = ['beat', 'beats', 'surge', 'surges', 'upgrade', 'upgraded', 'record', 'rally', 'gains', 'strong', 'outperform', 'bullish', 'jumps', 'soars', 'tops', 'raises', 'profit', 'wins', 'breakthrough', 'approval', 'expands', 'growth'];
const NEG = ['miss', 'misses', 'plunge', 'plunges', 'downgrade', 'downgraded', 'cut', 'cuts', 'lawsuit', 'probe', 'decline', 'falls', 'weak', 'underperform', 'bearish', 'drops', 'slumps', 'warns', 'loss', 'losses', 'recall', 'investigation', 'layoffs', 'bankruptcy', 'fraud', 'slashes'];

async function fetchSentiment(sym) {
  const to = new Date();
  const from = new Date(Date.now() - 21 * 864e5);
  const url = FINNHUB_BASE + '/company-news?symbol=' + sym + '&from=' + ymd(from) + '&to=' + ymd(to) + '&token=' + key();
  const r = await client.getJSON(url, sym + ' news');
  if (!r.ok) return {};
  const arr = r.data;
  if (!Array.isArray(arr) || arr.length === 0) return {};
  let sum = 0, counted = 0;
  for (const it of arr.slice(0, 40)) {
    const text = ((it.headline || '') + ' ' + (it.summary || '')).toLowerCase();
    let p = 0, n = 0;
    for (const w of POS) if (text.includes(w)) p++;
    for (const w of NEG) if (text.includes(w)) n++;
    if (p || n) { sum += Math.sign(p - n); counted++; }
  }
  // Real headlines/links for the detail panel - kept alongside the keyword
  // sentiment score, from the same call, no extra request. Headlines/links
  // only, no synthesis - that stays deferred to a later research phase.
  const headlines = arr
    .filter((it) => it.headline && it.url)
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
    .slice(0, 6)
    .map((it) => ({
      title: it.headline,
      url: it.url,
      source: it.source || null,
      date: it.datetime ? new Date(it.datetime * 1000).toISOString().slice(0, 10) : null,
    }));
  return { sentiment: counted ? +(sum / counted).toFixed(3) : 0, headlines };
}

module.exports = {
  name: 'finnhub',
  health: client.health,
  fetchQuote,
  fetchMetrics,
  fetchAnalyst,
  fetchSentiment,
  validateTtmEbitda,
};
