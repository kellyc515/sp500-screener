/**
 * PHASE 6 — research pipeline + operational layer (queue + staleness).
 *
 * Two responsibilities:
 * 1. Compute today's research queue: diff the current (corrected-score)
 *    candidate set against research/*.json, categorize each candidate as
 *    NEW / STALE_AGE / STALE_FILING / FRESH, flag ORPHANED research (files
 *    for tickers no longer flagged), write research-queue.json, print a
 *    console summary. screener.js reads research-queue.json (read-only) to
 *    show freshness badges in the report - it never makes a live SEC call
 *    itself.
 * 2. Fetch + extract (NOT analyze) SEC filing packets for the queued
 *    (NEW + STALE, capped) tickers, same as before - research/_packets/
 *    <ticker>.json, for a human (or Claude, in this project) to read and
 *    write the actual sourced research/<ticker>.json from. The LLM analysis
 *    step is still explicitly not automated here.
 *
 * Candidate selection reuses screener.js's own scoring/classification
 * (module.exports added there for exactly this - require()'ing it no longer
 * runs its main(), so this never touches companies.json or the report).
 *
 * Run: node research.js
 */

const fs = require('fs');
const path = require('path');
const { scoreUniverse, loadCompanies, loadWatchlist, CLASSIFICATION, selectResearchCandidates } = require('./screener.js');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(path.join(__dirname, '.env'));

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'ScreenerResearchTool/1.0 (contreraskelly515@gmail.com)';
const SEC_DATA = 'https://data.sec.gov';
const SEC_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';

const RESEARCH_DIR = path.join(__dirname, 'research');
const PACKET_DIR = path.join(RESEARCH_DIR, '_packets');
fs.mkdirSync(PACKET_DIR, { recursive: true });

// Tunable cap on how many tickers' worth of (re)research a single run will
// fetch/extract packets for - keeps one invocation bounded regardless of
// how large the flagged-candidate union gets. Applies to the NEW+STALE
// queue, not to the raw candidate count (FRESH tickers need no work and
// never count against it).
const MAX_RESEARCH_PER_RUN = 25;

// A research note older than this (by researchedAt) is stale by age,
// regardless of whether anything is known to have changed - SEC quarterly
// cadence is ~90 days, so 14 gives several checks per filing cycle without
// re-running names that haven't had time to meaningfully move.
const RESEARCH_STALE_DAYS = 14;

const QUEUE_REASON_PRIORITY = { STALE_FILING: 0, NEW: 1, STALE_AGE: 2 };

function researchFilePath(ticker) {
  return path.join(RESEARCH_DIR, ticker + '.json');
}

