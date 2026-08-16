const fs = require('fs');

const file = 'providers/sec.js';
let s = fs.readFileSync(file, 'utf8');

if (s.includes('function annualSeries(tag)')) {
  console.log('Growth helpers already exist. No changes made.');
  process.exit(0);
}

const helperMarker = `function firstAvailable(usGaap, tagNames, fn) {`;

const helpers = `
function annualSeries(tag) {
  const arr = unitsArray(tag);
  if (!arr) return [];

  const annual = arr
    .filter((e) =>
      e &&
      e.fp === 'FY' &&
      e.form &&
      e.form.startsWith('10-K') &&
      e.start &&
      e.end &&
      e.val !== null &&
      e.val !== undefined
    )
    .sort((a, b) => (a.end < b.end ? 1 : -1));

  const unique = [];
  const seen = new Set();

  for (const row of annual) {
    if (seen.has(row.end)) continue;
    seen.add(row.end);
    unique.push({
      end: row.end,
      value: num(row.val),
    });
  }

  return unique;
}

function firstAnnualSeries(usGaap, tagNames) {
  for (const tagName of tagNames) {
    const series = annualSeries(usGaap[tagName]);
    if (series.length) return series;
  }
  return [];
}

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
`;

if (!s.includes(helperMarker)) {
  throw new Error('Could not find firstAvailable() insertion point.');
}

s = s.replace(helperMarker, helpers + '\n' + helperMarker);

fs.writeFileSync(file, s);

console.log('SUCCESS: helper functions added to providers/sec.js');
