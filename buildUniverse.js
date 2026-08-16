/**
 * UNIVERSE BUILDER — writes universe.json (ticker, name, sector, exchange).
 * A separate, occasional job - not part of the daily run. Re-run this
 * whenever you want to refresh S&P 500 membership; fetchData.js just reads
 * whatever universe.json currently contains.
 *
 * Sources (both free, no API key, zero FMP/Finnhub quota used):
 *   - S&P 500 constituent list: datasets/s-and-p-500-companies (GitHub, CSV)
 *   - Exchange per ticker: SEC's bulk company_tickers_exchange.json
 *
 * Run:  node buildUniverse.js
 */

const fs = require('fs');
const path = require('path');

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'ScreenerResearchTool/1.0 (contreraskelly515@gmail.com)';
const SP500_CSV_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const SEC_EXCHANGE_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const OUT_PATH = path.join(__dirname, 'universe.json');

/* ---- minimal CSV parser (handles quoted fields with embedded commas) ---- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Eligibility is intentionally permissive (ROADMAP 2.2): momentum, price trend,
// P/E, analyst rating, and growth are never eligibility gates. The S&P 500
// constituent list is already pure U.S. common-stock membership (no ETFs,
// closed-end funds, preferreds, or warrants can appear in it), so this is a
// thin, documented pass-through today. If the universe later expands beyond
// S&P 500, this is the function to extend with real security-type filtering.
function isEligible(row) {
  return Boolean(row.ticker && row.name);
}

async function fetchText(url, label) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT } });
  if (!res.ok) throw new Error(label + ': HTTP ' + res.status);
  return res.text();
}

async function fetchJSON(url, label) {
  const res = await fetch(url, { headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(label + ': HTTP ' + res.status);
  return res.json();
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function main() {
  console.log('\n  Fetching S&P 500 constituent list...');
  const csvText = await fetchText(SP500_CSV_URL, 'S&P 500 CSV');
  const rows = parseCSV(csvText);
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const iSymbol = col('Symbol'), iName = col('Security'), iSector = col('GICS Sector');
  if (iSymbol === -1 || iName === -1) throw new Error('S&P 500 CSV shape changed - expected Symbol/Security columns');

  console.log('  Fetching SEC exchange listing (for exchange per ticker)...');
  const secExchange = await fetchJSON(SEC_EXCHANGE_URL, 'SEC exchange file');
  const exByTicker = new Map();
  const iCik = secExchange.fields.indexOf('cik');
  const iTicker = secExchange.fields.indexOf('ticker');
  const iExchange = secExchange.fields.indexOf('exchange');
  for (const rec of secExchange.data) {
    exByTicker.set(String(rec[iTicker]).toUpperCase(), rec[iExchange] || null);
  }

  const constituents = [];
  let missingExchange = 0;
  for (const r of rows.slice(1)) {
    if (!r[iSymbol]) continue;
    const ticker = r[iSymbol].trim().toUpperCase();
    const row = { ticker, name: (r[iName] || '').trim() };
    if (!isEligible(row)) continue;

    // SEC uses dash for share classes (BRK-B); the S&P 500 list uses dot (BRK.B).
    const secTicker = ticker.replace(/\./g, '-');
    const exchange = exByTicker.get(secTicker) || exByTicker.get(ticker) || null;
    if (!exchange) missingExchange++;

    constituents.push({
      ticker,
      name: row.name,
      sector: iSector !== -1 ? (r[iSector] || '').trim() || null : null,
      exchange,
    });
  }

  const universe = {
    generatedAt: new Date().toISOString(),
    source: SP500_CSV_URL + ' + ' + SEC_EXCHANGE_URL,
    count: constituents.length,
    constituents,
  };
  writeAtomic(OUT_PATH, universe);

  console.log('\n  Wrote ' + constituents.length + ' constituents -> ' + OUT_PATH);
  if (missingExchange) console.log('  (' + missingExchange + ' had no exchange match in the SEC file - left null, not excluded)');
  console.log('\n  Next:  node fetchData.js\n');
}

main().catch((err) => {
  console.error('\n  Fatal error building universe: ' + err.message + '\n');
  process.exit(1);
});