function existingResearchTickers() {
  if (!fs.existsSync(RESEARCH_DIR)) return [];
  return fs.readdirSync(RESEARCH_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

// Latest filing date on record per form type, straight from SEC submissions
// - same endpoint latestFilings() already uses, just scanning all forms
// instead of only 10-Q/10-K, and returning dates rather than fetching text.
async function latestFilingDatesByForm(cik) {
  const data = await getJSON(SEC_DATA + '/submissions/CIK' + cik + '.json');
  const r = data.filings.recent;
  const latest = { '10-Q': null, '10-K': null, '8-K': null };
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if (form in latest && (!latest[form] || r.filingDate[i] > latest[form])) {
      latest[form] = r.filingDate[i];
    }
  }
  return latest;
}

function latestKnownFilingDate(researchNote) {
  const dates = (researchNote.filingsUsed || []).map((f) => f.filingDate).filter(Boolean);
  return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
}

function ageDaysSince(isoTimestamp) {
  return (Date.now() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60 * 24);
}

// Categorizes ONE candidate that already has a research file: STALE_FILING
// takes priority over STALE_AGE when both are true (a concrete new filing
// is more informative than "just old"), FRESH otherwise. Makes one live SEC
// call (submissions.json) - the only network activity in the queue-build
// phase, separate from the actual packet-fetch phase later.
async function categorizeExisting(ticker, cikEntry) {
  const notePath = researchFilePath(ticker);
  const note = JSON.parse(fs.readFileSync(notePath, 'utf8'));
  const researchedAt = note.researchedAt;
  const ageDays = researchedAt ? ageDaysSince(researchedAt) : Infinity;
  const knownDate = latestKnownFilingDate(note);

  if (cikEntry && knownDate) {
    try {
      const latest = await latestFilingDatesByForm(cikEntry.cik);
      for (const form of ['10-Q', '10-K', '8-K']) {
        if (latest[form] && latest[form] > knownDate) {
          return { reason: 'STALE_FILING', researchedAt, newFiling: { form, filingDate: latest[form] }, priorLatestFilingDate: knownDate };
        }
      }
    } catch (err) {
      // A failed freshness check should never block the run - fall through
      // to the age-only judgment rather than throwing candidates out.
      console.warn('  ! filing freshness check failed for ' + ticker + ': ' + err.message);
    }
  }

  if (ageDays > RESEARCH_STALE_DAYS) {
    return { reason: 'STALE_AGE', researchedAt, ageDays: Math.round(ageDays) };
  }
  return { reason: 'FRESH', researchedAt };
}

// Builds research-queue.json: diffs today's (corrected-score) candidate set
// against research/*.json, categorizes every candidate, flags orphaned
// research, prioritizes and caps the actual to-do list. Read-only against
// companies.json/research/*.json except for the one file this writes.
async function buildResearchQueue(cikMap) {
  const scored = scoreUniverse(loadCompanies());
  const watchlist = loadWatchlist();
  const candidates = selectResearchCandidates(scored, watchlist); // [{ticker, tier}], uncapped
  const candidateTickers = new Set(candidates.map((c) => c.ticker));

  const queueItems = [];
  const fresh = [];
  for (const { ticker, tier } of candidates) {
    if (!fs.existsSync(researchFilePath(ticker))) {
      queueItems.push({ ticker, tier, reason: 'NEW' });
      continue;
    }
    const cikEntry = cikMap.tickers[ticker];
    const result = await categorizeExisting(ticker, cikEntry);
    await sleep(250);
    if (result.reason === 'FRESH') {
      fresh.push(ticker);
    } else {
      queueItems.push({ ticker, tier, ...result });
    }
  }

  const orphaned = existingResearchTickers()
    .filter((t) => !candidateTickers.has(t))
    .map((t) => {
      const note = readJSONSafe(researchFilePath(t));
      return { ticker: t, researchedAt: note && note.researchedAt, note: 'No longer a current candidate as of today\'s scores - may be stale.' };
    });

  const tierOrder = { watchlist: 0, trap: 1, highBoth: 2, rest: 3 };
  queueItems.sort((a, b) => {
    const tierDiff = (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9);
    if (tierDiff !== 0) return tierDiff;
    return QUEUE_REASON_PRIORITY[a.reason] - QUEUE_REASON_PRIORITY[b.reason];
  });

  const queue = queueItems.slice(0, MAX_RESEARCH_PER_RUN);
  const cappedOut = queueItems.slice(MAX_RESEARCH_PER_RUN);

  const result = {
    generatedAt: new Date().toISOString(),
    staleAgeThresholdDays: RESEARCH_STALE_DAYS,
    candidateCount: candidates.length,
    maxResearchPerRun: MAX_RESEARCH_PER_RUN,
    queue,
    fresh,
    orphaned,
    cappedOut,
  };

  fs.writeFileSync(path.join(__dirname, 'research-queue.json'), JSON.stringify(result, null, 2));
  return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: '*/*' } });
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  return res.text();
}
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  return res.json();
}

function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/* ---- section extraction ----
 * Reliability note (also surfaced in the packet itself): SEC filings have no
 * enforced machine-readable section boundaries. This looks for known heading
 * phrases and picks the occurrence followed by the most subsequent content
 * before the next candidate heading (the real section), rejecting short
 * matches that are almost always table-of-contents entries. This worked
 * cleanly on EIX's filing (a joint EIX/SCE filer, one of the harder cases -
 * standard "Item 2."-style numbering was NOT reliably locatable there, but
 * the descriptive heading phrase was). It is a heuristic, not a guarantee -
 * flagged per-section as 'located' or 'not located' rather than silently
 * returning nothing or the wrong text.
 */
const MDA_HEADINGS = [
  "MANAGEMENT'S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS",
  "MANAGEMENT'S DISCUSSION AND ANALYSIS",
];
const RISK_HEADINGS = [
  'RISK FACTORS',
];
const NEXT_HEADINGS = [
  'QUANTITATIVE AND QUALITATIVE DISCLOSURES ABOUT MARKET RISK',
  'CONTROLS AND PROCEDURES',
  'LEGAL PROCEEDINGS',
  'UNREGISTERED SALES',
  'EXHIBITS',
  'SIGNATURES',
  'FINANCIAL STATEMENTS',
];

function findBestHeading(text, headingCandidates) {
  let best = null;
  for (const heading of headingCandidates) {
    const re = new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let m;
    while ((m = re.exec(text))) {
      // reject if this looks like a TOC entry: very little content (<300 chars)
      // before the next occurrence of ANY heading-like short line
      const after = text.slice(m.index, m.index + 2000);
      const isSubstantial = after.length > 800 && !/^\s*\S+.{0,80}\n?\d{1,3}\s/.test(after);
      if (isSubstantial && (!best || m.index > best.index)) {
        best = { index: m.index, heading };
      }
    }
  }
  return best;
}

function extractSection(text, startHeadings, label) {
  const start = findBestHeading(text, startHeadings);
  if (!start) return { located: false, label, text: null, charRange: null };
  let endIdx = text.length;
  for (const h of NEXT_HEADINGS) {
    const idx = text.indexOf(h, start.index + 500);
    if (idx !== -1 && idx < endIdx) endIdx = idx;
  }
  // cap length so we never hand over a whole filing even if boundary detection fails wide
  endIdx = Math.min(endIdx, start.index + 15000);
  return {
    located: true,
    label,
    matchedHeading: start.heading,
    text: text.slice(start.index, endIdx).trim(),
    charRange: [start.index, endIdx],
  };
}

// Keyword-in-context scan: a robustness net alongside section extraction,
// not a replacement for it - directly useful for targeted questions (e.g.
// "does this filing mention wildfire liability") regardless of which named
// section the mention falls in.
const SCAN_KEYWORDS = [
  'wildfire', 'litigation', 'class action', 'guidance', 'outlook',
  'impairment', 'rate case', 'regulatory', 'settlement', 'liability',
];
function keywordContexts(text, keywords, maxPerKeyword) {
  const out = {};
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    const hits = [];
    let from = 0;
    while (hits.length < maxPerKeyword) {
      const idx = lower.indexOf(kw.toLowerCase(), from);
      if (idx === -1) break;
      hits.push({
        charIndex: idx,
        context: text.slice(Math.max(0, idx - 250), idx + 350).trim(),
      });
      from = idx + kw.length;
    }
    if (hits.length) out[kw] = hits;
  }
  return out;
}

/* ---- filings list + fetch ---- */
async function latestFilings(cik) {
  const data = await getJSON(SEC_DATA + '/submissions/CIK' + cik + '.json');
  const r = data.filings.recent;
  const byForm = { '10-Q': null, '10-K': null };
  for (let i = 0; i < r.form.length; i++) {
    const form = r.form[i];
    if ((form === '10-Q' || form === '10-K') && !byForm[form]) {
      const accessionNoDashes = r.accessionNumber[i].replace(/-/g, '');
      const cikNoZeros = String(Number(cik));
      byForm[form] = {
        form,
        filingDate: r.filingDate[i],
        reportDate: r.reportDate[i],
        accessionNumber: r.accessionNumber[i],
        primaryDocument: r.primaryDocument[i],
        url: SEC_ARCHIVES + '/' + cikNoZeros + '/' + accessionNoDashes + '/' + r.primaryDocument[i],
        filingIndexUrl: SEC_ARCHIVES + '/' + cikNoZeros + '/' + accessionNoDashes + '/',
      };
    }
  }
  return { entityName: data.name, byForm };
}

/* ---- multi-period XBRL trend (Revenues, EPS, operating margin inputs) ---- */
const REVENUE_TAGS = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax'];
const EPS_TAGS = ['EarningsPerShareDiluted', 'EarningsPerShareBasic'];
const NET_INCOME_TAGS = ['NetIncomeLoss', 'ProfitLoss'];
const OPERATING_INCOME_TAGS = ['OperatingIncomeLoss'];

function periodsForTag(facts, tagNames, unitKeyGuess) {
  for (const tag of tagNames) {
    const t = facts && facts[tag];
    if (!t || !t.units) continue;
    const arr = t.units[unitKeyGuess] || Object.values(t.units)[0];
    if (Array.isArray(arr) && arr.length) {
      const annualQtd = arr.filter((e) => e.form && (e.form.startsWith('10-K') || e.form.startsWith('10-Q')));
      const pool = annualQtd.length ? annualQtd : arr;
      return { tag, points: [...pool].sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, 8) };
    }
  }
  return { tag: null, points: [] };
}

async function fetchTrend(cik) {
  const data = await getJSON(SEC_DATA + '/api/xbrl/companyfacts/CIK' + cik + '.json');
  const usGaap = data.facts && data.facts['us-gaap'];
  if (!usGaap) return { revenue: null, eps: null, netIncome: null, operatingIncome: null };
  return {
    revenue: periodsForTag(usGaap, REVENUE_TAGS, 'USD'),
    eps: periodsForTag(usGaap, EPS_TAGS, 'USD/shares'),
    netIncome: periodsForTag(usGaap, NET_INCOME_TAGS, 'USD'),
    operatingIncome: periodsForTag(usGaap, OPERATING_INCOME_TAGS, 'USD'),
  };
}

/* ---- existing project data (news cache, companies.json) ---- */
function readJSONSafe(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadExistingData(ticker) {
  const newsCache = readJSONSafe(path.join(__dirname, 'cache', 'news.json')) || {};
  const companies = readJSONSafe(path.join(__dirname, 'companies.json')) || [];
  const company = companies.find((c) => c.ticker === ticker) || null;
  const newsEntry = newsCache[ticker] || {};
  return {
    companyMetrics: company,
    cachedHeadlines: newsEntry.headlines || [],
    newsAsOf: newsEntry.updatedAt || null,
  };
}

async function buildPacket(ticker, cikMap) {
  console.log('\n  === ' + ticker + ' ===');
  const cikEntry = cikMap.tickers[ticker];
  if (!cikEntry) throw new Error(ticker + ' not found in SEC ticker/CIK map');
  const cik = cikEntry.cik;

  console.log('  fetching filing list...');
  const filingsInfo = await latestFilings(cik);
  await sleep(300);

  const filingExtracts = {};
  for (const form of ['10-Q', '10-K']) {
    const f = filingsInfo.byForm[form];
    if (!f) { filingExtracts[form] = null; continue; }
    console.log('  fetching ' + form + ' (' + f.filingDate + '): ' + f.url);
    const html = await getText(f.url);
    await sleep(300);
    const text = htmlToText(html);
    const mda = extractSection(text, MDA_HEADINGS, 'MD&A');
    const risk = extractSection(text, RISK_HEADINGS, 'Risk Factors');
    const keywordScan = keywordContexts(text, SCAN_KEYWORDS, 3);
    filingExtracts[form] = {
      meta: f,
      textLength: text.length,
      mda,
      riskFactors: risk,
      keywordScan,
    };
  }

  console.log('  fetching XBRL multi-period trend...');
  const trend = await fetchTrend(cik);
  await sleep(300);

  const existing = loadExistingData(ticker);

  const packet = {
    ticker,
    entityName: filingsInfo.entityName,
    cik,
    generatedAt: new Date().toISOString(),
    filings: filingExtracts,
    xbrlTrend: trend,
    companyMetrics: existing.companyMetrics,
    cachedNews: { headlines: existing.cachedHeadlines, cachedAt: existing.newsAsOf },
  };

  const outPath = path.join(PACKET_DIR, ticker + '.json');
  fs.writeFileSync(outPath, JSON.stringify(packet, null, 2));
  console.log('  packet written -> ' + outPath);
  return packet;
}

function printQueueSummary(result) {
  console.log('\n  Candidates today (flagged by current scores): ' + result.candidateCount);
  console.log('  Fresh (skipped, no work needed): ' + result.fresh.length);
  console.log('  Needs (re)research: ' + (result.queue.length + result.cappedOut.length)
    + ' (queued this run: ' + result.queue.length + ', cap ' + result.maxResearchPerRun + ')');
  if (result.queue.length) {
    console.log('\n  Queue (' + result.queue.length + '):');
    for (const item of result.queue) {
      let detail = '';
      if (item.reason === 'STALE_AGE') detail = 'researched ' + item.ageDays + 'd ago (>' + result.staleAgeThresholdDays + 'd threshold)';
      if (item.reason === 'STALE_FILING') detail = 'new ' + item.newFiling.form + ' filed ' + item.newFiling.filingDate + ' (research covered through ' + item.priorLatestFilingDate + ')';
      if (item.reason === 'NEW') detail = 'no research file exists';
      console.log('   ' + item.ticker.padEnd(6) + item.reason.padEnd(14) + '[' + item.tier + ']  ' + detail);
    }
  }
  if (result.cappedOut.length) {
    console.log('\n  Cut by cap, carries to next run: ' + result.cappedOut.map((i) => i.ticker + '(' + i.reason + ')').join(', '));
  }
  if (result.orphaned.length) {
    console.log('\n  Orphaned research (' + result.orphaned.length + ', not touched): ' + result.orphaned.map((o) => o.ticker).join(', '));
  }
  console.log('\n  research-queue.json written (generated ' + result.generatedAt + ')');
}

async function main() {
  const cikMap = readJSONSafe(path.join(__dirname, 'cache', 'sec-cik-map.json'));
  if (!cikMap) { console.error('cache/sec-cik-map.json not found - run fetchData.js at least once first'); process.exit(1); }

  console.log('\n  Building research queue (diffing current scores against research/*.json, checking SEC filing dates)...');
  const result = await buildResearchQueue(cikMap);
  printQueueSummary(result);

  if (process.argv.includes('--queue-only')) {
    console.log('\n  --queue-only: stopping before fetch. Run `node research.js` (no flag) to fetch packets for the queue above.\n');
    return;
  }

  const selected = result.queue.map((item) => item.ticker);
  if (!selected.length) { console.log('\n  Nothing to fetch this run - queue is empty.\n'); return; }

  const results = { ok: [], failed: [] };
  for (let i = 0; i < selected.length; i++) {
    const ticker = selected[i];
    console.log('\n  [' + (i + 1) + '/' + selected.length + '] ' + ticker);
    try {
      await buildPacket(ticker, cikMap);
      results.ok.push(ticker);
    } catch (err) {
      console.error('  ! ' + ticker + ' failed: ' + err.message);
      results.failed.push({ ticker, error: err.message });
    }
  }

  console.log('\n  Packets fetched: ' + results.ok.length + '/' + selected.length);
  if (results.failed.length) {
    console.log('  Failed (no packet, skipped): ' + results.failed.map((f) => f.ticker).join(', '));
  }
  console.log('\nDone. Packets in research/_packets/ - read them and write research/<ticker>.json with the actual sourced analysis.\n');
}

main();
