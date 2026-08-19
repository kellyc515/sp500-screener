/**
 * STOCK SCREENER — scoring engine + HTML report
 * Uses companies.json (from fetchData.js) if present, else built-in sample data.
 * Run:  node screener.js   ->  writes screener-report.html
 */

const fs = require('fs');
const path = require('path');

/* ---- CONFIG: the two knobs you tune ---- */
// sectorRelative: true means the metric is percentile-ranked against same-sector
// peers instead of the whole universe (Phase 4) - flip this to retune later.
// Momentum/Sentiment/Risk stay market-wide: beta is already a market-relative
// statistic by construction (CAPM-style vs the S&P 500, so "sector-relative
// beta" would measure something different, not a clearer version of the same
// thing), and momentum/sentiment are both low-weight, largely idiosyncratic
// signals where sector-relative framing wasn't a clear improvement.
const METRICS = {
  pe:         { label: 'P/E',            bucket: 'valuation', lowerIsBetter: true,  sectorRelative: true  },
  pb:         { label: 'P/B',            bucket: 'valuation', lowerIsBetter: true,  sectorRelative: true  },
  roe:        { label: 'ROE %',          bucket: 'quality',   lowerIsBetter: false, sectorRelative: true  },
  debtEquity: { label: 'Debt/Equity',    bucket: 'quality',   lowerIsBetter: true,  sectorRelative: true  },
  sentiment:  { label: 'News Sentiment', bucket: 'sentiment', lowerIsBetter: false, sectorRelative: false },
  analyst:    { label: 'Analyst Score',  bucket: 'sentiment', lowerIsBetter: false, sectorRelative: false },
  revenueGrowth:   { label: 'Revenue Growth %',   bucket: 'growth',  lowerIsBetter: false, sectorRelative: true  },
  epsGrowth:       { label: 'EPS Growth %',       bucket: 'growth',  lowerIsBetter: false, sectorRelative: true  },
  fcfGrowth:       { label: 'FCF Growth %',       bucket: 'growth',  lowerIsBetter: false, sectorRelative: true  },
  operatingMargin: { label: 'Operating Margin %', bucket: 'quality', lowerIsBetter: false, sectorRelative: true  },
  marginTrend:     { label: 'Margin Trend pp',    bucket: 'quality', lowerIsBetter: false, sectorRelative: true  },
  beta:       { label: 'Beta',           bucket: 'risk',      lowerIsBetter: true,  sectorRelative: false },
  ret3m:      { label: '3M Return %',    bucket: 'momentum',  lowerIsBetter: false, sectorRelative: false },
  ret6m:      { label: '6M Return %',    bucket: 'momentum',  lowerIsBetter: false, sectorRelative: false },
};

// Below this many same-broad-sector peers, a percentile rank is too noisy to
// trust. With broad (GICS-style) sectors (see below) this rarely bites - each
// of the ~11 buckets holds dozens of companies in a 503-name universe - but it
// still guards the 'Other' catch-all and any thin edge case. Falls back to
// market-wide comparison for sector-relative metrics - never a crash, never a
// fabricated peer group.
const SECTOR_MIN_SIZE = 5;

// Must sum to 1.0. "growth" is a deliberate placeholder with no fields mapped
// to it below (revenueGrowth/epsGrowth etc. arrive in a later phase) - that's
// not dead weight, though: scoreUniverse() already scores a bucket as null
// when a company has zero metrics in it, and already skips null buckets when
// weighting the composite, renormalizing over whatever weight was actually
// used. Since growth has no mapped fields, it's null for every company, so
// its 0.10 is automatically redistributed across the other five buckets for
// everyone - the same "missing bucket" handling already used per-company for
// buckets like valuation when a stock's pe/pb happen to both be null.
const BUCKET_WEIGHTS = {
  valuation: 0.35,
  quality: 0.30,
  growth: 0.10,
  sentiment: 0.10,
  risk: 0.10,
  momentum: 0.05, // deliberately small, and never a gate - negative momentum never excludes a stock
};
const BUCKET_LABELS = {
  valuation: 'Valuation',
  quality: 'Quality',
  growth: 'Growth',
  sentiment: 'Sentiment/Research',
  risk: 'Risk',
  momentum: 'Momentum',
};

/* ---- Phase 4.1: SIC -> broad (GICS-style) sector mapping ----
 * SEC's `sector` field (companies.json) is already resolved to the sicDescription
 * text, not the raw numeric SIC code - the code itself lives only in the SEC
 * fetch layer and isn't threaded through here, since adding it would mean a
 * 13th companies.json field, breaking the contract. But sicDescription isn't
 * free text either: it's SEC's fixed ~1,000-entry official SIC title list, so
 * an exact-match table against those known titles is just as reliable as
 * mapping by numeric code range - that's the primary mechanism below (built
 * from the actual 184 distinct titles present in this universe, verified
 * against real company counts to roughly track known S&P 500 sector weights).
 * Falls back to keyword matching for any title outside this table (e.g. a
 * future S&P 500 addition with a title not yet seen), then to 'Other' if
 * nothing matches - which behaves exactly like the old 'Unknown' bucket in
 * the sector-relative fallback: market-wide comparison, never a crash.
 *
 * companies.json's `sector` field is NEVER overwritten - the granular SIC
 * description stays intact for the report's sector-ranking panel. Only the
 * scoring layer's peer-grouping uses the broad sector, via broadSectorFor().
 */
const SIC_TO_BROAD_SECTOR = {
  'Real Estate Investment Trusts': 'Real Estate',
  'Services-Prepackaged Software': 'Information Technology',
  'Services-Business Services, NEC': 'Industrials',
  'Semiconductors & Related Devices': 'Information Technology',
  'Electric Services': 'Utilities',
  'Electric & Other Services Combined': 'Utilities',
  'Fire, Marine & Casualty Insurance': 'Financials',
  'Pharmaceutical Preparations': 'Health Care',
  'National Commercial Banks': 'Financials',
  'Surgical & Medical Instruments & Apparatus': 'Health Care',
  'Investment Advice': 'Financials',
  'Crude Petroleum & Natural Gas': 'Energy',
  'Security Brokers, Dealers & Flotation Companies': 'Financials',
  'Services-Computer Programming, Data Processing, Etc.': 'Information Technology',
  'Insurance Agents, Brokers & Service': 'Financials',
  'State Commercial Banks': 'Financials',
  'Petroleum Refining': 'Energy',
  'Orthopedic, Prosthetic & Surgical Appliances & Supplies': 'Health Care',
  'Industrial Instruments For Measurement, Display, and Control': 'Industrials',
  'Biological Products, (No Diagnostic Substances)': 'Health Care',
  'Beverages': 'Consumer Staples',
  'Hospital & Medical Service Plans': 'Health Care',
  'Retail-Variety Stores': 'Consumer Discretionary',
  'Hotels & Motels': 'Consumer Discretionary',
  'Laboratory Analytical Instruments': 'Health Care',
  'Security & Commodity Brokers, Dealers, Exchanges & Services': 'Financials',
  'Retail-Eating  Places': 'Consumer Discretionary',
  'Electronic & Other Electrical Equipment (No Computer Equip)': 'Industrials',
  'Motor Vehicles & Passenger Car Bodies': 'Consumer Discretionary',
  'Search, Detection, Navigation, Guidance, Aeronautical Sys': 'Industrials',
  'Computer Storage Devices': 'Information Technology',
  'Plastic Materials, Synth Resins & Nonvulcan Elastomers': 'Materials',
  'Finance Services': 'Financials',
  'Electronic Computers': 'Information Technology',
  'Computer Communications Equipment': 'Information Technology',
  'Services-Computer Processing & Data Preparation': 'Information Technology',
  'Retail-Lumber & Other Building Materials Dealers': 'Consumer Discretionary',
  "Wholesale-Drugs, Proprietaries & Druggists' Sundries": 'Health Care',
  'Water Transportation': 'Industrials',
  'Air-Cond & Warm Air Heatg Equip & Comm & Indl Refrig Equip': 'Industrials',
  'Retail-Auto Dealers & Gasoline Stations': 'Consumer Discretionary',
  'Services-Commercial Physical & Biological Research': 'Health Care',
  'Cable & Other Pay Television Services': 'Communication Services',
  'Soap, Detergents, Cleang Preparations, Perfumes, Cosmetics': 'Consumer Staples',
  'Perfumes, Cosmetics & Other Toilet Preparations': 'Consumer Staples',
  'Electrical Work': 'Industrials',
  'Railroads, Line-Haul Operating': 'Industrials',
  'Air Transportation, Scheduled': 'Industrials',
  'Operative Builders': 'Consumer Discretionary',
  'Services-Consumer Credit Reporting, Collection Agencies': 'Financials',
  'Retail-Building Materials, Hardware, Garden Supply': 'Consumer Discretionary',
  'Television Broadcasting Stations': 'Communication Services',
  'Life Insurance': 'Financials',
  'Services-Computer Integrated Systems Design': 'Information Technology',
  'Computer & office Equipment': 'Information Technology',
  'Aircraft Engines & Engine Parts': 'Industrials',
  'General Industrial Machinery & Equipment': 'Industrials',
  'Natural Gas Transmission': 'Energy',
  'Measuring & Controlling Devices, NEC': 'Industrials',
  'Accident & Health Insurance': 'Financials',
  'Industrial Inorganic Chemicals': 'Materials',
  'Services-To Dwellings & Other Buildings': 'Industrials',
  'Cigarettes': 'Consumer Staples',
  'Retail-Catalog & Mail-Order Houses': 'Consumer Discretionary',
  'Fats & Oils': 'Consumer Staples',
  'Telephone Communications (No Radiotelephone)': 'Communication Services',
  'Retail-Auto & Home Supply Stores': 'Consumer Discretionary',
  'Converted Paper & Paperboard Prods (No Contaners/Boxes)': 'Materials',
  'Transportation Services': 'Industrials',
  'Arrangement of  Transportation of  Freight & Cargo': 'Industrials',
  'Agricultural Chemicals': 'Materials',
  "Men's & Boys' Furnishgs, Work Clothg, & Allied Garments": 'Consumer Discretionary',
  'Services-Computer Programming Services': 'Information Technology',
  'Optical Instruments & Lenses': 'Health Care',
  'Rubber & Plastics Footwear': 'Consumer Discretionary',
  'Wholesale-Groceries & Related Products': 'Consumer Staples',
  'Air Courier Services': 'Industrials',
  'Printed Circuit Boards': 'Information Technology',
  'Computer Peripheral Equipment, NEC': 'Information Technology',
  'Ship & Boat Building & Repairing': 'Industrials',
  'Oil & Gas Field Services, NEC': 'Energy',
  'Services-General Medical & Surgical Hospitals, NEC': 'Health Care',
  'Pumps & Pumping Equipment': 'Industrials',
  'Industrial Organic Chemicals': 'Materials',
  'Trucking (No Local)': 'Industrials',
  'Services-Medical Laboratories': 'Health Care',
  'Services-Amusement & Recreation Services': 'Communication Services',
  'Mining & Quarrying of  Nonmetallic Minerals (No Fuels)': 'Materials',
  'Radio & Tv Broadcasting & Communications Equipment': 'Information Technology',
  'Newspapers: Publishing or  Publishing & Printing': 'Communication Services',
  'Steel Works, Blast Furnaces & Rolling Mills (Coke Ovens)': 'Materials',
  'Paperboard Containers & Boxes': 'Materials',
  'Refuse Systems': 'Industrials',
  'Retail-Family Clothing Stores': 'Consumer Discretionary',
  'Cutlery, Handtools & General Hardware': 'Industrials',
  'Instruments For Meas & Testing of  Electricity & Elec Signals': 'Industrials',
  'Household Appliances': 'Consumer Discretionary',
  'Cogeneration Services & Small Power Producers': 'Utilities',
  'Services-Detective, Guard & Armored Car Services': 'Industrials',
  'Miscellaneous Manufacturing Industries': 'Industrials',
  'Unknown': 'Other',
  'Water Supply': 'Utilities',
  'Electronic Connectors': 'Information Technology',
  'Motor Vehicle Parts & Accessories': 'Consumer Discretionary',
  'Insurance Carriers, NEC': 'Financials',
  'Natural Gas Distribution': 'Utilities',
  'Ordnance & Accessories, (No Vehicles/Guided Missiles)': 'Industrials',
  'Oil & Gas Field Machinery & Equipment': 'Energy',
  'Metal Cans': 'Materials',
  'Retail-Radio, Tv & Consumer Electronics Stores': 'Consumer Discretionary',
  'Aircraft': 'Industrials',
  'Construction Machinery & Equip': 'Industrials',
  'Real Estate': 'Real Estate',
  'Telephone & Telegraph Apparatus': 'Information Technology',
  'Specialty Cleaning, Polishing and Sanitation Preparations': 'Consumer Staples',
  'Ophthalmic Goods': 'Health Care',
  'Drawing & Insulating of  Nonferrous Wire': 'Materials',
  'Agricultural Production-Crops': 'Consumer Staples',
  'Cement, Hydraulic': 'Materials',
  'Engines & Turbines': 'Industrials',
  'Retail-Drug Stores and Proprietary Stores': 'Consumer Staples',
  'Services-Misc Health & Allied Services, NEC': 'Health Care',
  'Farm Machinery & Equipment': 'Industrials',
  'Construction, Mining & Materials Handling Machinery & Equip': 'Industrials',
  'Misc Industrial & Commercial Machinery & Equipment': 'Industrials',
  'Communications Services, NEC': 'Communication Services',
  'Wholesale-Hardware & Plumbing & Heating Equipment & Supplies': 'Industrials',
  'Metal Mining': 'Materials',
  'Services-Management Services': 'Industrials',
  'X-Ray Apparatus & Tubes & Related Irradiation Apparatus': 'Health Care',
  'Motors & Generators': 'Industrials',
  'Grain Mill Products': 'Consumer Staples',
  'Wholesale-Motor Vehicle Supplies & New Parts': 'Consumer Discretionary',
  "Games, Toys & Children's Vehicles (No Dolls & Bicycles)": 'Consumer Discretionary',
  'Wholesale-Medical, Dental & Hospital Equipment & Supplies': 'Health Care',
  'Sugar & Confectionery Products': 'Consumer Staples',
  'Meat Packing Plants': 'Consumer Staples',
  'Rolling Drawing & Extruding of  Nonferrous Metals': 'Materials',
  'Electronic Components & Accessories': 'Information Technology',
  'In Vitro & In Vivo Diagnostic Substances': 'Health Care',
  'Paper Mills': 'Materials',
  'Real Estate Operators (No Developers) & Lessors': 'Real Estate',
  'Heavy Construction Other Than Bldg Const - Contractors': 'Industrials',
  'Canned, Frozen & Preservd Fruit, Veg & Food Specialties': 'Consumer Staples',
  'Retail-Grocery Stores': 'Consumer Staples',
  'Special Industry Machinery, NEC': 'Industrials',
  'General Bldg Contractors - Residential Bldgs': 'Consumer Discretionary',
  'Guided Missiles & Space Vehicles & Parts': 'Industrials',
  'Apparel & Other Finishd Prods of  Fabrics & Similar Matl': 'Consumer Discretionary',
  'Communications Equipment, NEC': 'Information Technology',
  'Heating Equip, Except Elec & Warm Air; & Plumbing Fixtures': 'Industrials',
  'Miscellaneous Food Preparations & Kindred Products': 'Consumer Staples',
  'Electromedical & Electrotherapeutic Apparatus': 'Health Care',
  'Malt Beverages': 'Consumer Staples',
  'Food and Kindred Products': 'Consumer Staples',
  'Bottled & Canned Soft Drinks & Carbonated Waters': 'Consumer Staples',
  'Services-Video Tape Rental': 'Communication Services',
  'Gold and Silver Ores': 'Materials',
  'General Industrial Machinery & Equipment, NEC': 'Industrials',
  'Services-Advertising Agencies': 'Communication Services',
  'Natural Gas Transmisison & Distribution': 'Utilities',
  'Miscellaneous Fabricated Metal Products': 'Materials',
  'Services-Engineering, Accounting, Research, Management': 'Industrials',
  'Special Industry Machinery (No Metalworking Machinery)': 'Industrials',
  'Paints, Varnishes, Lacquers, Enamels & Allied Prods': 'Materials',
  'Gas & Other Services Combined': 'Utilities',
  'Canned, Fruits, Veg, Preserves, Jams & Jellies': 'Consumer Staples',
  'Retail-Eating & Drinking Places': 'Consumer Discretionary',
  'Radiotelephone Communications': 'Communication Services',
  'Leather & Leather Products': 'Consumer Discretionary',
  'Wholesale-Electronic Parts & Equipment, NEC': 'Information Technology',
  'Oil Royalty Traders': 'Energy',
  'Aircraft & Parts': 'Industrials',
  'Auto Controls For Regulating Residential & Comml Environments': 'Industrials',
  'Aircraft Parts & Auxiliary Equipment, NEC': 'Industrials',
  'Poultry Slaughtering and Processing': 'Consumer Staples',
  'Retail-Retail Stores, NEC': 'Consumer Discretionary',
  'Trucking & Courier Services (No Air)': 'Industrials',
  'Services-Equipment Rental & Leasing, NEC': 'Industrials',
  'Electronic Components, NEC': 'Information Technology',
  'Wholesale-Durable Goods': 'Industrials',
  'Railroad Equipment': 'Industrials',
  'Services-Miscellaneous Amusement & Recreation': 'Communication Services',
  'Retail-Home Furniture, Furnishings & Equipment Stores': 'Consumer Discretionary',
};

// 'Services-Business Services, NEC' (SIC 7389) is a catch-all that genuinely
// lumps payment networks, IT consulting, e-commerce, and ride-hailing under
// one code - too coarse to trust for these specific, well-known companies.
// Ticker overrides take priority over the SIC map. Known minor imprecisions
// left as-is (not worth a per-ticker override): a few instrumentation/research
// companies (e.g. Gartner, Garmin, Keysight) sit in a broad sector that's
// defensible but not unanimous - low-stakes, single-company cases.
const TICKER_SECTOR_OVERRIDES = {
  ACN: 'Information Technology',
  AKAM: 'Information Technology',
  BR: 'Financials',
  CPAY: 'Financials',
  CSGP: 'Real Estate',
  DASH: 'Consumer Discretionary',
  EBAY: 'Consumer Discretionary',
  FICO: 'Information Technology',
  FIS: 'Financials',
  FISV: 'Financials',
  GPN: 'Financials',
  MA: 'Financials',
  MSCI: 'Financials',
  PYPL: 'Financials',
  UBER: 'Industrials',
  V: 'Financials',
};

// Fallback for any sicDescription not in the exact-match table above (e.g. a
// future universe rebuild adding a company with a title not yet seen).
const SIC_KEYWORD_FALLBACK = [
  [/bank|deposit|credit union|savings institution/i, 'Financials'],
  [/insurance|broker|investment advice|holding.*invest|security.*exchange/i, 'Financials'],
  [/pharmaceutical|biotech|biological|medical|surgical|hospital|health|drug|diagnostic|dental|x-ray|electromedical|ophthalmic/i, 'Health Care'],
  [/software|computer|semiconductor|electronic|data processing/i, 'Information Technology'],
  [/petroleum|oil and gas|oil & gas|crude/i, 'Energy'],
  [/electric service|gas.*distribution|water supply|utilit|power produc/i, 'Utilities'],
  [/broadcast|publishing|telephone|radiotelephone|communications|cable|television|advertising|motion picture|amusement|recreation/i, 'Communication Services'],
  [/real estate/i, 'Real Estate'],
  [/chemical|mining|metal|steel|paper|cement|plastic|rubber|lumber|ore/i, 'Materials'],
  [/retail|wholesale|hotel|restaurant|apparel|footwear|leather|furniture|auto dealer|leisure/i, 'Consumer Discretionary'],
  [/food|beverage|grocery|tobacco|cigarette|agricultural/i, 'Consumer Staples'],
  [/construction|machinery|equipment|transportation|trucking|railroad|aircraft|shipbuild|engineering|industrial/i, 'Industrials'],
];

function broadSectorFor(sicDescription) {
  if (!sicDescription) return 'Other';
  if (SIC_TO_BROAD_SECTOR[sicDescription]) return SIC_TO_BROAD_SECTOR[sicDescription];
  for (const [pattern, sector] of SIC_KEYWORD_FALLBACK) {
    if (pattern.test(sicDescription)) return sector;
  }
  return 'Other';
}

/* ---- Phase 5: Value Opportunity + Value Trap Risk ----
 * Two independent 0-100 scores, never merged into the main composite - a
 * separate lens layered on top of it. Both reuse the per-company metricScores
 * already computed in scoreUniverse() (which are sector-relative for
 * pe/pb/roe/debtEquity per Phase 4.1, market-wide for sentiment/analyst/
 * momentum) - no duplicate percentile computation.
 *
 * Value Trap Risk is deliberately a narrow proxy: it can see valuation,
 * leverage, momentum, sentiment, and analyst consensus - it CANNOT see
 * revenue/EPS deterioration, margin compression, guidance cuts, analyst
 * *estimate revisions* (vs. today's static consensus), insider selling, or
 * customer concentration/loss. Those all need financial-statement history or
 * filing-text analysis this build doesn't have yet. A high trap score here
 * is a prompt to research further, not a verdict - said again in the report.
 */
const VALUE_OPPORTUNITY_WEIGHTS = {
  valuation: 0.45,   // avg(pe, pb) sector-relative percentile - heaviest, per spec
  quality: 0.25,     // roe sector-relative percentile
  balanceSheet: 0.20, // debtEquity sector-relative percentile (already lower-is-better)
  analystSupport: 0.10, // analyst market-wide percentile - mild confirmation only
};

const VALUE_TRAP_WEIGHTS = {
  momentumWeakness: 0.35, // inverted avg(ret3m, ret6m) - least-lagged signal available
  leverage: 0.30,          // inverted debtEquity - structural, persistent risk
  sentiment: 0.20,         // inverted news sentiment - timely but the noisiest input
  analystWeakness: 0.15,   // inverted analyst consensus - lags reality, corroborating only
};

// A round, tunable cutoff for flagging "high on both" in the console summary -
// roughly top-30%-ish territory on a 0-100 percentile-derived score.
const HIGH_BOTH_THRESHOLD = 70;

// Missing-data confidence rules.
// Value Opportunity needs at least 75% of its intended component weight.
// Main Score needs at least 80% of its intended bucket weight to be rank-eligible.
const VALUE_OPPORTUNITY_MIN_COVERAGE = 0.75;
const MAIN_SCORE_MIN_COVERAGE = 0.80;
// Trap Risk can still be displayed with partial data, but it must have
// at least 80% of intended component weight before it may drive a
// trap-dependent classification.
const VALUE_TRAP_MIN_COVERAGE = 0.80;
// Growth bucket only has 3 equally-weighted inputs (revenueGrowth,
// epsGrowth, fcfGrowth), and epsGrowth/fcfGrowth are now frequently null
// for a real reason (see positiveBaseGrowthPct's minimum-base floors in
// providers/sec.js) rather than a missing-data accident - a lower bar than
// the 0.75-0.80 used above is appropriate: 2 of 3 metrics is enough to
// trust the bucket as more than a lightly-shrunk read, 1 of 3 is not.
const GROWTH_BUCKET_MIN_COVERAGE = 2 / 3;

function invertScore(v) {
  return v === null || v === undefined ? null : 100 - v;
}

function avgOrNull(values) {
  const clean = values.filter((v) => v !== null && v !== undefined);
  return clean.length ? clean.reduce((a, x) => a + x, 0) / clean.length : null;
}

// Generic null-skip, renormalize-remaining-weights combiner.
// Still used by Value Trap Risk for now.
function weightedComposite(componentWeightPairs) {
  let wSum = 0, wUsed = 0;
  for (const [value, weight] of componentWeightPairs) {
    if (value !== null && value !== undefined) {
      wSum += value * weight;
      wUsed += weight;
    }
  }
  return wUsed ? wSum / wUsed : null;
}

// Pull an incomplete score toward neutral 50 in proportion to how much of
// the originally intended weight is actually present.
// 100% coverage = unchanged.
// 80% coverage = 20% of the distance from 50 is removed.
function shrinkToNeutral(score, coverage) {
  if (score === null || score === undefined) return null;
  return 50 + (score - 50) * coverage;
}

// Same weighted calculation as weightedComposite(), but also returns the
// fraction of intended weight actually represented by real data.
function weightedCompositeWithCoverage(componentWeightPairs) {
  let wSum = 0;
  let wUsed = 0;

  for (const [value, weight] of componentWeightPairs) {
    if (value !== null && value !== undefined) {
      wSum += value * weight;
      wUsed += weight;
    }
  }

  const raw = wUsed ? wSum / wUsed : null;

  return {
    raw,
    coverage: wUsed,
    adjusted: raw === null ? null : shrinkToNeutral(raw, wUsed),
  };
}

function scoreValueOpportunity(metricScores) {
  const valuation = avgOrNull([metricScores.pe, metricScores.pb]);

  const result = weightedCompositeWithCoverage([
    [valuation, VALUE_OPPORTUNITY_WEIGHTS.valuation],
    [metricScores.roe, VALUE_OPPORTUNITY_WEIGHTS.quality],
    [metricScores.debtEquity, VALUE_OPPORTUNITY_WEIGHTS.balanceSheet],
    [metricScores.analyst, VALUE_OPPORTUNITY_WEIGHTS.analystSupport],
  ]);

  return {
    raw: result.raw,
    coverage: result.coverage,
    eligible: result.coverage >= VALUE_OPPORTUNITY_MIN_COVERAGE,
    adjusted:
      result.coverage >= VALUE_OPPORTUNITY_MIN_COVERAGE
        ? result.adjusted
        : null,
  };
}

function scoreValueTrapRisk(metricScores) {
  const momentumWeakness = avgOrNull([invertScore(metricScores.ret3m), invertScore(metricScores.ret6m)]);
  const result = weightedCompositeWithCoverage([
    [momentumWeakness, VALUE_TRAP_WEIGHTS.momentumWeakness],
    [invertScore(metricScores.debtEquity), VALUE_TRAP_WEIGHTS.leverage],
    [invertScore(metricScores.sentiment), VALUE_TRAP_WEIGHTS.sentiment],
    [invertScore(metricScores.analyst), VALUE_TRAP_WEIGHTS.analystWeakness],
  ]);

  return {
    raw: result.raw,
    coverage: result.coverage,
    eligible: result.coverage >= VALUE_TRAP_MIN_COVERAGE,
    adjusted: result.adjusted,
  };
}

/* ---- Phase 7: Classification ----
 * One plain-English label per stock, layered on top of everything above -
 * pure read of existing scores, changes no scoring. Checked in priority
 * order below, first match wins; a stock with too little data (or that
 * genuinely doesn't fit any clean pattern) gets the MIXED catch-all rather
 * than a forced/wrong label.
 *
 * GROWTH AT REASONABLE PRICE and TURNAROUND CANDIDATE were originally
 * deferred (no growth data, no trend history) - both now exist (growth
 * metrics from providers/sec.js, Phase 8 snapshot history) and are enabled
 * below. Both sit AFTER every value/quality label in priority order
 * specifically so they can never steal a stock that's more accurately
 * UNDERVALUED QUALITY / UNDERVALUED HIGH RISK / EXPENSIVE QUALITY / QUALITY
 * AT FAIR VALUE - those checks run first and return immediately when they
 * match, so GARP/TURNAROUND only ever see what's left over.
 *
 * POSSIBLE VALUE TRAP vs UNDERVALUED / HIGH RISK are both real spec labels
 * but this build can only tell them apart by trap-risk severity (>=70 vs
 * 40-69), not by the deteriorating-fundamentals signal the spec originally
 * implies - said here plainly rather than pretending otherwise.
 */
const CLASSIFICATION = {
  DISTRESSED: 'DISTRESSED',
  POSSIBLE_VALUE_TRAP: 'POSSIBLE VALUE TRAP',
  UNDERVALUED_HIGH_RISK: 'UNDERVALUED / HIGH RISK',
  UNDERVALUED_QUALITY: 'UNDERVALUED QUALITY',
  EXPENSIVE_QUALITY: 'EXPENSIVE QUALITY',
  QUALITY_AT_FAIR_VALUE: 'QUALITY AT FAIR VALUE',
  TURNAROUND_CANDIDATE: 'TURNAROUND CANDIDATE',
  GROWTH_AT_REASONABLE_PRICE: 'GROWTH AT REASONABLE PRICE',
  MOMENTUM_LEADER: 'MOMENTUM LEADER',
  MIXED: 'MIXED',
};

const CLASSIFY_THRESHOLDS = {
  HIGH_OPPORTUNITY: 70,
  MODERATE_OPPORTUNITY: 55,
  LOW_OPPORTUNITY: 40,
  HIGH_TRAP: 70,
  VERY_HIGH_TRAP: 75,
  MODERATE_TRAP: 40,
  QUALITY_STRONG: 65,
  QUALITY_DECENT: 55,
  QUALITY_FAIR_MIN: 60,
  VALUATION_EXPENSIVE_MAX: 35,
  VALUATION_FAIR_MIN: 35,
  VALUATION_FAIR_MAX: 65,
  MOMENTUM_STRONG: 70,
  COMPOSITE_DECENT: 55,
  // GARP: sector-relative growth percentile counted as "genuine" - top ~30%.
  GARP_GROWTH_STRONG: 70,
  // TURNAROUND: was the baseline composite low enough to call "struggling"?
  TURNAROUND_WEAK_COMPOSITE_MAX: 45,
  // TURNAROUND: minimum composite-point gain vs. baseline to call it a real
  // trajectory rather than noise.
  TURNAROUND_MIN_SCORE_IMPROVEMENT: 8,
  // TURNAROUND: minimum positive margin-trend (percentage points) to count
  // as a corroborating fundamentals-recovery signal.
  TURNAROUND_MARGIN_MIN: 2,
};

// Classifications severe enough to count as "was struggling" for TURNAROUND
// CANDIDATE's baseline check - deliberately excludes MIXED (a low-composite
// MIXED already trips the numeric TURNAROUND_WEAK_COMPOSITE_MAX check
// instead, so a MIXED stock isn't double-counted through two conditions).
const TURNAROUND_WEAK_CLASSIFICATIONS = new Set([
  CLASSIFICATION.DISTRESSED,
  CLASSIFICATION.POSSIBLE_VALUE_TRAP,
  CLASSIFICATION.UNDERVALUED_HIGH_RISK,
]);

function classify(bucketScores, valueOpportunity, valueTrapRisk, composite, valueTrapRiskEligible, metricScores, marginTrend, turnaroundBaselineEntry) {
  const T = CLASSIFY_THRESHOLDS;
  const quality = bucketScores.quality;
  const valuation = bucketScores.valuation;
  const momentum = bucketScores.momentum;
  const has = (...vals) => vals.every((v) => v !== null && v !== undefined);

  if (valueTrapRiskEligible && has(valueOpportunity, valueTrapRisk) && valueOpportunity < T.LOW_OPPORTUNITY && valueTrapRisk >= T.VERY_HIGH_TRAP) {
    return CLASSIFICATION.DISTRESSED;
  }
  if (valueTrapRiskEligible && has(valueOpportunity, valueTrapRisk) && valueOpportunity >= T.MODERATE_OPPORTUNITY && valueTrapRisk >= T.HIGH_TRAP) {
    return CLASSIFICATION.POSSIBLE_VALUE_TRAP;
  }
  if (valueTrapRiskEligible && has(valueOpportunity, valueTrapRisk) && valueOpportunity >= T.HIGH_OPPORTUNITY && valueTrapRisk >= T.MODERATE_TRAP && valueTrapRisk < T.HIGH_TRAP) {
    return CLASSIFICATION.UNDERVALUED_HIGH_RISK;
  }
  if (valueTrapRiskEligible && has(valueOpportunity, valueTrapRisk, quality) && valueOpportunity >= T.HIGH_OPPORTUNITY && valueTrapRisk < T.MODERATE_TRAP && quality >= T.QUALITY_DECENT) {
    return CLASSIFICATION.UNDERVALUED_QUALITY;
  }
  if (has(quality, valuation) && quality >= T.QUALITY_STRONG && valuation <= T.VALUATION_EXPENSIVE_MAX) {
    return CLASSIFICATION.EXPENSIVE_QUALITY;
  }
  if (has(quality, valuation) && quality >= T.QUALITY_FAIR_MIN && valuation > T.VALUATION_FAIR_MIN && valuation < T.VALUATION_FAIR_MAX) {
    return CLASSIFICATION.QUALITY_AT_FAIR_VALUE;
  }

  // TURNAROUND CANDIDATE - needs an actual prior snapshot to compare against
  // (turnaroundBaselineEntry is null whenever there isn't enough history yet
  // - see loadTurnaroundBaseline()/TURNAROUND_MIN_PRIOR_SNAPSHOTS). Requires
  // real evidence of BOTH prior weakness and subsequent improvement, not
  // just "score went up a little."
  if (turnaroundBaselineEntry && has(composite) && has(turnaroundBaselineEntry.composite)) {
    const baselineComposite = turnaroundBaselineEntry.composite;
    const wasStruggling = baselineComposite < T.TURNAROUND_WEAK_COMPOSITE_MAX
      || TURNAROUND_WEAK_CLASSIFICATIONS.has(turnaroundBaselineEntry.classification);
    if (wasStruggling) {
      const compositeDelta = composite - baselineComposite;
      const trajectorySignal = compositeDelta >= T.TURNAROUND_MIN_SCORE_IMPROVEMENT;
      const fundamentalSignal = compositeDelta > 0 && marginTrend !== null && marginTrend !== undefined && marginTrend > T.TURNAROUND_MARGIN_MIN;
      if (trajectorySignal || fundamentalSignal) {
        return CLASSIFICATION.TURNAROUND_CANDIDATE;
      }
    }
  }

  // GROWTH AT REASONABLE PRICE - genuine sector-relative growth (revenue
  // and/or EPS) at a valuation that's neither cheap (already claimed above
  // by UNDERVALUED QUALITY/HIGH RISK) nor expensive (EXPENSIVE QUALITY's
  // zone) - reuses the exact same "fair" valuation band QUALITY AT FAIR
  // VALUE already validated, rather than inventing a new one. A stock
  // missing both growth metrics can never satisfy either OR-branch below,
  // so it falls through to MOMENTUM LEADER/MIXED like today.
  if (has(valuation) && valuation > T.VALUATION_FAIR_MIN && valuation <= T.VALUATION_FAIR_MAX) {
    const strongRevenueGrowth = metricScores && metricScores.revenueGrowth !== null && metricScores.revenueGrowth !== undefined
      && metricScores.revenueGrowth >= T.GARP_GROWTH_STRONG;
    const strongEpsGrowth = metricScores && metricScores.epsGrowth !== null && metricScores.epsGrowth !== undefined
      && metricScores.epsGrowth >= T.GARP_GROWTH_STRONG;
    if (strongRevenueGrowth || strongEpsGrowth) {
      return CLASSIFICATION.GROWTH_AT_REASONABLE_PRICE;
    }
  }

  if (has(momentum, composite) && momentum >= T.MOMENTUM_STRONG && composite >= T.COMPOSITE_DECENT) {
    return CLASSIFICATION.MOMENTUM_LEADER;
  }
  return CLASSIFICATION.MIXED;
}

/* ---- Phase 9: per-stock detail panel ----
 * Price and news headlines are read from the fetch-layer cache (cache/quote.json,
 * cache/news.json) at report-generation time - never live-fetched from the
 * browser, since that would mean embedding a Finnhub API key in a static HTML
 * file. Clearly labeled "cached, as of <timestamp>" in the panel, never implied
 * live. Exchange comes from universe.json (Phase 2) to build the TradingView
 * symbol - confirmed live (see conversation) that TradingView's free, no-key,
 * no-account embed widget (embed-widget-symbol-overview.js) needs an
 * exchange-qualified symbol like NASDAQ:AAPL or NYSE:JPM, and that it wants
 * DOT notation for share classes (NYSE:BRK.B), the opposite of SEC's dash
 * convention used elsewhere in this project - so tickers pass through
 * unchanged here, no conversion.
 */
const EXCHANGE_TV_PREFIX = {
  Nasdaq: 'NASDAQ',
  NYSE: 'NYSE',
  'NYSE American': 'AMEX',
  'NYSE Arca': 'AMEX',
  CBOE: 'CBOE',
  BATS: 'BATS',
};
// Fallback for the rare ticker with no exchange on record (1 of 503 currently) -
// a guess, not a claim; the widget will simply not resolve if it's wrong for
// that one name, same as any other blank-chart edge case.
const TV_EXCHANGE_FALLBACK = 'NASDAQ';

function tvSymbolFor(ticker, exchange) {
  const prefix = EXCHANGE_TV_PREFIX[exchange] || TV_EXCHANGE_FALLBACK;
  return prefix + ':' + ticker;
}

// The metrics selectable in the stat-comparison chart - market-wide (not
// sector-relative) per spec, straight from companies.json/scored values.
// Display-only: this object has no connection to METRICS/BUCKET_WEIGHTS
// above (the actual scoring config) - adding a field here only makes it
// selectable in the "Where It Stands" chart, it never touches the
// composite score, Value Opportunity/Trap Risk, or classification.
const STAT_METRICS = {
  pe: { label: 'P/E', lowerIsBetter: true },
  pb: { label: 'P/B', lowerIsBetter: true },
  peg: {
    label: 'PEG (P/E to Growth)',
    lowerIsBetter: true,
    description: 'Uses our own FY-over-FY SEC EPS growth, not analyst estimates. The P/E numerator is TTM-basis while growth is annual FY-over-FY, so this is not a perfectly time-aligned TTM PEG. Nulled when growth is below 2%, since PEG is not meaningful off a near-zero growth rate.',
  },
  roe: { label: 'ROE %', lowerIsBetter: false },
  debtEquity: { label: 'Debt/Equity', lowerIsBetter: true },
  sentiment: { label: 'News Sentiment', lowerIsBetter: false },
  analyst: { label: 'Analyst Score', lowerIsBetter: false },
  beta: { label: 'Beta', lowerIsBetter: true },
  ret3m: { label: '3M Return %', lowerIsBetter: false },
  ret6m: { label: '6M Return %', lowerIsBetter: false },
  ret1y: { label: '1Y Return %', lowerIsBetter: false },
  // Distance from the high is contextual, not inherently good or bad. Keep
  // its percentile/rank useful while rendering its marker in neutral gray.
  pctBelow52wHigh: { label: '% Below 52wk High', lowerIsBetter: false, neutral: true },
  evEbitda: { label: 'EV/EBITDA (TTM)', lowerIsBetter: true },
  fcfYield: { label: 'Annual FCF Yield %', lowerIsBetter: false },
  roic: { label: 'Annual GAAP ROIC %', lowerIsBetter: false },
  fcfConversion: { label: 'Annual FCF Conversion vs Net Income %', lowerIsBetter: false },
  netDebtEbitda: {
    label: 'Net Debt / EBITDA (TTM)',
    lowerIsBetter: true,
    description: 'Uses GAAP EBITDA; for REITs this is not the industry-adjusted EBITDAre measure.',
  },
  basicShareChange: {
    label: 'Annual Basic Weighted-Average Shares Change %',
    lowerIsBetter: true,
    description: 'Measures annual weighted-average basic-share exposure, not exact period-end ownership. Positive values indicate realized dilution; negative values indicate a share-count reduction.',
  },
  valueOpportunity: { label: 'Value Opportunity', lowerIsBetter: false },
  trapRisk: { label: 'Trap Risk', lowerIsBetter: true }, // lower = safer, matches the coloring convention already used
  score: { label: 'Score', lowerIsBetter: false },
};

// Plain-English explanations for the detail panel's "All Metrics" click-to-
// expand feature. Display-only, purely educational - describes what a
// metric means and how to read it in general; never a verdict on the
// specific value shown for any stock. One entry per STAT_METRICS key.
// Double-quoted strings throughout (this gets embedded into the client
// script via safeJSONEmbed(), same as STAT_METRICS/STOCK_DETAIL) so natural
// apostrophes in the prose need no escaping.
const METRIC_EXPLANATIONS = {
  pe: {
    name: "P/E — Price to Earnings",
    what: "How much you pay for each $1 of the company's trailing annual profit. Share price divided by trailing twelve-month earnings per share.",
    read: "Lower generally means you're paying less per dollar of current profit - often called \"cheaper.\" Higher means the market is pricing in strong future growth, or the stock is simply expensive relative to what it earns today.",
    range: "Across this list the middle 80% of names run roughly 13-60, with a median near 25. Left blank when the company has zero or negative earnings, since a P/E on a loss isn't meaningful.",
    why: "A low P/E is the classic bargain signal this screener is built around, but a very low P/E can also mean the market has priced in real trouble - exactly the value-trap risk this screener tries to flag alongside it. Never read P/E alone.",
  },
  pb: {
    name: "P/B — Price to Book",
    what: "Price compared to the company's net worth on the books - assets minus liabilities, per share.",
    read: "Below 1 means the market is valuing the company at less than its stated accounting net worth. Higher multiples mean investors expect the business to earn well above what its balance sheet alone would suggest.",
    range: "Most names here run roughly 1.5-29, with a median around 4.3 - asset-light, high-margin businesses often carry much higher P/B than asset-heavy ones like insurers or banks, so it's most meaningful compared within a similar type of business.",
    why: "P/B is most useful for financial and asset-heavy companies, where book value is a decent proxy for real worth. A low P/B paired with solid ROE can be a genuine bargain; a low P/B with weak or falling ROE is a warning that the \"cheap\" assets may be earning less than they used to.",
  },
  peg: {
    name: "PEG — P/E to Growth",
    what: "The P/E ratio adjusted for how fast the company's earnings are actually growing - P/E divided by the annual EPS growth rate. This screener computes growth itself from SEC filings year-over-year, not analyst estimates.",
    read: "Around 1 is often read as \"fairly priced for its growth.\" Meaningfully below 1 can mean you're getting real growth cheaply; well above suggests the price has run ahead of the growth backing it up.",
    range: "Where it's populated, the middle 80% of names run roughly 0.3-4.9, with a median near 1.2. PEG is left blank whenever P/E itself is blank, growth is negative, or growth is below a 2% floor - below that floor the ratio can swing to extreme, meaningless values off an almost-zero denominator, so this screener nulls it out rather than show a misleading number.",
    why: "PEG helps separate \"cheap and stagnant\" from \"reasonably priced and actually growing.\" A low P/E paired with a low PEG is a more credible bargain signal than a low P/E on its own, which can just mean earnings aren't expected to grow at all.",
  },
  roe: {
    name: "ROE — Return on Equity",
    what: "How much profit the company generates from shareholders' equity - net income divided by shareholder equity, as a percentage.",
    read: "Higher means the business converts each dollar of equity into more profit - a sign of an efficient, well-run operation. Consistently high ROE over time is one of the more reliable quality signals.",
    range: "The middle 80% of names here run roughly 2%-44%, with a median near 14%. Very high ROE is worth a second look - it can come from genuine efficiency or from heavy debt inflating the ratio, so it's worth checking Debt/Equity alongside it. Nulled when shareholder equity is zero or negative, since the ratio isn't economically meaningful there.",
    why: "This screener leans on ROE as a core quality signal. A cheap stock (low P/E) that also has strong ROE is closer to the \"quality bargain\" this tool is built to surface, rather than just a stock that's cheap because it's a weak business.",
  },
  debtEquity: {
    name: "Debt/Equity",
    what: "How much debt the company carries relative to shareholder equity - total debt divided by equity.",
    read: "Lower means more conservative financing. Higher means more leverage, which can boost returns when things go well but adds real risk when they don't.",
    range: "The middle 80% of names here run roughly 0.02-2.0, with a median near 0.5. What counts as \"high\" varies a lot by industry - utilities, REITs, and banks structurally run higher than software or biotech. Nulled when shareholder equity is zero or negative, for the same reason as ROE.",
    why: "Heavy debt is a common ingredient in value traps: a stock that looks cheap can stay cheap, or get cheaper, if it's weighed down by obligations it can't easily service. Low debt is one of the things that gives a genuine bargain some margin of safety.",
  },
  sentiment: {
    name: "News Sentiment",
    what: "A rough read of recent news coverage tone for this company, built from keyword matching against headlines from the last few weeks - not a language model, just a simple positive/negative word count.",
    read: "Positive values mean the recent headline mix skewed positive; negative values mean it skewed negative. Values sit on roughly a -1 to +1 scale.",
    range: "The middle 80% of names here run roughly 0.11-0.90, with a median around 0.64 - most coverage in this universe skews mildly-to-moderately positive by this simple measure, so a reading near zero or negative is comparatively more notable.",
    why: "This is deliberately the noisiest, least rigorous input in the whole screener - it's a light signal of what the news cycle currently thinks, not a fundamental read on the business. Useful as one small piece of context, not something to weight heavily on its own.",
  },
  analyst: {
    name: "Analyst Score",
    what: "Wall Street's buy/hold/sell consensus on the stock, converted into a single 0-100 score (a strong buy consensus scores near 100, a strong sell near 0).",
    read: "Higher means analysts covering the stock lean more bullish; lower means they lean more bearish or are split.",
    range: "The middle 80% of names here run roughly 59-79, with a median near 71 - analyst coverage of large caps tends to skew positive overall, so scores in the 40s or below are comparatively rare and worth noting.",
    why: "Analyst sentiment can confirm or contradict what the valuation and quality numbers suggest. A cheap, high-quality stock that analysts also like adds confidence; a cheap stock analysts are cool on is worth extra scrutiny before assuming it's a bargain.",
  },
  beta: {
    name: "Beta",
    what: "How much the stock's price swings relative to the overall market.",
    read: "1.0 means it moves roughly in line with the market. Above 1 means bigger swings than the market in both directions; below 1 means steadier, smaller swings.",
    range: "The middle 80% of names here run roughly 0.35-1.56, with a median near 0.93 - close to the market average, as expected for a broad large-cap universe.",
    why: "Beta isn't a bargain or trap signal by itself - it's a measure of how bumpy the ride tends to be, not whether the destination is good. A high-beta stock isn't automatically a value trap; it just moves more.",
  },
  ret3m: {
    name: "3M Return %",
    what: "How much the stock's price has changed over the last three months.",
    read: "Positive means the price is up over that window; negative means it's down. On its own this says nothing about whether the move was justified.",
    range: "The middle 80% of names here run roughly -9% to +29%, with a median near +7%.",
    why: "A recent drop can mean a stock has become a genuine bargain, or it can mean the market is correctly pricing in bad news - exactly the distinction Value Opportunity and Trap Risk are built to help with. Treat a big recent move as a prompt to dig in, not a verdict either way.",
  },
  ret6m: {
    name: "6M Return %",
    what: "How much the stock's price has changed over the last six months.",
    read: "Same idea as the 3-month return over a longer window - positive is up, negative is down.",
    range: "The middle 80% of names here run roughly -17% to +34%, with a median near +5%.",
    why: "A longer window smooths out some short-term noise compared to the 3-month figure, but the same caution applies: a big move up or down is a starting point for research, not a conclusion about value.",
  },
  ret1y: {
    name: "1Y Return %",
    what: "How much the stock's price has changed over the past year.",
    read: "Positive is up over the year, negative is down. Like the shorter-window returns, it's descriptive, not a judgment on whether the current price is attractive.",
    range: "The middle 80% of names here run roughly -24% to +67%, with a median near +11%.",
    why: "A stock that's fallen hard over a year might be a bargain the market has overlooked, or it might be a business genuinely deteriorating - pairing this with Trap Risk and the quality metrics is how you tell the two apart.",
  },
  pctBelow52wHigh: {
    name: "% Below 52wk High",
    what: "How far the current price sits below the stock's highest price over the past 52 weeks.",
    read: "This one is intentionally neutral, not colored good or bad: a small gap means the stock is trading near its recent peak; a large gap means it's well off its high. Neither is inherently better.",
    range: "The middle 80% of names here run roughly 2%-33% below their 52-week high, with a median near 11%.",
    why: "Distance from a high is context, not a signal - a stock far below its high could be a beaten-down bargain or a business in real decline. It's most useful alongside the other metrics here, not as a standalone read.",
  },
  evEbitda: {
    name: "EV/EBITDA (TTM)",
    what: "The company's total value - market value of equity plus debt, minus cash - compared to its core operating earnings (EBITDA) over the trailing twelve months.",
    read: "Lower means cheaper relative to the cash the business generates from operations. Unlike P/E, it accounts for debt, which makes it a fuller picture of what it would cost to \"buy the whole thing.\"",
    range: "Where it's populated, the middle 80% of names run roughly 9-38, with a median near 17.5. It's left blank for financial institutions (banks, insurers) where EBITDA isn't a meaningful concept, when the company's EBITDA is zero or negative, or when the reported multiple is an implausibly extreme outlier this screener filters out rather than show.",
    why: "This is a cleaner cheapness read than P/E for companies carrying meaningful debt, since a buyer would inherit that debt. A low EV/EBITDA on a business with real, stable earnings is a stronger bargain signal than a low P/E alone.",
  },
  fcfYield: {
    name: "Annual FCF Yield %",
    what: "Free cash flow (cash from operations minus capital spending) over the past year, divided by the company's market value - how much real cash the business threw off relative to what you'd pay for it.",
    read: "Higher means the business generates more free cash relative to its price - cash that can fund dividends, buybacks, debt paydown, or reinvestment. Negative means the business burned cash rather than generating it.",
    range: "Where it's populated, the middle 80% of names run roughly -0.05% to +8%, with a median near 3.6%. It's left blank when this screener can't reliably reconstruct the company's annual free cash flow from its SEC filings - a data-availability gap, not a statement about the business.",
    why: "Free cash flow is harder to dress up than reported earnings, so a genuinely high FCF yield is one of the more trustworthy bargain signals here. A stock with a low or negative FCF yield despite a low P/E is a common value-trap pattern worth investigating.",
  },
  roic: {
    name: "Annual GAAP ROIC %",
    what: "Return on invested capital - how efficiently the company turns the capital invested in the business (both debt and equity) into profit.",
    read: "Higher means more profit generated per dollar of capital employed - a sign of a business with a real competitive advantage. Consistently high ROIC, well above the cost of that capital, is a hallmark of a quality company.",
    range: "Where it's populated, the middle 80% of names run roughly 5%-52%, with a median near 13%. It's left blank when invested capital is zero or negative, since the ratio isn't economically meaningful in that case.",
    why: "ROIC is one of the stronger quality checks available here - a cheap stock with strong, durable ROIC is a much more credible bargain than a cheap stock with weak or volatile returns on its capital.",
  },
  fcfConversion: {
    name: "Annual FCF Conversion vs Net Income %",
    what: "How much of the company's reported net income actually shows up as free cash flow - annual free cash flow divided by net income, as a percentage.",
    read: "Around 100% means reported profit and actual cash generation are closely matched - a good sign that earnings are \"real.\" Well below 100% can mean profits are propped up by non-cash accounting items or growing receivables; well above 100% often just reflects a heavy non-cash expense like depreciation.",
    range: "Where it's populated, the middle 80% of names run roughly 29%-206%, with a median near 107%. It's left blank for the same reason as FCF Yield - when this screener can't reliably reconstruct annual free cash flow from the company's filings.",
    why: "This is a quality-of-earnings check. A stock that looks cheap on paper (low P/E) but converts very little of its reported profit into actual cash is a classic red flag worth investigating before assuming the low price is a genuine bargain.",
  },
  netDebtEbitda: {
    name: "Net Debt / EBITDA (TTM)",
    what: "Roughly how many years of core operating earnings it would take to pay off the company's debt, after netting out its cash. Net debt (total debt minus cash) divided by trailing EBITDA.",
    read: "Lower is better - less debt relative to earning power. A negative value means the company holds more cash than debt (net cash), which is a real strength, not a gap in the data.",
    range: "Where it's populated, the middle 80% of names run roughly 0.05-5.7, with a median near 2.0. It's left blank for financial institutions (where this measure doesn't apply), when EBITDA is zero or negative, or when this screener can't align the company's SEC balance-sheet data closely enough to the EBITDA period to trust the comparison.",
    why: "This is one of the sharper leverage-risk checks here. A high Net Debt/EBITDA is a common thread in value traps - a stock can look cheap precisely because the market is pricing in debt-service risk. A negative reading (net cash) is a genuine cushion.",
  },
  basicShareChange: {
    name: "Annual Basic Weighted-Average Shares Change %",
    what: "How much the company's basic weighted-average share count changed over the past year - a read on dilution or buybacks.",
    read: "Positive means the share count grew (dilution - each existing share represents a smaller slice of the company). Negative means the share count shrank (typically from buybacks), which usually benefits remaining shareholders.",
    range: "The middle 80% of names here run roughly -4.7% to +2.6%, with a median near -0.7%, meaning modest net buybacks are typical across this universe. It's occasionally left blank when a company's filing history doesn't give this screener two clean, consecutive annual data points to compare.",
    why: "Heavy, ongoing dilution can quietly erode a shareholder's stake even while the headline numbers look fine - worth checking on any stock that otherwise looks like a bargain. Steady buybacks are a mild positive, though not a reason on their own to consider a stock cheap.",
  },
  valueOpportunity: {
    name: "Value Opportunity",
    what: "This screener's own 0-100 score for how much a stock looks like a genuine bargain, blending sector-relative valuation (weighted heaviest) with profitability, low debt, and a touch of analyst confirmation.",
    read: "Higher means the combined valuation-and-quality signals point more strongly toward \"cheap and healthy.\" It's ranked against the rest of this list, not an absolute scale.",
    range: "0-100 across the full universe. The names at the top of this score are the ones the screener is flagging as the most bargain-like by its own combined criteria.",
    why: "This is one of the two headline numbers the whole screener is built around - the \"does this look cheap for good reasons?\" read. It's meant to be considered together with Trap Risk, not on its own: high Value Opportunity and low Trap Risk together is the combination this tool is trying to surface.",
  },
  trapRisk: {
    name: "Trap Risk",
    what: "This screener's own 0-100 estimate of how likely a cheap-looking stock is actually a value trap - cheap for a bad reason rather than a good one. Built from valuation extremes, leverage, weak momentum, and negative sentiment/analyst signals.",
    read: "Higher means more warning signs are present that the low price may be justified rather than a bargain. It only sees valuation, leverage, momentum, sentiment, and analyst data - it cannot see things like deteriorating revenue trends, margin compression, or guidance cuts, so a high reading is a prompt to dig deeper, not a final verdict.",
    range: "0-100 across the full universe.",
    why: "This is the direct counterweight to Value Opportunity, built specifically to catch the classic mistake of buying something cheap that keeps getting cheaper. A stock scoring high on both Value Opportunity and Trap Risk is the \"interesting but dangerous\" case worth researching most carefully before drawing any conclusion.",
  },
  score: {
    name: "Composite Score",
    what: "The overall ranking number for this screener - a blend of six weighted categories: Valuation 35%, Quality 30%, Growth 10%, Sentiment 10%, Risk 10%, and Momentum 5%.",
    read: "Higher means the stock ranks better across the screener's combined criteria. This is the number that determines the stock's position in the main ranked table.",
    range: "0-100, relative to the rest of this list - Tier A is roughly the top of the range, Tier F the bottom.",
    why: "The single summary number is a useful starting point, but the real insight is in its parts - the bucket scores and individual metrics that explain WHY a stock ranks where it does. A high score is a reason to look closer, not a verdict on its own.",
  },
};

function statValueFor(metricId, c) {
  if (metricId === 'valueOpportunity') return c.valueOpportunity;
  if (metricId === 'trapRisk') return c.valueTrapRisk;
  if (metricId === 'score') return c.composite;
  return c[metricId];
}

/* ---- sample data (fallback only) ---- */
const SAMPLE_COMPANIES = [
  { ticker: 'NOVA', name: 'Nova Semiconductor', sector: 'Technology', pe: 34, pb: 9.1, ret3m: 22, ret6m: 41, roe: 28, debtEquity: 0.4, sentiment: 0.62, analyst: 88, beta: 1.35 },
  { ticker: 'MEDX', name: 'MedixCare Health',   sector: 'Healthcare', pe: 18, pb: 3.2, ret3m: 6,  ret6m: 11, roe: 24, debtEquity: 0.5, sentiment: 0.28, analyst: 74, beta: 0.72 },
  { ticker: 'PETRO',name: 'Petrolux Energy',    sector: 'Energy',     pe: 9,  pb: 1.3, ret3m: 11, ret6m: 24, roe: 21, debtEquity: 0.8, sentiment: 0.22, analyst: 68, beta: 1.05 },
  { ticker: 'SHOP', name: 'ShopStream Retail',  sector: 'Consumer',   pe: 22, pb: 4.1, ret3m: 9,  ret6m: 17, roe: 20, debtEquity: 0.6, sentiment: 0.37, analyst: 72, beta: 0.95 },
  { ticker: 'PIXL', name: 'Pixel Media',        sector: 'Technology', pe: 61, pb: 8.8, ret3m: -6, ret6m: -12,roe: 11, debtEquity: 1.4, sentiment: -0.18,analyst: 52, beta: 1.70 },
];

/* ---- scoring engine ---- */
function percentileScore(value, allValues, lowerIsBetter) {
  const clean = allValues.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  const n = clean.length;
  if (n === 0 || value === null || value === undefined || Number.isNaN(value)) return null;
  let below = 0, equal = 0;
  for (const v of clean) { if (v < value) below++; else if (v === value) equal++; }
  let pct = ((below + 0.5 * equal) / n) * 100;
  if (lowerIsBetter) pct = 100 - pct;
  return pct;
}

function resolveBroadSector(c) {
  return TICKER_SECTOR_OVERRIDES[c.ticker] || broadSectorFor(c.sector);
}

// turnaroundBaseline is optional (defaults to "no history available") so
// existing callers - research.js's own scoreUniverse(loadCompanies()) call,
// in particular - keep working unchanged. TURNAROUND CANDIDATE simply never
// fires for those call paths, which is correct: research candidate
// selection only ever checks POSSIBLE_VALUE_TRAP/UNDERVALUED_QUALITY/
// UNDERVALUED_HIGH_RISK/high-on-both, all of which are checked earlier in
// classify()'s priority order and are completely unaffected either way.
function scoreUniverse(companies, turnaroundBaseline) {
  const turnaround = turnaroundBaseline || { eligible: false, companies: {} };
  const keys = Object.keys(METRICS);

  // Market-wide comparison columns: used directly for market-wide metrics,
  // and as the fallback for sector-relative metrics when a company's broad
  // sector is 'Other' or too thin to trust (see SECTOR_MIN_SIZE).
  const marketCols = {};
  for (const k of keys) marketCols[k] = companies.map((c) => c[k]);

  // Sector-scoped comparison columns, grouped by broad (GICS-style) sector -
  // not the granular SIC description, which is preserved untouched on `c.sector`
  // for the report's sector-ranking panel. Built once per sector (not per
  // company). Only computed for sectors that clear SECTOR_MIN_SIZE, and only
  // for the metric keys actually marked sectorRelative - everything else uses
  // marketCols.
  const byBroadSector = {};
  for (const c of companies) (byBroadSector[resolveBroadSector(c)] ??= []).push(c);

  const sectorCols = {}; // sectorCols[broadSectorName][metricKey] -> array of values
  for (const [sectorName, group] of Object.entries(byBroadSector)) {
    if (sectorName === 'Other' || group.length < SECTOR_MIN_SIZE) continue;
    sectorCols[sectorName] = {};
    for (const k of keys) {
      if (METRICS[k].sectorRelative) sectorCols[sectorName][k] = group.map((c) => c[k]);
    }
  }

  const scored = companies.map((c) => {
    const broadSector = resolveBroadSector(c);
    const metricScores = {};
    for (const k of keys) {
      const sectorGroupCols = METRICS[k].sectorRelative ? sectorCols[broadSector] : null;
      const comparisonCol = sectorGroupCols ? sectorGroupCols[k] : marketCols[k];
      metricScores[k] = percentileScore(c[k], comparisonCol, METRICS[k].lowerIsBetter);
    }
    // Growth bucket coverage/eligibility: same shrink-toward-neutral +
    // flag pattern already used for the Composite/Value Opportunity/Value
    // Trap Risk scores (weightedCompositeWithCoverage, defined above), not
    // a separate mechanism. A stock with only 1 of its 3 growth metrics
    // populated (frequently now for a real reason - see
    // GROWTH_BUCKET_MIN_COVERAGE) gets its growth bucket pulled toward 50
    // in proportion to how little of it is actually covered, instead of
    // silently averaging over whatever's left as if the bucket were fully
    // resolved. Every other bucket keeps its original simple-average
    // behavior unchanged.
    const bucketScores = {};
    let growthBucketRaw = null, growthBucketCoverage = 0, growthBucketEligible = true;
    for (const b of Object.keys(BUCKET_WEIGHTS)) {
      if (b === 'growth') {
        const growthKeys = keys.filter((k) => METRICS[k].bucket === 'growth');
        const growthResult = weightedCompositeWithCoverage(
          growthKeys.map((k) => [metricScores[k], 1 / growthKeys.length])
        );
        bucketScores.growth = growthResult.adjusted;
        growthBucketRaw = growthResult.raw;
        growthBucketCoverage = growthResult.coverage;
        growthBucketEligible = growthResult.coverage >= GROWTH_BUCKET_MIN_COVERAGE;
        continue;
      }
      const vals = keys.filter((k) => METRICS[k].bucket === b).map((k) => metricScores[k]).filter((s) => s !== null);
      bucketScores[b] = vals.length ? vals.reduce((a, x) => a + x, 0) / vals.length : null;
    }
    let wSum = 0, wUsed = 0;
    for (const b of Object.keys(BUCKET_WEIGHTS)) {
      if (bucketScores[b] !== null) { wSum += bucketScores[b] * BUCKET_WEIGHTS[b]; wUsed += BUCKET_WEIGHTS[b]; }
    }

    // Value Opportunity now carries explicit coverage/confidence information.
    // Low-coverage opportunity scores are gated rather than being allowed to
    // become artificially strong through full renormalization.
    const opportunityResult = scoreValueOpportunity(metricScores);
    const valueOpportunityRaw = opportunityResult.raw;
    const valueOpportunityCoverage = opportunityResult.coverage;
    const valueOpportunityEligible = opportunityResult.eligible;
    const valueOpportunity = opportunityResult.adjusted;

    const trapResult = scoreValueTrapRisk(metricScores);
    const valueTrapRisk = trapResult.adjusted;
    const valueTrapRiskRaw = trapResult.raw;
    const valueTrapRiskCoverage = trapResult.coverage;
    const valueTrapRiskEligible = trapResult.eligible;

    // Main composite keeps the same underlying bucket calculation, but an
    // incomplete score is pulled toward neutral 50 instead of receiving the
    // full benefit of renormalization.
    const compositeRaw = wUsed ? wSum / wUsed : 0;
    const compositeCoverage = wUsed;
    const compositeEligible = compositeCoverage >= MAIN_SCORE_MIN_COVERAGE;
    const composite = shrinkToNeutral(compositeRaw, compositeCoverage);

    const classification = classify(
      bucketScores,
      valueOpportunity,
      valueTrapRisk,
      composite,
      valueTrapRiskEligible,
      metricScores,
      c.marginTrend,
      turnaround.eligible ? turnaround.companies[c.ticker] : null
    );

    return {
      ...c,
      broadSector,
      metricScores,
      bucketScores,

      composite,
      compositeRaw,
      compositeCoverage,
      compositeEligible,

      valueOpportunity,
      valueOpportunityRaw,
      valueOpportunityCoverage,
      valueOpportunityEligible,

      valueTrapRisk,
      valueTrapRiskRaw,
      valueTrapRiskCoverage,
      valueTrapRiskEligible,

      growthBucketRaw,
      growthBucketCoverage,
      growthBucketEligible,
      classification
    };
  });

  // Market-wide percentiles for the three blended scores, purely for cell
  // coloring (Phase 8 UX) - metricScores already carries direction-normalized
  // percentiles for the raw metric columns, reused as-is for those. Trap Risk
  // is inverted here (lowerIsBetter: true) for coloring only: a LOW trap
  // score should read green (safe), even though the number itself represents
  // risk magnitude, not quality - the raw value/label are untouched.
  const compositeVals = scored
    .filter((c) => c.compositeEligible)
    .map((c) => c.composite);

  const opportunityVals = scored
    .map((c) => c.valueOpportunity)
    .filter((v) => v !== null && v !== undefined);

  const trapVals = scored.map((c) => c.valueTrapRisk);

  for (const c of scored) {
    c.colorPercentiles = {
      score: c.compositeEligible
        ? percentileScore(c.composite, compositeVals, false)
        : null,
      valueOpp: percentileScore(c.valueOpportunity, opportunityVals, false),
      trapRisk: percentileScore(c.valueTrapRisk, trapVals, true),
    };
  }

  // Companies below the minimum Main Score coverage are placed behind
  // rank-eligible companies regardless of their numerical adjusted score.
  // Within each group, higher score still ranks first.
  scored.sort((a, b) => {
    if (a.compositeEligible !== b.compositeEligible) {
      return a.compositeEligible ? -1 : 1;
    }
    return b.composite - a.composite;
  });

  const n = scored.length, GRADES = ['A', 'B', 'C', 'D', 'F'];
  scored.forEach((c, i) => { c.rank = i + 1; c.tier = GRADES[Math.min(4, Math.floor((i / n) * 5))]; });
  return scored;
}

// Phase 6 operational layer: which tickers are flagged for research THIS
// run, given the current (corrected) scores - the full union, uncapped,
// regardless of whether research already exists for them. Capping and
// NEW/STALE/FRESH categorization are research.js's job (it needs to check
// existing research files and live SEC filing dates, neither of which this
// function touches); this only answers "is this ticker a candidate today
// and at what priority," reusable by both research.js (to build the queue)
// and screener.js itself (to know which tickers to show a freshness badge
// for, without any live network call at report-generation time).
function selectResearchCandidates(scored, watchlist) {
  const byTicker = {};
  for (const c of scored) byTicker[c.ticker] = c;

  const watchlistCands = watchlist.filter((t) => byTicker[t]);

  const trapCands = scored
    .filter((c) => c.classification === CLASSIFICATION.POSSIBLE_VALUE_TRAP)
    .sort((a, b) => (b.valueOpportunity + b.valueTrapRisk) - (a.valueOpportunity + a.valueTrapRisk))
    .map((c) => c.ticker);

  const highBothCands = scored
    .filter((c) => c.valueOpportunity !== null && c.valueTrapRisk !== null
      && c.valueOpportunity >= HIGH_BOTH_THRESHOLD && c.valueTrapRisk >= HIGH_BOTH_THRESHOLD)
    .sort((a, b) => (b.valueOpportunity + b.valueTrapRisk) - (a.valueOpportunity + a.valueTrapRisk))
    .map((c) => c.ticker);

  const restCands = scored
    .filter((c) => c.classification === CLASSIFICATION.UNDERVALUED_QUALITY
      || c.classification === CLASSIFICATION.UNDERVALUED_HIGH_RISK)
    .sort((a, b) => b.composite - a.composite)
    .map((c) => c.ticker);

  const tierOf = {};
  for (const t of watchlistCands) tierOf[t] = tierOf[t] || 'watchlist';
  for (const t of trapCands) tierOf[t] = tierOf[t] || 'trap';
  for (const t of highBothCands) tierOf[t] = tierOf[t] || 'highBoth';
  for (const t of restCands) tierOf[t] = tierOf[t] || 'rest';

  const seen = new Set();
  const ordered = [];
  for (const t of [...watchlistCands, ...trapCands, ...highBothCands, ...restCands]) {
    if (!seen.has(t)) { seen.add(t); ordered.push({ ticker: t, tier: tierOf[t] }); }
  }
  return ordered;
}

function rankSectors(scored) {
  const by = {};
  for (const c of scored) (by[c.sector] ??= []).push(c.composite);
  return Object.entries(by)
    .map(([sector, s]) => ({ sector, avg: s.reduce((a, x) => a + x, 0) / s.length }))
    .sort((a, b) => b.avg - a.avg);
}

/* ---- display helpers ---- */
function scoreColor(score) {
  if (score === null || score === undefined) return 'transparent';
  const t = Math.max(0, Math.min(100, score)) / 100;
  return 'hsl(' + (t * 165).toFixed(0) + ', 62%, 42%)';
}

// Phase 8: green/yellow/red tertile banding for data cells, driven by a
// percentile that's already direction-normalized (higher = better) - reuses
// metricScores for the raw metric columns (already sector-relative where
// appropriate, per Phase 4) and colorPercentiles for Score/Value Opp/Trap
// Risk. Null percentile -> no band -> cell stays neutral/uncolored.
// Direction B palette (see screener-design-options.html, reference only).
const BAND_COLOR = { good: '#34d399', mid: '#f0a868', bad: '#ff7b72' };
function bandFor(percentile) {
  if (percentile === null || percentile === undefined) return null;
  if (percentile >= 200 / 3) return 'good';
  if (percentile >= 100 / 3) return 'mid';
  return 'bad';
}
function bandStyle(percentile) {
  const band = bandFor(percentile);
  return band ? 'background:' + BAND_COLOR[band] + '26' : '';
}
// Direction B score meter: a small horizontal bar next to Value Opp/Trap
// Risk, filled to the percentile and colored by the same good/mid/bad band
// already used everywhere else - display-only, reads the same
// colorPercentiles values bandStyle() above already uses.
function meterHTML(percentile) {
  if (percentile === null || percentile === undefined) return '';
  const band = bandFor(percentile);
  const color = band ? BAND_COLOR[band] : '#8b949e';
  const width = Math.max(0, Math.min(100, percentile));
  return '<span class="meter"><i style="width:' + width.toFixed(0) + '%;background:' + color + '"></i></span>';
}

const TIER_COLOR = { A: '#10b981', B: '#a3e635', C: '#f0a868', D: '#f0883e', F: '#ff7b72' };
// Reuses the label groupings you'd expect from the classification names -
// explicit buckets (undervalued/quality = green, trap/distressed = red,
// momentum = blue, quality-at-fair-value = orange, mixed = grey) for the
// clearly-matching labels; the remaining labels (expensive quality,
// turnaround candidate) get a distinct color from the same family so all
// 10 stay visually distinguishable in a 503-row table.
const CLASSIFICATION_COLOR = {
  [CLASSIFICATION.DISTRESSED]: '#ff7b72',
  [CLASSIFICATION.POSSIBLE_VALUE_TRAP]: '#ff7b72',
  [CLASSIFICATION.UNDERVALUED_HIGH_RISK]: '#a3e635',
  [CLASSIFICATION.UNDERVALUED_QUALITY]: '#34d399',
  [CLASSIFICATION.EXPENSIVE_QUALITY]: '#a78bfa',
  [CLASSIFICATION.QUALITY_AT_FAIR_VALUE]: '#f0a868',
  [CLASSIFICATION.TURNAROUND_CANDIDATE]: '#22d3ee',
  [CLASSIFICATION.GROWTH_AT_REASONABLE_PRICE]: '#4ade80',
  [CLASSIFICATION.MOMENTUM_LEADER]: '#79b8ff',
  [CLASSIFICATION.MIXED]: '#8b949e',
};

function fmtCell(key, v) {
  if (v === null || v === undefined) return '\u2014';
  if (key === 'sentiment') return Number(v).toFixed(2);
  if (key === 'analyst')   return Number(v).toFixed(0);
  if (key === 'peg' || key === 'netDebtEbitda') return Number(v).toFixed(2);
  return Number(v).toFixed(1);
}

// Display-only percentile for table-cell coloring, computed fresh from
// `scored` for fields that live in STAT_METRICS but NOT in METRICS (so they
// have no scoring-pipeline metricScores/colorPercentiles entry). Market-wide
// only (these fields carry no sectorRelative flag), unlike the real
// scoring percentiles - purely cosmetic, never read by scoreUniverse() or
// anything upstream of it.
function computeDisplayPercentiles(scored, keys) {
  const out = {};
  for (const key of keys) {
    const lowerIsBetter = !!(STAT_METRICS[key] && STAT_METRICS[key].lowerIsBetter);
    const values = scored.map((c) => c[key]).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
    const byTicker = {};
    for (const c of scored) {
      const v = c[key];
      if (v === null || v === undefined || Number.isNaN(v) || !values.length) { byTicker[c.ticker] = null; continue; }
      let below = 0, equal = 0;
      for (const other of values) {
        if (other < v) below++;
        else if (other === v) equal++;
      }
      const pct = ((below + 0.5 * equal) / values.length) * 100;
      byTicker[c.ticker] = lowerIsBetter ? 100 - pct : pct;
    }
    out[key] = byTicker;
  }
  return out;
}

/* ---- the cheat sheet content ---- */
const GUIDE = [
  { name: 'Score & Tier', what: 'The overall grade: a 0-100 blend of every column, then A-F by rank. Judged against THIS list, not the whole market.',
    bands: [['A / 80-100', 'top of this list'], ['B / 60-80', 'above average'], ['C / 40-60', 'the middle'], ['D / 20-40', 'below average'], ['F / 0-20', 'bottom of this list']] },
  { name: 'P/E', what: 'Price per $1 of yearly earnings - lower is cheaper. Compare within a sector: tech runs high, banks run low.',
    bands: [['under 10', 'cheap - value or low growth'], ['10-20', 'fair for a mature company'], ['20-30', 'growth expectations built in'], ['over 30', 'expensive / priced for big growth'], ['blank', 'no profit to measure']] },
  { name: 'P/B', what: 'Price vs. the company net book (asset) value.',
    bands: [['under 1', 'below book - deep value or trouble'], ['1-3', 'normal'], ['3-5', 'a premium'], ['over 5', 'high premium (common in tech)']] },
  { name: '3M / 6M Return', what: 'Price change over the last 3 or 6 months - recent momentum.',
    bands: [['over +20%', 'hot - maybe overextended'], ['positive', 'uptrend'], ['near 0', 'flat'], ['negative', 'downtrend'], ['under -20%', 'weak']] },
  { name: 'ROE %', what: 'Profit made per $1 of shareholder equity - higher means more efficient.',
    bands: [['over 20%', 'excellent (check it is not debt-fueled)'], ['15-20%', 'strong'], ['5-15%', 'average'], ['under 5%', 'weak'], ['negative', 'losing money']] },
  { name: 'Debt / Equity', what: 'Debt relative to equity - lower is less risky. Banks and utilities normally run high.',
    bands: [['under 0.5', 'conservative'], ['0.5-1', 'moderate'], ['1-2', 'elevated'], ['over 2', 'high leverage - riskier']] },
  { name: 'News Sentiment', what: 'A keyword read of recent headlines, -1 to +1. Rough by design, not a full model.',
    bands: [['over +0.5', 'strongly positive'], ['+0.2 to +0.5', 'positive'], ['-0.2 to +0.2', 'neutral / mixed'], ['under -0.2', 'negative coverage']] },
  { name: 'Analyst Score', what: 'Wall Street buy/hold/sell consensus turned into a 0-100 score.',
    bands: [['over 75', 'strong buy consensus'], ['60-75', 'lean buy'], ['40-60', 'hold / mixed'], ['under 40', 'lean sell']] },
  { name: 'Beta', what: 'How much it swings vs. the whole market (market = 1.0).',
    bands: [['under 0.8', 'calmer than the market'], ['0.8-1.2', 'moves with the market'], ['over 1.2', 'swings more than the market']] },
  { name: 'Value Opportunity', what: 'Cheap-and-healthy read: sector-relative valuation weighted heaviest, plus profitability, low debt, and mild analyst confirmation. Independent of the main Score - can be high even when the overall grade is not.',
    bands: [['80-100', 'strong opportunity signal'], ['60-79', 'notable'], ['40-59', 'moderate'], ['under 40', 'weak/none']] },
  { name: 'Value Trap Risk', what: 'Cheap-for-a-reason read: weak momentum, high leverage, negative sentiment, weak analyst support. Cannot see revenue/EPS deterioration, margin compression, or guidance cuts - no data for those yet. A high score is a prompt to research, not a verdict.',
    bands: [['80-100', 'strong warning signal'], ['60-79', 'notable'], ['40-59', 'moderate'], ['under 40', 'weak/none']] },
  { name: 'Classification', what: 'A plain-English label derived purely from the Score/Value Opportunity/Value Trap Risk/Quality/Valuation/Growth reads above - not a separate analysis, and not a verdict. Turnaround Candidate additionally needs real snapshot history (see below) - MIXED means "doesn\'t cleanly fit any pattern," not "bad."',
    bands: [['UNDERVALUED QUALITY', 'cheap, healthy, low risk flags'], ['UNDERVALUED / HIGH RISK', 'cheap, real risk present'], ['POSSIBLE VALUE TRAP', 'cheap, risk flags loud'], ['DISTRESSED', 'not even cheap-and-healthy, severe flags'], ['EXPENSIVE QUALITY', 'strong business, rich price'], ['QUALITY AT FAIR VALUE', 'strong business, fair price'], ['TURNAROUND CANDIDATE', 'was struggling, now improving vs. a prior snapshot'], ['GROWTH AT REASONABLE PRICE', 'genuine growth, not overpaying for it'], ['MOMENTUM LEADER', 'strong recent returns + solid fundamentals'], ['MIXED', 'no clean pattern']] },
];

// Embeds arbitrary data (including real, external headline text) inside an
// inline <script> block safely: the HTML parser looks for "</script" before
// the JS parser ever sees the string, so a headline that happened to contain
// that literal substring could otherwise truncate the script early. Escaping
// the forward slash defuses it without changing the decoded string value.
function safeJSONEmbed(obj) {
  return JSON.stringify(obj).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

/* ---- HTML report ---- */
// Phase 8: static server-rendered "what changed" card - all the data it
// needs (gainers/losers/classification changes/etc.) is already fully
// computed by computeChanges() at generation time, so unlike the detail
// panel this doesn't need a client-side lazy-build step.
function moveRow(m) {
  const arrow = m.scoreDelta > 0 ? '&#9650;' : m.scoreDelta < 0 ? '&#9660;' : '&#9679;';
  const cls = m.scoreDelta > 0 ? 'move-up' : m.scoreDelta < 0 ? 'move-down' : 'move-flat';
  return '<div class="move-row"><span class="move-ticker">' + m.ticker + '</span>' +
    '<span class="move-delta ' + cls + '">' + arrow + ' ' + (m.scoreDelta > 0 ? '+' : '') + m.scoreDelta.toFixed(1) + '</span>' +
    (m.classificationBefore !== m.classificationAfter
      ? '<span class="move-class">' + m.classificationBefore + ' &rarr; ' + m.classificationAfter + '</span>'
      : '') +
    '</div>';
}

function buildChangesCardHTML(changes) {
  if (!changes.hasHistory) {
    return '<div class="card changes-card"><h2>What Changed</h2>' +
      '<p class="hint">No prior snapshot yet - history starts today. Check back after the next run to see what moved.</p></div>';
  }
  const gainers = changes.gainers.filter((m) => m.scoreDelta > 0).slice(0, 8).map(moveRow).join('') || '<p class="hint">No gainers.</p>';
  const losers = changes.losers.filter((m) => m.scoreDelta < 0).slice(0, 8).map(moveRow).join('') || '<p class="hint">No losers.</p>';

  const classCount = changes.classificationChanges.length;
  const classRows = classCount
    ? changes.classificationChanges.map((c) =>
        '<div class="move-row"><span class="move-ticker">' + c.ticker + '</span>' +
        '<span class="move-class">' + c.from + ' &rarr; ' + c.to + '</span></div>').join('')
    : '';

  const riskRows = changes.newRiskFlags.length
    ? changes.newRiskFlags.map((c) =>
        '<div class="move-row"><span class="move-ticker">' + c.ticker + '</span>' +
        '<span class="move-class risk-flag">' + c.from + ' &rarr; ' + c.to + '</span></div>').join('')
    : '<p class="hint">None.</p>';

  const summary = [
    classCount + ' classification change' + (classCount === 1 ? '' : 's'),
    changes.newRiskFlags.length + ' new risk flag' + (changes.newRiskFlags.length === 1 ? '' : 's'),
    changes.enteredTopTier.length + ' entered Tier ' + TOP_TIER,
    changes.leftTopTier.length + ' left Tier ' + TOP_TIER,
    changes.newEntries.length + ' new',
    changes.dropped.length + ' dropped',
  ].join('  &middot;  ');

  // Classification Changes can be a long itemized list (one row per moved
  // ticker) - collapsed behind an expander by default so the card stays
  // compact; nothing is removed, Top Gainers/Losers/New Risk Flags stay
  // visible as before. Styled to match the main table's "Show all" control.
  const classificationExpander = classCount
    ? '<div class="changes-expand">' +
      '<button type="button" class="changes-expand-btn" id="changesExpandBtn" data-count="' + classCount + '">Show ' + classCount + ' change' + (classCount === 1 ? '' : 's') + ' &#9662;</button>' +
      '<div class="changes-expand-body" id="changesExpandBody" hidden><h3>Classification Changes</h3>' + classRows + '</div>' +
      '</div>'
    : '<div class="changes-expand"><p class="hint">No classification changes.</p></div>';

  return '<div class="card changes-card"><h2>What Changed Since ' + changes.previousDate + '</h2>' +
    '<p class="hint changes-summary">' + summary + '</p>' +
    '<div class="changes-grid">' +
    '<div class="changes-col"><h3>Top Gainers</h3>' + gainers + '</div>' +
    '<div class="changes-col"><h3>Top Losers</h3>' + losers + '</div>' +
    '<div class="changes-col"><h3>New Risk Flags</h3>' + riskRows + '</div>' +
    '</div>' +
    classificationExpander +
    '</div>';
}

/* ---- Phase 9: morning brief / dashboard ----
 * A presentation layer only - every list here is a sort/filter/slice over
 * `scored`/`sectors`/`watchlist`/`changes`, all already fully computed
 * before buildHTML() runs. No scoring, no new computation, nothing written
 * to companies.json. Sits above the existing full table; the table and
 * detail panels below are untouched.
 */
const DASH_LIST_SIZE = 8;

function classBadge(classification) {
  const color = CLASSIFICATION_COLOR[classification] || '#8b949e';
  return '<span class="class-badge" style="background:' + color + '26;color:' + color + '">' + classification + '</span>';
}

// Every ticker mention in the dashboard is one of these - a single
// delegated click handler (wired in the script below) finds the matching
// table row and reuses the existing expandRow()/scroll behavior, so
// "clicking a dashboard name" is never a separate preview implementation.
function dashTickerLink(ticker) {
  return '<button type="button" class="dash-ticker-link" data-jump-ticker="' + ticker + '">' + ticker + '</button>';
}

// Phase 6 operational layer: NEW/STALE flagged inline in dashboard rows -
// FRESH/ORPHANED/null render nothing, keeping the common case uncluttered.
function dashFreshnessTag(freshness) {
  if (freshness === 'NEW') return '<span class="dash-flag dash-flag-new">new</span>';
  if (freshness === 'STALE_AGE' || freshness === 'STALE_FILING') return '<span class="dash-flag dash-flag-stale">stale</span>';
  return '';
}

function buildDashboardOpportunitiesHTML(scored) {
  const top = [...scored].filter((c) => c.valueOpportunity != null)
    .sort((a, b) => b.valueOpportunity - a.valueOpportunity)
    .slice(0, DASH_LIST_SIZE);
  if (!top.length) return '<p class="hint">No eligible names this run.</p>';
  return top.map((c) =>
    '<div class="dash-row">' + dashTickerLink(c.ticker) +
    '<span class="dash-row-score">' + c.valueOpportunity.toFixed(1) + '</span>' +
    dashFreshnessTag(c.researchFreshness) + classBadge(c.classification) + '</div>'
  ).join('');
}

function buildDashboardTrapsHTML(scored) {
  const top = [...scored].filter((c) => c.valueTrapRisk != null)
    .sort((a, b) => b.valueTrapRisk - a.valueTrapRisk)
    .slice(0, DASH_LIST_SIZE);
  if (!top.length) return '<p class="hint">No eligible names this run.</p>';
  return top.map((c) => {
    const cheapButDangerous = c.valueOpportunity != null && c.valueOpportunity >= HIGH_BOTH_THRESHOLD;
    return '<div class="dash-row">' + dashTickerLink(c.ticker) +
      '<span class="dash-row-score dash-row-danger">' + c.valueTrapRisk.toFixed(1) + '</span>' +
      dashFreshnessTag(c.researchFreshness) +
      (cheapButDangerous ? '<span class="dash-flag">cheap but dangerous</span>' : classBadge(c.classification)) +
      '</div>';
  }).join('');
}

function buildDashboardWatchlistHTML(scored, watchlist, changes) {
  if (!watchlist.length) {
    return '<p class="hint">No watchlist stocks yet - star some in the table below.</p>';
  }
  const byTicker = {};
  for (const c of scored) byTicker[c.ticker] = c;
  const rows = watchlist.map((ticker) => {
    const c = byTicker[ticker];
    if (!c) return '<div class="dash-row">' + dashTickerLink(ticker) + '<span class="hint">not in this run\'s universe</span></div>';
    const change = changes.hasHistory ? changes.perTicker[ticker] : null;
    const deltaHtml = change
      ? '<span class="move-delta ' + (change.scoreDelta > 0 ? 'move-up' : change.scoreDelta < 0 ? 'move-down' : 'move-flat') + '">'
        + (change.scoreDelta > 0 ? '+' : '') + change.scoreDelta.toFixed(1) + '</span>'
      : '';
    return '<div class="dash-row">' + dashTickerLink(ticker) +
      '<span class="dash-row-score">' + c.composite.toFixed(1) + '</span>' +
      deltaHtml + dashFreshnessTag(c.researchFreshness) + classBadge(c.classification) + '</div>';
  });
  return rows.join('');
}

function buildDashboardSectorsHTML(sectors) {
  if (!sectors.length) return '<p class="hint">No sector data this run.</p>';
  const best = sectors.slice(0, 3);
  const worst = sectors.slice(-3).reverse();
  const row = (s) => '<div class="dash-row"><span class="dash-sector-name">' + s.sector + '</span>' +
    '<span class="dash-row-score" style="color:' + scoreColor(s.avg) + '">' + s.avg.toFixed(1) + '</span></div>';
  return '<div class="dash-sector-group"><h4>Best</h4>' + best.map(row).join('') + '</div>' +
    '<div class="dash-sector-group"><h4>Worst</h4>' + worst.map(row).join('') + '</div>';
}

// Direction B stat-card row: four numbers pulled from data buildChangesCardHTML/
// buildDashboardOpportunitiesHTML/buildDashboardTrapsHTML already compute -
// no new business logic, just a display-level summary of what those cards
// already show below it (the "Traps to watch" count is literally the length
// of the same top-N list buildDashboardTrapsHTML renders, so the two always
// agree).
function buildStatCardsHTML(scored, changes) {
  const classChanges = changes.hasHistory ? changes.classificationChanges.length : null;
  const riskFlags = changes.hasHistory ? changes.newRiskFlags.length : null;
  const topOpp = [...scored].filter((c) => c.valueOpportunity != null)
    .sort((a, b) => b.valueOpportunity - a.valueOpportunity)[0];
  const trapCount = [...scored].filter((c) => c.valueTrapRisk != null)
    .sort((a, b) => b.valueTrapRisk - a.valueTrapRisk)
    .slice(0, DASH_LIST_SIZE).length;
  return '<div class="cards">' +
    '<div class="stat"><div class="k">Classification changes</div><div class="v">' +
      (classChanges === null ? '—' : classChanges) + '</div><div class="d">' +
      (changes.hasHistory ? 'since ' + changes.previousDate : 'no prior snapshot yet') + '</div></div>' +
    '<div class="stat"><div class="k">New risk flags</div><div class="v' + (riskFlags ? ' warn' : '') + '">' +
      (riskFlags === null ? '—' : riskFlags) + '</div><div class="d">' +
      (changes.hasHistory ? (riskFlags ? 'today' : 'none today') : 'no prior snapshot yet') + '</div></div>' +
    '<div class="stat"><div class="k">Top opportunity</div><div class="v em">' +
      (topOpp ? topOpp.ticker : '—') + '</div><div class="d">' +
      (topOpp ? 'score ' + topOpp.valueOpportunity.toFixed(1) : 'no eligible names') + '</div></div>' +
    '<div class="stat"><div class="k">Traps to watch</div><div class="v">' + trapCount + '</div><div class="d">' +
      (trapCount ? 'highest risk names' : 'none flagged') + '</div></div>' +
    '</div>';
}

function buildDashboardHTML(scored, sectors, watchlist, changes, changesCardHTML, generated) {
  return '<div class="dashboard">' +
    '<div class="dash-top"><h2>Morning Brief</h2><span class="dash-timestamp">as of ' + generated + '</span></div>' +
    buildStatCardsHTML(scored, changes) +
    changesCardHTML +
    '<div class="dash-grid">' +
    '<div class="card dash-card"><h2><span class="dot g"></span>Top Opportunities</h2>' + buildDashboardOpportunitiesHTML(scored) + '</div>' +
    '<div class="card dash-card"><h2><span class="dot r"></span>Watch For Traps</h2>' + buildDashboardTrapsHTML(scored) + '</div>' +
    '<div class="card dash-card"><h2>My Watchlist</h2>' + buildDashboardWatchlistHTML(scored, watchlist, changes) + '</div>' +
    '<div class="card dash-card"><h2>Sector Snapshot</h2>' + buildDashboardSectorsHTML(sectors) + '</div>' +
    '</div></div>';
}

function buildHTML(scored, sectors, watchlist, stockDetails, metricDistributions, changes) {
  const watchlistSet = new Set(watchlist);
  const keys = Object.keys(METRICS);
  // Column toggle: every field that makes sense as a table column is always
  // rendered into the DOM (so search/sort/values are untouched regardless of
  // what's currently shown) with data-col set to its real field name. The 9
  // STAT_METRICS-only fields (never in METRICS) get a display-only
  // percentile computed fresh here purely for cell coloring - see
  // computeDisplayPercentiles()'s comment. Visibility itself is entirely
  // client-side (a dynamically-updated <style> tag), not baked into this
  // HTML - see the "Columns" picker wiring further down.
  const EXTRA_COLUMN_KEYS = ['peg', 'evEbitda', 'fcfYield', 'roic', 'fcfConversion', 'netDebtEbitda', 'basicShareChange', 'ret1y', 'pctBelow52wHigh'];
  const allMetricColKeys = keys.concat(EXTRA_COLUMN_KEYS);
  const displayPercentiles = computeDisplayPercentiles(scored, EXTRA_COLUMN_KEYS);
  const colLabel = (k) => (METRICS[k] ? METRICS[k].label : STAT_METRICS[k].label);

  // Every toggleable column (identity columns rank/ticker/name/the star
  // control are always on and not part of this list). Order here is the
  // order they appear in the Columns picker checkbox list.
  const TOGGLEABLE_COLUMN_KEYS = ['tier', 'sector', 'classification', 'score', 'valueOpp', 'trapRisk'].concat(allMetricColKeys);
  const KEY_ONLY_PRESET = ['score', 'valueOpp', 'trapRisk', 'classification', 'pe', 'roe', 'debtEquity', 'epsGrowth'];
  const toggleColLabel = (k) => {
    if (k === 'valueOpp') return 'Value Opp';
    if (k === 'trapRisk') return 'Trap Risk';
    if (k === 'score') return 'Score';
    if (k === 'classification') return 'Classification';
    if (k === 'sector') return 'Sector';
    if (k === 'tier') return 'Tier';
    return colLabel(k);
  };
  const colPickerCheckboxes = TOGGLEABLE_COLUMN_KEYS.map((k) =>
    '<label><input type="checkbox" data-col-toggle="' + k + '" checked>' + toggleColLabel(k) + '</label>').join('');

  const generated = new Date().toLocaleString();
  const changesCardHTML = buildChangesCardHTML(changes);
  const dashboardHTML = buildDashboardHTML(scored, sectors, watchlist, changes, changesCardHTML, generated);

  // Congressional trade disclosures - display-only, never scored. One flat
  // list embedded once and shared by both the per-stock detail panel (filtered
  // client-side by ticker) and the dedicated Political Trades page (feed +
  // leaderboards) - see buildPoliticalTradesHTML() and the page-political
  // section further down. Company name is attached here since it's a cheap
  // ticker->name lookup already available from `scored`, sparing the client
  // from cross-referencing STOCK_DETAIL just to show a name next to a ticker.
  const congressData = readJSONSafe(path.join(__dirname, 'cache', 'congressTrades.json')) || {};
  const nameByTicker = {};
  for (const c of scored) nameByTicker[c.ticker] = c.name;
  const politicalTrades = (Array.isArray(congressData.trades) ? congressData.trades : []).map((t) => ({
    ...t,
    companyName: nameByTicker[t.ticker] || null,
  }));
  const politicalTradesAsOf = (congressData.meta && congressData.meta.updatedAt) || null;

  // Same collapse pattern as the main table: ordering/bars untouched, only
  // how many render visible by default changes. No search/sort to compose
  // with here (unlike the table), so this is a plain show/hide toggle -
  // matches the "What Changed" classification-list expander's mechanism.
  const SECTOR_COLLAPSE_ROWS = 25;
  const sectorRow = (s, i) =>
    '<div class="sector-row"><span class="sector-rank">' + (i + 1) + '</span>' +
    '<span class="sector-name">' + s.sector + '</span>' +
    '<span class="sector-bar-wrap"><span class="sector-bar" style="width:' + s.avg.toFixed(1) + '%;background:' + scoreColor(s.avg) + '"></span></span>' +
    '<span class="sector-score">' + s.avg.toFixed(1) + '</span></div>';
  const sectorRowsTop = sectors.slice(0, SECTOR_COLLAPSE_ROWS).map(sectorRow).join('');
  const sectorRowsRest = sectors.slice(SECTOR_COLLAPSE_ROWS).map((s, i) => sectorRow(s, i + SECTOR_COLLAPSE_ROWS)).join('');
  const sectorExpandHTML = sectors.length > SECTOR_COLLAPSE_ROWS
    ? '<div class="sector-extra" id="sectorExtraBody" hidden>' + sectorRowsRest + '</div>' +
      '<div class="table-expand"><button type="button" id="sectorExpandBtn" data-count="' + sectors.length + '">Show all ' + sectors.length + ' &#9662;</button></div>'
    : '';

  const headCols = allMetricColKeys.map((k) => '<th class="num" data-col="' + k + '" data-type="num">' + colLabel(k) + '</th>').join('');

  const bodyRows = scored.map((c) => {
    const cells = allMetricColKeys.map((k) => {
      const sc = METRICS[k] ? c.metricScores[k] : (displayPercentiles[k] ? displayPercentiles[k][c.ticker] : null);
      return '<td class="num" data-col="' + k + '" data-value="' + (sc == null ? -1 : sc) + '" style="' + bandStyle(sc) + '">' + fmtCell(k, c[k]) + '</td>';
    }).join('');
    const opp = c.valueOpportunity, trap = c.valueTrapRisk;
    const cp = c.colorPercentiles;
    const starred = watchlistSet.has(c.ticker);

    const mainCoveragePct = Math.round((c.compositeCoverage ?? 1) * 100);
    const oppCoveragePct = Math.round((c.valueOpportunityCoverage ?? 1) * 100);
    const trapCoveragePct = Math.round((c.valueTrapRiskCoverage ?? 1) * 100);

    const scoreCoverageNote =
      mainCoveragePct < 100
        ? '<span class="coverage-note ' +
          (c.compositeEligible ? '' : 'coverage-warn') +
          '">' +
          (c.compositeEligible ? mainCoveragePct + '% coverage' : 'insufficient data · ' + mainCoveragePct + '%') +
          '</span>'
        : '';

    const oppCoverageNote =
      oppCoveragePct < 100
        ? '<span class="coverage-note ' +
          (c.valueOpportunityEligible ? '' : 'coverage-warn') +
          '">' +
          (c.valueOpportunityEligible ? oppCoveragePct + '% coverage' : 'insufficient data · ' + oppCoveragePct + '%') +
          '</span>'
        : '';

    const trapCoverageNote =
      trapCoveragePct < 100
        ? '<span class="coverage-note ' +
          (c.valueTrapRiskEligible ? '' : 'coverage-warn') +
          '">' +
          (c.valueTrapRiskEligible ? trapCoveragePct + '% coverage' : 'insufficient data · ' + trapCoveragePct + '%') +
          '</span>'
        : '';
    return '<tr class="data-row" data-classification="' + c.classification + '" data-ticker="' + c.ticker + '" data-watchlisted="' + starred + '">' +
      '<td data-col="star" class="star-cell"><button type="button" class="star-btn' + (starred ? ' starred' : '') + '" data-ticker="' + c.ticker + '" aria-label="Toggle watchlist for ' + c.ticker + '">' + (starred ? '★' : '☆') + '</button></td>' +
      '<td data-col="rank" data-value="' + c.rank + '" class="num rank">' + c.rank + '</td>' +
      '<td data-col="tier" data-value="' + 'FDCBA'.indexOf(c.tier) + '"><span class="tier" style="background:' + TIER_COLOR[c.tier] + '">' + c.tier + '</span></td>' +
      '<td data-col="ticker" data-value="' + c.ticker + '" class="ticker">' + c.ticker + '</td>' +
      '<td data-col="name" data-value="' + c.name + '" class="name">' + c.name + '</td>' +
      '<td data-col="sector" data-value="' + c.sector + '" class="sector">' + c.sector + '</td>' +
      '<td data-col="classification" data-value="' + c.classification + '" class="classification"><span class="class-badge" style="background:' + (CLASSIFICATION_COLOR[c.classification] || '#8b949e') + '26;color:' + (CLASSIFICATION_COLOR[c.classification] || '#8b949e') + '">' + c.classification + '</span></td>' +
      '<td data-col="score" data-value="' + (c.compositeEligible ? c.composite : -1) + '" class="num score" style="' + bandStyle(cp.score) + '">' +
        '<span class="score-main">' + c.composite.toFixed(1) + '</span>' +
        scoreCoverageNote +
      '</td>' +
      '<td class="num" data-col="valueOpp" data-value="' + (opp == null ? -1 : opp) + '" style="' + bandStyle(cp.valueOpp) + '">' +
        '<span class="score-main">' + (opp == null ? '—' : opp.toFixed(1)) + meterHTML(cp.valueOpp) + '</span>' +
        oppCoverageNote +
      '</td>' +
      '<td class="num" data-col="trapRisk" data-value="' + (trap == null ? -1 : trap) + '" style="' + bandStyle(cp.trapRisk) + '">' +
        '<span class="score-main">' + (trap == null ? '—' : trap.toFixed(1)) + meterHTML(cp.trapRisk) + '</span>' +
        trapCoverageNote +
      '</td>' +
      cells + '</tr>';
  }).join('');

  const guideCards = GUIDE.map((g) =>
    '<div class="g-card"><div class="g-name">' + g.name + '</div>' +
    '<div class="g-what">' + g.what + '</div><div class="g-bands">' +
    g.bands.map((pair) => '<div class="g-band"><span class="g-range">' + pair[0] + '</span><span class="g-mean">' + pair[1] + '</span></div>').join('') +
    '</div></div>').join('');

  const weightsNote = Object.keys(BUCKET_WEIGHTS).map((b) => BUCKET_LABELS[b] + ' ' + (BUCKET_WEIGHTS[b] * 100).toFixed(0) + '%').join('  ·  ');

  const classificationCounts = {};
  for (const c of scored) classificationCounts[c.classification] = (classificationCounts[c.classification] || 0) + 1;
  const classificationOptions = Object.keys(CLASSIFICATION).map((key) => CLASSIFICATION[key])
    .filter((label) => classificationCounts[label])
    .map((label) => '<option value="' + label + '">' + label + ' (' + classificationCounts[label] + ')</option>').join('');

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Stock Screener</title>' +
'<style>' +
// Direction B "Fintech Dashboard" palette - see screener-design-options.html
// (reference mockup only, never linked/published from the report itself).
':root{--bg:#0d1117;--bg2:#0b0f14;--panel:#161b22;--line:#21262d;--ink:#e6edf3;--muted:#8b949e;--accent:#10b981;--good:#34d399;--mid:#f0a868;--bad:#ff7b72}' +
'*{box-sizing:border-box}' +
'body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums}' +
'header{padding:30px 26px 14px;border-bottom:1px solid var(--line)}' +
'h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.01em}' +
'h1 span{color:var(--accent)}' +
'.sub{color:var(--muted);font-size:13px;margin-top:6px}' +
'.wrap{padding:28px 26px 70px}' +
'.grid{display:grid;grid-template-columns:1fr;gap:24px}' +
'@media(min-width:900px){.grid{grid-template-columns:300px 1fr}}' +
'.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px}' +
'.card h2{margin:0 0 16px;font-size:14px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:8px}' +
'.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}' +
'.dot.g{background:var(--good)}.dot.r{background:var(--bad)}' +
'.sector-row{display:grid;grid-template-columns:20px 1fr 90px 44px;align-items:center;gap:9px;padding:8px 0}' +
'.sector-rank{color:var(--muted);font-size:12px;text-align:center}' +
'.sector-name{font-size:13.5px}' +
'.sector-bar-wrap{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden}' +
'.sector-bar{display:block;height:100%;border-radius:3px}' +
'.sector-score{font-size:12.5px;text-align:right;color:var(--muted)}' +
'.table-card{overflow-x:auto;padding:0}' +
'table{border-collapse:separate;border-spacing:0;width:100%;font-size:14.5px;min-width:960px}' +
'thead th{position:sticky;top:0;background:var(--panel);color:var(--muted);text-align:left;font-weight:500;font-size:12px;padding:0 16px 14px;border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap;user-select:none}' +
'thead th:hover{color:var(--ink)}' +
'thead th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}' +
'tbody td{padding:15px 16px;border-top:1px solid var(--line);white-space:nowrap}' +
'tbody tr:hover td{background:var(--panel)}' +
'@media(max-width:640px){table{font-size:13px}thead th{padding:0 10px 10px}tbody td{padding:10px 10px}}' +
'.rank{color:var(--muted)}' +
'.ticker{font-weight:600}' +
'.name{color:var(--muted)}.sector{color:var(--muted);font-size:12px}' +
'.score{font-weight:700;font-size:14.5px}' +
'.score-main{display:block}' +
'.coverage-note{display:block;margin-top:2px;color:var(--muted);font-size:9.5px;font-weight:500;line-height:1.2;white-space:nowrap}' +
'.coverage-note.coverage-warn{color:var(--mid)}' +
'.tier{display:inline-block;min-width:22px;text-align:center;padding:2px 7px;border-radius:20px;color:#04110b;font-weight:800;font-size:12px}' +
'.meter{display:inline-block;height:5px;background:var(--line);border-radius:3px;overflow:hidden;margin-left:8px;width:50px;vertical-align:middle}' +
'.meter i{display:block;height:100%;border-radius:3px}' +
'.good{color:var(--good)}.mid{color:var(--mid)}.bad{color:var(--bad)}' +
'.dashboard{padding:34px 26px 6px}' +
'.dash-top{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px}' +
'.dash-top h2{margin:0;font-size:22px;letter-spacing:-.01em;font-weight:700;color:var(--ink)}' +
'.dash-timestamp{color:var(--muted);font-size:13px}' +
'.cards{display:grid;grid-template-columns:1fr;gap:16px;margin-top:22px}' +
'@media(min-width:680px){.cards{grid-template-columns:repeat(2,1fr)}}' +
'@media(min-width:1000px){.cards{grid-template-columns:repeat(4,1fr)}}' +
'.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px}' +
'.stat .k{color:var(--muted);font-size:12.5px;font-weight:500;margin-bottom:10px}' +
'.stat .v{font-size:28px;font-weight:700;letter-spacing:-.02em}' +
'.stat .v.em{color:var(--accent)}.stat .v.warn{color:var(--mid)}' +
'.stat .d{color:#6e7681;font-size:12px;margin-top:6px}' +
'.dashboard .changes-card{margin-top:18px}' +
'.dash-grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:16px}' +
'@media(min-width:680px){.dash-grid{grid-template-columns:1fr 1fr}}' +
'.dash-row{display:flex;align-items:center;gap:8px;padding:9px 0;border-top:1px solid var(--line);font-size:13px;flex-wrap:wrap}' +
'.dash-row:first-child{border-top:none}' +
'.dash-row-score{font-weight:700;min-width:38px}' +
'.dash-row-danger{color:var(--bad)}' +
'.dash-flag{font-size:10.5px;font-weight:700;color:var(--mid);background:rgba(240,168,104,.15);padding:2px 6px;border-radius:5px;letter-spacing:.02em}' +
'.dash-flag-new{color:var(--muted);background:rgba(139,148,158,.15)}' +
'.dash-flag-stale{color:var(--mid);background:rgba(240,168,104,.15)}' +
'.dash-ticker-link{background:none;border:none;color:var(--accent);font-weight:700;font-size:13px;cursor:pointer;padding:0;min-width:46px;text-align:left}' +
'.dash-ticker-link:hover{text-decoration:underline}' +
'.dash-sector-group{margin-bottom:10px}' +
'.dash-sector-group:last-child{margin-bottom:0}' +
'.dash-sector-group h4{margin:0 0 4px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700}' +
'.dash-sector-name{flex:1;font-size:12.5px}' +
'.changes-card{margin-top:16px}' +
'.changes-summary{margin:0 0 18px}' +
'.changes-grid{display:grid;grid-template-columns:1fr;gap:20px}' +
'@media(min-width:680px){.changes-grid{grid-template-columns:1fr 1fr}}' +
'@media(min-width:1000px){.changes-grid{grid-template-columns:1fr 1fr 1fr}}' +
'.changes-col h3{margin:0 0 8px;font-size:12px;letter-spacing:.03em;color:var(--muted);font-weight:600}' +
'.changes-expand{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}' +
'.changes-expand-btn{background:var(--bg2);color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:8px 18px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:system-ui,sans-serif;transition:color .15s,border-color .15s}' +
'.changes-expand-btn:hover{color:var(--accent);border-color:var(--accent)}' +
'.changes-expand-body{margin-top:16px}' +
'.changes-expand-body h3{margin:0 0 8px;font-size:12px;letter-spacing:.03em;color:var(--muted);font-weight:600}' +
'.move-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line);font-size:13px;flex-wrap:wrap}' +
'.move-row:first-child{border-top:none}' +
'.move-ticker{font-weight:700;min-width:44px}' +
'.move-delta{font-weight:700}' +
'.move-up{color:var(--good)}.move-down{color:var(--bad)}.move-flat{color:var(--muted)}' +
'.move-class{color:var(--muted);font-size:11.5px}' +
'.move-class.risk-flag{color:var(--mid);font-weight:600}' +
'.guide{margin-top:30px}' +
'.guide-grid{display:grid;grid-template-columns:1fr;gap:16px}' +
'@media(min-width:680px){.guide-grid{grid-template-columns:1fr 1fr}}' +
'@media(min-width:1100px){.guide-grid{grid-template-columns:1fr 1fr 1fr}}' +
'.g-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}' +
'.g-name{font-weight:700;color:var(--accent);font-size:14px;margin-bottom:5px}' +
'.g-what{color:var(--muted);font-size:12px;line-height:1.5;margin-bottom:11px}' +
'.g-band{display:grid;grid-template-columns:110px 1fr;gap:8px;padding:4px 0;border-top:1px solid var(--line);font-size:12.5px}' +
'.g-range{color:var(--ink)}' +
'.g-mean{color:var(--muted)}' +
'.hint{color:var(--muted);font-size:11.5px;margin:16px 0 0}' +
'.why2-wrap{margin-top:8px}' +
'.why2-summary{margin-bottom:10px;color:var(--muted);font-size:11.5px;line-height:1.55}' +
'.why2-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px}' +
'.why2-card{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:10px 11px}' +
'.why2-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:5px}' +
'.why2-name{font-size:11px;font-weight:700}' +
'.why2-score{font-size:13px;font-weight:700}' +
'.why2-meta{color:var(--muted);font-size:10.5px}' +
'.why2-change{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:12.5px}' +
'.why2-class-change{margin-top:4px;color:var(--muted);font-size:11.5px}' +

'.filter-row{display:flex;align-items:center;gap:16px;padding:16px 14px;flex-wrap:wrap}' +
'.filter-row label{color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}' +
'.filter-row select{background:var(--bg2);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12.5px;font-family:system-ui,sans-serif}' +
'.col-picker{position:relative;margin-left:auto}' +
'.col-picker-btn{background:var(--bg2);color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:6px 11px;font-size:12px;font-family:system-ui,sans-serif;cursor:pointer}' +
'.col-picker-btn:hover{color:var(--ink)}' +
'.col-picker-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:20;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;width:270px;max-height:60vh;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.4)}' +
'.col-picker-presets{display:flex;gap:8px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line)}' +
'.col-picker-presets button{flex:1;background:var(--bg2);color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:6px 10px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:system-ui,sans-serif;transition:color .15s,border-color .15s}' +
'.col-picker-presets button:hover{color:var(--accent);border-color:var(--accent)}' +
'.col-picker-list label{display:flex;align-items:center;gap:8px;padding:5px 2px;font-size:12.5px;color:var(--ink);cursor:pointer}' +
'.col-picker-list input{accent-color:var(--accent)}' +
'.class-badge,.pill{display:inline-block;padding:4px 11px;border-radius:20px;font-size:11.5px;font-weight:600;letter-spacing:.02em;white-space:nowrap}' +
'.view-tabs{display:flex;gap:6px}' +
'.view-tab{background:var(--bg2);color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:6px 11px;font-size:12px;font-family:system-ui,sans-serif;cursor:pointer}' +
'.view-tab:hover{color:var(--ink)}' +
'.view-tab.active{color:#04110b;background:var(--accent);border-color:var(--accent);font-weight:700}' +
'.page-tabs{display:flex;gap:8px;padding:14px 26px 0}' +
'.page-tab{background:transparent;color:var(--muted);border:1px solid var(--line);border-bottom:none;border-radius:10px 10px 0 0;padding:9px 16px;font-size:13.5px;font-weight:600;font-family:system-ui,sans-serif;cursor:pointer}' +
'.page-tab:hover{color:var(--ink)}' +
'.page-tab.active{color:var(--ink);background:var(--panel)}' +
'.page-view[hidden]{display:none}' +
'.lb-row{display:grid;grid-template-columns:20px 1fr auto;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);cursor:pointer;transition:background .12s}' +
'.lb-row:first-child{border-top:none}' +
'.lb-row:hover{background:rgba(255,255,255,.03)}' +
'.lb-row.open{background:rgba(16,185,129,.06)}' +
'.lb-rank{color:var(--muted);font-size:12px;text-align:center}' +
'.lb-name{font-size:13.5px;color:var(--ink)}' +
'.lb-sub{display:block;color:var(--muted);font-size:11px;margin-top:2px}' +
'.lb-count{font-size:12.5px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}' +
'.lb-count b{color:var(--ink);font-weight:700}' +
'.lb-arrow{display:inline-block;margin-left:6px;color:var(--muted);font-size:9px}' +
'.lb-arrow::after{content:"\\25BE"}' +
'.lb-row.open .lb-arrow{color:var(--accent)}' +
'.lb-row.open .lb-arrow::after{content:"\\25B4"}' +
'.lb-explain{display:none;margin-top:14px;background:#0f141b;border-top:2px solid var(--accent);border-radius:10px;padding:16px 18px}' +
'.lb-explain.show{display:block}' +
'.lb-explain .exp-title{font-size:13.5px;font-weight:700;color:var(--accent);margin-bottom:6px}' +
'.star-cell{text-align:center!important;width:34px;cursor:default!important}' +
'.star-btn{background:none;border:none;color:#3a4148;font-size:17px;cursor:pointer;line-height:1;padding:2px}' +
'.star-btn:hover{color:#f0a868}' +
'.star-btn.starred{color:#f0a868}' +
'.table-expand{padding:14px 16px;border-top:1px solid var(--line);text-align:center}' +
'.table-expand button{background:var(--bg2);color:var(--muted);border:1px solid var(--line);border-radius:20px;padding:8px 18px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:system-ui,sans-serif;transition:color .15s,border-color .15s}' +
'.table-expand button:hover{color:var(--accent);border-color:var(--accent)}' +
'.data-row{cursor:pointer}' +
'.ticker::before{content:"\\25B8\\a0";color:var(--muted);font-size:10px}' +
'.data-row.expanded td{background:rgba(16,185,129,.06)}' +
'.data-row.expanded .ticker::before{content:"\\25BE\\a0"}' +
'.detail-row td{padding:0;cursor:default}' +
'.detail-row{background:var(--bg2)}' +
'.detail-wrap{position:sticky;left:0;width:min(94vw,900px);padding:22px 26px 26px;opacity:0;transform:translateY(-6px);transition:opacity .22s ease,transform .22s ease;white-space:normal}' +
'.detail-row.open .detail-wrap{opacity:1;transform:translateY(0)}' +
'.detail-section h4{margin:0 0 10px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}' +
'.detail-price-section{margin-bottom:18px}' +
'.detail-price{font-size:21px;font-weight:700;margin-bottom:10px}' +
'.cache-note{font-size:11px;font-weight:400;color:var(--muted)}' +
'.tv-widget-container{min-height:260px}' +
'.detail-allmetrics-section{margin-bottom:22px;padding-bottom:20px;border-bottom:1px solid var(--line)}' +
'.all-metrics-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:0 20px}' +
'.am-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:13px;cursor:pointer;transition:background .12s}' +
'.am-row:hover{background:rgba(255,255,255,.03)}' +
'.am-row.open{background:rgba(16,185,129,.06)}' +
'.am-label{color:var(--muted);display:flex;align-items:center;gap:6px}' +
'.am-label::after{content:"\\25BE";color:var(--muted);font-size:9px}' +
'.am-row.open .am-label::after{content:"\\25B4";color:var(--accent)}' +
'.am-value{font-weight:600;color:var(--ink);white-space:nowrap}' +
'.am-explain{display:none;margin-top:16px;background:#0f141b;border-top:2px solid var(--accent);border-radius:10px;padding:20px 22px}' +
'.am-explain.show{display:block}' +
'.am-explain .exp-title{font-size:14px;font-weight:700;color:var(--accent);margin-bottom:8px}' +
'.am-explain p{font-size:13px;line-height:1.6;color:#c9d4e3;margin:0 0 8px}' +
'.am-explain p:last-of-type{margin-bottom:0}' +
'.exp-row2{display:grid;grid-template-columns:1fr;gap:14px;margin-top:10px}' +
'@media(min-width:520px){.exp-row2{grid-template-columns:1fr 1fr}}' +
'.exp-mini{font-size:12px}' +
'.exp-lbl{color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-size:10.5px;margin-bottom:3px}' +
'.exp-txt{color:#c9d4e3;line-height:1.5}' +
'.am-disc{margin-top:14px;padding:12px 14px;background:var(--bg2);border:1px solid var(--line);border-radius:8px;font-size:11.5px;color:#6e7681;line-height:1.5}' +
'.detail-grid{display:grid;grid-template-columns:1fr;gap:22px}' +
'@media(min-width:820px){.detail-grid{grid-template-columns:1fr 1fr}}' +
'.news-list{list-style:none;margin:0;padding:0;max-height:280px;overflow-y:auto}' +
'.news-list li{padding:8px 0;border-bottom:1px solid var(--line)}' +
'.news-list a{color:var(--ink);text-decoration:none;font-size:13px;line-height:1.4}' +
'.news-list a:hover{color:var(--accent);text-decoration:underline}' +
'.news-meta{display:block;color:var(--muted);font-size:11px;margin-top:3px}' +
'.pt-list{list-style:none;margin:0;padding:0;max-height:280px;overflow-y:auto}' +
'.pt-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12.5px}' +
'.pt-type{font-weight:600;padding:2px 8px;border-radius:10px;font-size:11px;background:var(--bg2);color:var(--muted)}' +
'.pt-type.pt-buy{background:rgba(52,211,153,0.16);color:var(--good)}' +
'.pt-type.pt-sell{background:rgba(255,123,114,0.16);color:var(--bad)}' +
'.pt-member{color:var(--ink);font-weight:500}' +
'.pt-chamber,.pt-amount{color:var(--muted)}' +
'.pt-date{color:var(--muted);margin-left:auto}' +
'.pt-link{color:var(--accent);text-decoration:none;font-size:11px}' +
'.pt-link:hover{text-decoration:underline}' +
'.stat-label{display:block;font-size:12px;color:var(--muted);margin-bottom:8px}' +
'.stat-select{margin-left:6px;background:var(--bg2);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:4px 7px;font-size:12.5px}' +
'.stat-chart-container{margin-top:10px}' +
'.stat-readout{display:flex;gap:16px;font-size:12px;margin-top:8px;flex-wrap:wrap}' +
'.detail-research-section{margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}' +
'.research-empty{color:var(--muted);font-size:12.5px;padding:2px 0}' +
'.research-freshness{font-size:11.5px;font-weight:600;padding:6px 10px;border-radius:8px;margin-bottom:12px}' +
'.research-freshness.rf-new{background:rgba(139,148,158,.15);color:var(--muted)}' +
'.research-freshness.rf-stale{background:rgba(240,168,104,.15);color:var(--mid)}' +
'.research-verdict{display:inline-flex;gap:14px;align-items:center;flex-wrap:wrap;border:1px solid;border-radius:10px;padding:8px 14px;font-weight:700;font-size:13.5px;margin-bottom:10px}' +
'.research-verdict-label{text-transform:capitalize}' +
'.research-confidence{font-size:11px;font-weight:600;opacity:.85;text-transform:uppercase;letter-spacing:.03em}' +
'.research-verdict-reasoning{color:var(--ink);font-size:13px;line-height:1.55;margin:2px 0 10px}' +
'.research-timestamp{color:var(--muted);font-size:11px;margin:0 0 16px}' +
'.research-question{margin-bottom:16px}' +
'.research-question h5{margin:0 0 6px;font-size:12px;letter-spacing:.03em;color:var(--ink);display:flex;align-items:center;gap:8px;font-weight:700}' +
'.research-direction{font-size:10px;font-weight:700;text-transform:uppercase;color:var(--accent);background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);padding:2px 7px;border-radius:5px;letter-spacing:.03em}' +
'.research-question p{margin:0 0 6px;font-size:13px;line-height:1.55;color:var(--ink)}' +
'.research-list{margin:0 0 6px;padding-left:18px;font-size:13px;line-height:1.55;color:var(--ink)}' +
'.research-list li{margin-bottom:8px}' +
'.src-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}' +
'.src-chip{font-size:10.5px;color:var(--accent);background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);border-radius:5px;padding:2px 7px;text-decoration:none;white-space:nowrap}' +
'.src-chip:hover{background:rgba(16,185,129,.2)}' +
'.src-chip-nolink{color:var(--muted);background:var(--bg2);border-color:var(--line);cursor:default}' +
'.research-sources{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}' +
'.research-sources h5{margin:0 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}' +
'.research-sources ol{margin:0;padding-left:18px;font-size:12px;line-height:1.6}' +
'.research-sources li{margin-bottom:7px}' +
'.research-sources a{color:var(--accent);text-decoration:none;font-weight:600}' +
'.research-sources a:hover{text-decoration:underline}' +
'.src-nolink{color:var(--muted);font-weight:600}' +
'.src-desc{display:block;color:var(--muted);font-size:11.5px;margin-top:2px;font-weight:400}' +
'.research-sourcing-note{font-size:11px;color:var(--muted);font-style:italic;margin-top:12px;line-height:1.5}' +
'.research-caveat{font-size:10.5px;color:var(--muted);margin-top:14px;padding-top:10px;border-top:1px solid var(--line)}' +
'</style></head><body>' +
'<header><h1>Stock <span>Screener</span></h1>' +
'<div class="sub">' + scored.length + ' names ranked &middot; weights: ' + weightsNote + ' &middot; ' + generated + '</div></header>' +
'<div class="page-tabs">' +
'<button type="button" class="page-tab active" data-page="screener">Screener</button>' +
'<button type="button" class="page-tab" data-page="political">Political Trades</button>' +
'</div>' +
'<div id="pageScreener" class="page-view">' +
dashboardHTML +
'<div class="wrap"><div class="grid">' +
'<div class="card"><h2>Industries &middot; best to worst</h2>' + sectorRowsTop + sectorExpandHTML + '<p class="hint">Avg score of each sector\'s names.</p></div>' +
'<div class="card table-card">' +
'<input id="stockSearch" type="text" placeholder="Search ticker or company..." style="display:block;width:min(520px,100%);height:46px;padding:0 16px;margin:0 0 16px 0;background:#0b0f14;color:#e6edf3;border:1px solid #21262d;border-radius:10px;font-size:15px;font-weight:600;font-family:system-ui,sans-serif;outline:none;box-sizing:border-box;box-shadow:0 0 0 1px rgba(255,255,255,.02);">' +
'<div class="filter-row">' +
'<div class="view-tabs"><button type="button" class="view-tab active" data-view="all">All (' + scored.length + ')</button>' +
'<button type="button" class="view-tab" data-view="watchlist">&#9733; Watchlist (<span id="wlCount">' + watchlistSet.size + '</span>)</button></div>' +
'<label for="classFilter">Classification</label>' +
'<select id="classFilter"><option value="">All (' + scored.length + ')</option>' + classificationOptions + '</select>' +
'<div class="col-picker" id="colPicker">' +
'<button type="button" class="col-picker-btn" id="colPickerBtn">Columns &#9662;</button>' +
'<div class="col-picker-panel" id="colPickerPanel" hidden>' +
'<div class="col-picker-presets"><button type="button" id="colPresetAll">Show All</button><button type="button" id="colPresetKey">Key Only</button></div>' +
'<div class="col-picker-list">' + colPickerCheckboxes + '</div>' +
'</div></div>' +
'</div>' +
'<table id="t"><thead><tr>' +
'<th data-col="star" class="star-cell">&#9733;</th>' +
'<th data-col="rank" data-type="num">#</th>' +
'<th data-col="tier" data-type="num">Tier</th>' +
'<th data-col="ticker" data-type="str">Ticker</th>' +
'<th data-col="name" data-type="str">Name</th>' +
'<th data-col="sector" data-type="str">Sector</th>' +
'<th data-col="classification" data-type="str">Classification</th>' +
'<th class="num" data-col="score" data-type="num">Score</th>' +
'<th class="num" data-col="valueOpp" data-type="num">Value Opp</th>' +
'<th class="num" data-col="trapRisk" data-type="num">Trap Risk</th>' + headCols +
'</tr></thead><tbody>' + bodyRows + '</tbody></table>' +
'<div class="table-expand"><button type="button" id="tableExpandBtn">Show all ' + scored.length + ' &#9662;</button></div>' +
'</div></div>' +
'<div class="card guide"><h2>How to read these numbers</h2>' +
'<div class="guide-grid">' + guideCards + '</div>' +
'<p class="hint">Rough rules of thumb - always compare within a sector. Cell shading = that stat\'s curved score (teal good, red weak). A research screen, not investment advice.</p></div>' +
'</div>' +
'</div>' +

'<div id="pagePolitical" class="page-view" hidden><div class="wrap">' +
'<div class="card"><h2>Congressional Trading Activity</h2>' +
'<p class="hint">Stock trades disclosed by members of Congress under the STOCK Act, tracked from official House/Senate filings via Financial Modeling Prep. Amounts are disclosed dollar ranges, not exact figures, and members can file well after the actual trade date. Informational only — not a signal, recommendation, or indication any stock here is being screened favorably.</p>' +
'</div>' +
'<div class="dash-grid">' +
'<div class="card"><h2>Most Traded Tickers</h2><div id="tickerLeaderboard"></div><div class="lb-explain" id="tickerLbExplain"></div></div>' +
'<div class="card"><h2>Most Active Members</h2><div id="memberLeaderboard"></div><div class="lb-explain" id="memberLbExplain"></div></div>' +
'</div>' +
'<div class="card table-card">' +
'<input id="ptSearch" type="text" placeholder="Search ticker, company, or member..." style="display:block;width:min(520px,100%);height:46px;padding:0 16px;margin:0 0 16px 0;background:#0b0f14;color:#e6edf3;border:1px solid #21262d;border-radius:10px;font-size:15px;font-weight:600;font-family:system-ui,sans-serif;outline:none;box-sizing:border-box;box-shadow:0 0 0 1px rgba(255,255,255,.02);">' +
'<table id="ptTable"><thead><tr>' +
'<th data-col="date" data-type="num">Date</th>' +
'<th data-col="member" data-type="str">Member</th>' +
'<th data-col="chamber" data-type="str">Chamber</th>' +
'<th data-col="ticker" data-type="str">Ticker</th>' +
'<th data-col="type" data-type="str">Type</th>' +
'<th class="num" data-col="amount" data-type="num">Amount</th>' +
'<th data-col="link">Filing</th>' +
'</tr></thead><tbody id="ptTbody"></tbody></table>' +
'<div class="table-expand"><button type="button" id="ptExpandBtn">Show all &#9662;</button></div>' +
'<p class="hint" id="ptEmpty" hidden>No congressional trades tracked yet.</p>' +
'</div>' +
'</div></div>' +

'<script>' +
'var table=document.getElementById("t");var lastCol=null,asc=false;' +
'var stockSearch=document.getElementById("stockSearch");' +
// Collapsible table: default view shows only the first COLLAPSE_ROWS rows in
// whatever the CURRENT DOM order is (so it always tracks the active sort,
// not the original rank). Search/classification/watchlist filters bypass
// the cap entirely and show every match regardless of position - see
// applyFilters() below, the single place that reconciles all of this.
'var COLLAPSE_ROWS=25;var tableExpanded=false;' +
'var tableExpandBtn=document.getElementById("tableExpandBtn");' +
'function dataRows(){return [].slice.call(table.tBodies[0].querySelectorAll(".data-row"));}' +
// Expanded panels are removed (not just hidden) whenever the row order or
// row visibility changes, since they're not part of the sort/filter model -
// simplest way to avoid a detail row ending up detached from its ticker.
'function collapseAllDetails(){' +
'[].slice.call(table.tBodies[0].querySelectorAll(".detail-row")).forEach(function(r){r.remove();});' +
'dataRows().forEach(function(r){r.classList.remove("expanded");});}' +

// Star column has no data-type, so it is naturally excluded from click-to-sort.
'table.querySelectorAll("th[data-type]").forEach(function(th){th.addEventListener("click",function(){' +
'collapseAllDetails();' +
'var col=th.dataset.col,type=th.dataset.type;asc=(lastCol===col)?!asc:false;lastCol=col;' +
'var rows=dataRows();' +
'rows.sort(function(a,b){var av=a.querySelector("[data-col=\\""+col+"\\"]").dataset.value;var bv=b.querySelector("[data-col=\\""+col+"\\"]").dataset.value;' +
'var cmp=(type==="num")?(parseFloat(av)-parseFloat(bv)):String(av).localeCompare(bv);return asc?cmp:-cmp;});' +
'rows.forEach(function(r){table.tBodies[0].appendChild(r);});' +
'applyFilters();});});' +

// Watchlist: seeded from watchlist.json (embedded at generation time), but
// once you've starred anything in this browser, localStorage takes over on
// reload - see the note above the Copy button for how to make it permanent.
'var STORAGE_KEY="screenerWatchlist";' +
'var serverWatchlist=' + JSON.stringify(Array.from(watchlistSet)) + ';' +
'var stored=localStorage.getItem(STORAGE_KEY);' +
'var watchlist=new Set(stored!==null?JSON.parse(stored):serverWatchlist);' +
'function saveWatchlist(){localStorage.setItem(STORAGE_KEY,JSON.stringify(Array.from(watchlist)));}' +
'function syncStars(){' +
'dataRows().forEach(function(r){' +
'var on=watchlist.has(r.dataset.ticker);r.dataset.watchlisted=on;' +
'var btn=r.querySelector(".star-btn");if(btn){btn.textContent=on?"\\u2605":"\\u2606";btn.classList.toggle("starred",on);}});' +
'document.getElementById("wlCount").textContent=watchlist.size;}' +

'var currentView="all";' +
'var classFilter=document.getElementById("classFilter");' +
// Single source of truth for row visibility: search, classification filter,
// watchlist view, AND the collapse cap all reconcile here. A row hides if
// it fails any active filter/search; among rows that pass, only the first
// COLLAPSE_ROWS (in current DOM/sort order) show UNLESS a filter/search is
// active or the table has been manually expanded - so searching or
// filtering always reaches the full 503, never just the visible top slice.
'function applyFilters(){' +
'collapseAllDetails();' +
'var q=stockSearch?stockSearch.value.trim().toLowerCase():"";' +
'var hasQuery=q.length>0;' +
'var clsVal=classFilter.value;' +
'var filterActive=hasQuery||!!clsVal||currentView==="watchlist";' +
'var matchCount=0;' +
'dataRows().forEach(function(r,idx){' +
'var searchOk=!hasQuery||r.innerText.toLowerCase().includes(q);' +
'var clsOk=!clsVal||r.dataset.classification===clsVal;' +
'var wlOk=currentView!=="watchlist"||watchlist.has(r.dataset.ticker);' +
'if(!(searchOk&&clsOk&&wlOk)){r.style.display="none";return;}' +
'matchCount++;' +
'r.style.display=(filterActive||tableExpanded||idx<COLLAPSE_ROWS)?"":"none";});' +
'if(tableExpandBtn){' +
'tableExpandBtn.style.display=(!filterActive&&matchCount>COLLAPSE_ROWS)?"":"none";' +
'tableExpandBtn.innerHTML=tableExpanded?"Show top "+COLLAPSE_ROWS+" &#9652;":"Show all "+matchCount+" &#9662;";}}' +
'if(stockSearch)stockSearch.addEventListener("input",applyFilters);' +
'classFilter.addEventListener("change",applyFilters);' +
'if(tableExpandBtn)tableExpandBtn.addEventListener("click",function(){tableExpanded=!tableExpanded;applyFilters();});' +

// "What Changed" classification list: a simple static show/hide, unrelated
// to the table's search/sort/collapse model above - no row filtering here,
// just one block toggling visibility.
'var changesExpandBtn=document.getElementById("changesExpandBtn");' +
'if(changesExpandBtn){changesExpandBtn.addEventListener("click",function(){' +
'var body=document.getElementById("changesExpandBody");' +
'var willOpen=body.hasAttribute("hidden");' +
'if(willOpen){body.removeAttribute("hidden");changesExpandBtn.innerHTML="Hide &#9652;";}' +
'else{body.setAttribute("hidden","");changesExpandBtn.innerHTML="Show "+changesExpandBtn.dataset.count+" change"+(changesExpandBtn.dataset.count==="1"?"":"s")+" &#9662;";}' +
'});}' +

// Industries sidebar: same collapse pattern as the main table (top
// SECTOR_COLLAPSE_ROWS by default, rest behind "Show all"), wording matches
// the table's button exactly for consistency. No search/sort to compose
// with here, so it's a plain show/hide toggle like the changes expander.
'var sectorExpandBtn=document.getElementById("sectorExpandBtn");' +
'if(sectorExpandBtn){sectorExpandBtn.addEventListener("click",function(){' +
'var body=document.getElementById("sectorExtraBody");' +
'var willOpen=body.hasAttribute("hidden");' +
'if(willOpen){body.removeAttribute("hidden");sectorExpandBtn.innerHTML="Show top 25 &#9652;";}' +
'else{body.setAttribute("hidden","");sectorExpandBtn.innerHTML="Show all "+sectorExpandBtn.dataset.count+" &#9662;";}' +
'});}' +

// Column visibility toggle: one dynamically-updated <style> tag is the
// entire mechanism - hiding a column is a single CSS rule matching every
// th/td with that data-col, so toggling never touches the 503 rows
// individually (fast) and composes cleanly with row-level collapse/search
// (independent mechanisms - display:none on a <tr> vs. on specific <td>s
// within it are unrelated CSS rules). Never persisted (no localStorage) -
// resets to the default preset (Show All, for now) on every load.
'var TOGGLE_COLS=' + JSON.stringify(TOGGLEABLE_COLUMN_KEYS) + ';' +
'var KEY_ONLY_COLS=' + JSON.stringify(KEY_ONLY_PRESET) + ';' +
'var colStyleEl=document.createElement("style");document.head.appendChild(colStyleEl);' +
'function updateColumnCSS(hiddenKeys){' +
'var sel=hiddenKeys.map(function(k){return \'th[data-col="\'+k+\'"],td[data-col="\'+k+\'"]\';}).join(",");' +
'colStyleEl.textContent=hiddenKeys.length?sel+"{display:none}":"";}' +
'function setColumnPreset(visibleKeys){' +
'document.querySelectorAll(".col-picker-list input[type=checkbox]").forEach(function(cb){' +
'cb.checked=visibleKeys.indexOf(cb.dataset.colToggle)>=0;});' +
'updateColumnCSS(TOGGLE_COLS.filter(function(k){return visibleKeys.indexOf(k)<0;}));}' +
'setColumnPreset(TOGGLE_COLS.slice());' + // default: Show All
'var colPresetAll=document.getElementById("colPresetAll");if(colPresetAll)colPresetAll.addEventListener("click",function(){setColumnPreset(TOGGLE_COLS.slice());});' +
'var colPresetKey=document.getElementById("colPresetKey");if(colPresetKey)colPresetKey.addEventListener("click",function(){setColumnPreset(KEY_ONLY_COLS.slice());});' +
'document.querySelectorAll(".col-picker-list input[type=checkbox]").forEach(function(cb){' +
'cb.addEventListener("change",function(){' +
'var checked=Array.from(document.querySelectorAll(".col-picker-list input[type=checkbox]:checked")).map(function(c){return c.dataset.colToggle;});' +
'updateColumnCSS(TOGGLE_COLS.filter(function(k){return checked.indexOf(k)<0;}));});});' +
'var colPickerBtn=document.getElementById("colPickerBtn");' +
'var colPickerPanel=document.getElementById("colPickerPanel");' +
'if(colPickerBtn&&colPickerPanel){' +
'colPickerBtn.addEventListener("click",function(e){e.stopPropagation();colPickerPanel.hidden=!colPickerPanel.hidden;});' +
'document.addEventListener("click",function(e){' +
'if(!colPickerPanel.hidden&&!document.getElementById("colPicker").contains(e.target))colPickerPanel.hidden=true;});}' +

'document.querySelectorAll(".view-tab").forEach(function(btn){btn.addEventListener("click",function(){' +
'document.querySelectorAll(".view-tab").forEach(function(b){b.classList.remove("active");});' +
'btn.classList.add("active");currentView=btn.dataset.view;applyFilters();});});' +

'table.tBodies[0].addEventListener("click",function(e){' +
'var btn=e.target.closest(".star-btn");if(!btn)return;' +
'var t=btn.dataset.ticker;' +
'if(watchlist.has(t))watchlist.delete(t);else watchlist.add(t);' +
'saveWatchlist();syncStars();applyFilters();});' +

'syncStars();' +
'applyFilters();' +

/* ---- Phase 9: per-stock detail panel ----
 * Lazy: a row's detail <tr> is only created on its first click. The
 * TradingView <script> tag - the thing that actually triggers network/
 * websocket activity - is only created and appended inside that same
 * first-click handler, so unopened rows cost nothing beyond the small
 * pre-embedded data payload below (price/news/metric numbers - no DOM, no
 * network). Toggling an already-built panel just flips a CSS class. */
'var STOCK_DETAIL=' + safeJSONEmbed(stockDetails) + ';' +
'var METRIC_DIST=' + safeJSONEmbed(metricDistributions) + ';' +
'var STAT_METRICS=' + safeJSONEmbed(STAT_METRICS) + ';' +
'var METRIC_EXPLANATIONS=' + safeJSONEmbed(METRIC_EXPLANATIONS) + ';' +
'var DETAIL_BAND_COLOR=' + JSON.stringify(BAND_COLOR) + ';' +
'var POLITICAL_TRADES=' + safeJSONEmbed(politicalTrades) + ';' +
'var POLITICAL_TRADES_ASOF=' + JSON.stringify(politicalTradesAsOf) + ';' +
'function detailBandFor(pct){if(pct===null||pct===undefined)return null;if(pct>=200/3)return"good";if(pct>=100/3)return"mid";return"bad";}' +

'function escapeHtml(s){return String(s).replace(/[&<>"\']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}' +
'function safeUrl(u){try{var p=new URL(u);return (p.protocol==="http:"||p.protocol==="https:")?p.href:"#";}catch(e){return "#";}}' +
'function fmtDate(iso){if(!iso)return null;try{return new Date(iso).toLocaleString();}catch(e){return iso;}}' +

'function buildPriceHTML(ticker){' +
'var d=STOCK_DETAIL[ticker];' +
'var priceHtml=(d.price!=null)?("$"+d.price.toFixed(2)+" <span class=\\"cache-note\\">(cached"+(d.priceAsOf?(" \\u2014 from the "+fmtDate(d.priceAsOf)+" data run"):"")+")</span>")' +
':"<span class=\\"hint\\">No cached price available for this ticker yet.</span>";' +
'return "<div class=\\"detail-price\\">"+priceHtml+"</div><div class=\\"tv-widget-container\\"></div>";}' +

'function buildNewsHTML(ticker){' +
'var d=STOCK_DETAIL[ticker];' +
'if(!d.headlines||!d.headlines.length)return "<p class=\\"hint\\">No recent headlines cached for this ticker.</p>";' +
'var asOf=d.newsAsOf?("<p class=\\"hint\\">Cached as of "+fmtDate(d.newsAsOf)+"</p>"):"";' +
'var items=d.headlines.map(function(h){' +
'return "<li><a href=\\""+safeUrl(h.url)+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\">"+escapeHtml(h.title)+"</a>"+' +
'"<span class=\\"news-meta\\">"+escapeHtml(h.source||"")+(h.date?(" \\u00b7 "+escapeHtml(h.date)):"")+"</span></li>";' +
'}).join("");' +
'return "<ul class=\\"news-list\\">"+items+"</ul>"+asOf;}' +

'function buildPoliticalTradesHTML(ticker){' +
'var trades=POLITICAL_TRADES.filter(function(t){return t.ticker===ticker;});' +
'if(!trades.length)return "<p class=\\"hint\\">No congressional stock trades disclosed for this ticker in the tracked window.</p>";' +
'var asOf=POLITICAL_TRADES_ASOF?("<p class=\\"hint\\">Cached as of "+fmtDate(POLITICAL_TRADES_ASOF)+"</p>"):"";' +
'var items=trades.map(function(t){' +
'var typeClass=/purchase/i.test(t.type||"")?"pt-buy":/sale/i.test(t.type||"")?"pt-sell":"";' +
'var linkHtml=t.link?(" <a href=\\""+safeUrl(t.link)+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" class=\\"pt-link\\">filing</a>"):"";' +
'return "<li class=\\"pt-row\\">"+' +
'"<span class=\\"pt-type "+typeClass+"\\">"+escapeHtml(t.type||"\\u2014")+"</span>"+' +
'"<span class=\\"pt-member\\">"+escapeHtml(t.member||"")+"</span>"+' +
'"<span class=\\"pt-chamber\\">"+escapeHtml(t.chamber||"")+"</span>"+' +
'"<span class=\\"pt-amount\\">"+escapeHtml(t.amount||"")+"</span>"+' +
'"<span class=\\"pt-date\\">"+escapeHtml(t.transactionDate||"")+"</span>"+linkHtml+' +
'"</li>";' +
'}).join("");' +
'return "<ul class=\\"pt-list\\">"+items+"</ul>"+asOf+' +
'"<p class=\\"am-disc\\">Sourced from official House/Senate STOCK Act disclosures via Financial Modeling Prep. Amounts shown are the disclosed dollar ranges, not exact figures, and members can file well after the actual trade date. Informational only \\u2014 not a signal, recommendation, or indication this stock is being screened favorably.</p>";}' +

'function buildStatChartHTML(){' +
'var options=Object.keys(STAT_METRICS).map(function(id){return "<option value=\\""+id+"\\">"+STAT_METRICS[id].label+"</option>";}).join("");' +
'return "<label class=\\"stat-label\\">Compare against the whole universe: <select class=\\"stat-select\\">"+options+"</select></label>"+' +
'"<div class=\\"stat-chart-container\\"></div>";}' +

// Every STAT_METRICS field for this one stock, at a glance - display-only,
// reads the same STOCK_DETAIL[ticker].metrics/STAT_METRICS data the
// percentile chart above already uses (built server-side in
// buildStockDetails(), unchanged by this). Reuses fmtStatValue() so the
// numbers read identically to the "This stock: X" readout elsewhere.
'function buildAllMetricsHTML(ticker){' +
'var d=STOCK_DETAIL[ticker];' +
'var rows=Object.keys(STAT_METRICS).map(function(id){' +
'return "<div class=\\"am-row\\" data-m=\\""+id+"\\"><span class=\\"am-label\\">"+STAT_METRICS[id].label+"</span><span class=\\"am-value\\">"+fmtStatValue(id,d.metrics[id])+"</span></div>";' +
'}).join("");' +
'return "<div class=\\"all-metrics-grid\\">"+rows+"</div>"+' +
'"<div class=\\"am-explain\\" id=\\"amExplain\\"></div>"+' +
'"<p class=\\"am-disc\\">Click a metric for what it means and how to read it - these explanations do not tell you whether any stock is a buy or sell. A research aid, not financial advice.</p>";}' +

// Renders one metric's explanation (name/what/read/typical range/why it
// matters) into the shared .am-explain panel below the All Metrics grid -
// pure lookup into METRIC_EXPLANATIONS, no computation, nothing tied to
// this specific stock's value.
'function metricExplainHTML(id){' +
'var e=METRIC_EXPLANATIONS[id];' +
'if(!e)return "";' +
'return "<div class=\\"exp-title\\">"+escapeHtml(e.name)+"</div>"+' +
'"<p>"+escapeHtml(e.what)+"</p>"+' +
'"<p>"+escapeHtml(e.read)+"</p>"+' +
'"<div class=\\"exp-row2\\">"+' +
'"<div class=\\"exp-mini\\"><div class=\\"exp-lbl\\">Typical range</div><div class=\\"exp-txt\\">"+escapeHtml(e.range)+"</div></div>"+' +
'"<div class=\\"exp-mini\\"><div class=\\"exp-lbl\\">Why it matters</div><div class=\\"exp-txt\\">"+escapeHtml(e.why)+"</div></div>"+' +
'"</div>";}' +

// Phase 6 display layer: renders the embedded research note (if any) into
// the panel's "Research & Analyst Reasoning" section. Pure read of
// STOCK_DETAIL[ticker].research, which is either the full parsed
// research/<TICKER>.json object or null - built server-side in
// buildStockDetails(), never fetched live. Every answer is rendered as-is,
// including any "not determinable from available sources" text - no
// filtering or rewriting of what research.js/the research files said.
'function prettyLabel(s){' +
'if(!s)return "\\u2014";' +
'return String(s).replace(/_/g," ").replace(/\\b\\w/g,function(c){return c.toUpperCase();});}' +

'function renderSourceChips(refs,sources){' +
'if(!refs||!refs.length||!sources)return "";' +
'var chips=refs.map(function(id){' +
'var s=sources.filter(function(x){return x.id===id;})[0];' +
'if(!s)return "";' +
'var label=escapeHtml(s.type)+(s.date?(" \\u00b7 "+escapeHtml(s.date)):"");' +
'if(s.url)return "<a class=\\"src-chip\\" href=\\""+safeUrl(s.url)+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\">"+label+"</a>";' +
'return "<span class=\\"src-chip src-chip-nolink\\">"+label+"</span>";' +
'}).join("");' +
'return "<div class=\\"src-chips\\">"+chips+"</div>";}' +

'function researchQuestionBlock(label,q,sources,showDirection){' +
'if(!q||!q.answer)return "";' +
'var dir=(showDirection&&q.direction)?("<span class=\\"research-direction\\">"+escapeHtml(prettyLabel(q.direction))+"</span>"):"";' +
'return "<div class=\\"research-question\\"><h5>"+escapeHtml(label)+dir+"</h5>"+' +
'"<p>"+escapeHtml(q.answer)+"</p>"+' +
'renderSourceChips(q.sourceRefs,sources)+"</div>";}' +

'function researchListBlock(label,items,sources){' +
'if(!items||!items.length)return "";' +
'var lis=items.map(function(it){return "<li>"+escapeHtml(it.text)+renderSourceChips(it.sourceRefs,sources)+"</li>";}).join("");' +
'return "<div class=\\"research-question\\"><h5>"+escapeHtml(label)+"</h5><ul class=\\"research-list\\">"+lis+"</ul></div>";}' +

'function researchVerdictBanner(verdict,sources){' +
'if(!verdict)return "";' +
'var cls=String(verdict.classification||"").toLowerCase();' +
'var color=cls.indexOf("trap")>=0?"#ff7b72":(cls.indexOf("opportunity")>=0?"#10b981":"#8b949e");' +
'var banner="<div class=\\"research-verdict\\" style=\\"border-color:"+color+";color:"+color+"\\">"+' +
'"<span class=\\"research-verdict-label\\">"+escapeHtml(prettyLabel(verdict.classification))+"</span>"+' +
'"<span class=\\"research-confidence\\">Confidence: "+escapeHtml(prettyLabel(verdict.confidence))+"</span>"+"</div>";' +
'var reasoning=verdict.reasoning?("<p class=\\"research-verdict-reasoning\\">"+escapeHtml(verdict.reasoning)+"</p>"+renderSourceChips(verdict.sourceRefs,sources)):"";' +
'return banner+reasoning;}' +

'function researchSourcesList(sources){' +
'if(!sources||!sources.length)return "";' +
'var items=sources.map(function(s){' +
'var label=escapeHtml(s.type)+(s.date?(" \\u2014 "+escapeHtml(s.date)):"");' +
'var desc=s.description?("<span class=\\"src-desc\\">"+escapeHtml(s.description)+"</span>"):"";' +
'var head=s.url?("<a href=\\""+safeUrl(s.url)+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\">"+label+"</a>"):("<span class=\\"src-nolink\\">"+label+"</span>");' +
'return "<li>"+head+desc+"</li>";}).join("");' +
'return "<div class=\\"research-sources\\"><h5>All Sources</h5><ol>"+items+"</ol></div>";}' +

// Phase 6 operational layer: not silent about a research gap for a
// currently-flagged candidate - shown even when research exists but is
// stale, so a stale note doesn't read as current. FRESH/ORPHANED/null all
// render nothing extra here (existing content already speaks for itself).
'function buildResearchFreshnessBannerHTML(freshness){' +
'if(freshness==="NEW")return "<div class=\\"research-freshness rf-new\\">Flagged for research this run \\u2014 not yet researched.</div>";' +
'if(freshness==="STALE_AGE")return "<div class=\\"research-freshness rf-stale\\">Research is more than 14 days old \\u2014 flagged for re-research.</div>";' +
'if(freshness==="STALE_FILING")return "<div class=\\"research-freshness rf-stale\\">A newer SEC filing has been filed since this research was done \\u2014 flagged for re-research.</div>";' +
'return "";}' +

'function buildResearchHTML(ticker){' +
'var d=STOCK_DETAIL[ticker];var r=d.research;' +
'var freshnessBanner=buildResearchFreshnessBannerHTML(d.researchFreshness);' +
'if(!r)return freshnessBanner+"<p class=\\"research-empty\\">Not yet researched \\u2014 no filing-based analysis is available for this ticker yet.</p>";' +
'var q=r.questions||{};var sources=r.sources||[];' +
'var html=freshnessBanner;' +
'html+=researchVerdictBanner(q.verdict,sources);' +
'html+="<p class=\\"research-timestamp\\">Researched on "+escapeHtml(fmtDate(r.researchedAt)||"\\u2014")+"</p>";' +
'html+=researchQuestionBlock("Why It\'s Cheap / Bear Case",q.whyCheapBearCase,sources,false);' +
'html+=researchQuestionBlock("Revenue & EPS Trend",q.revenueEpsTrend,sources,true);' +
'html+=researchQuestionBlock("Margin Trend",q.marginTrend,sources,true);' +
'html+=researchQuestionBlock("Guidance / Outlook Change",q.guidanceChange,sources,false);' +
'html+=researchListBlock("Catalysts",q.catalysts,sources);' +
'html+=researchListBlock("Risks",q.risks,sources);' +
'html+=researchSourcesList(sources);' +
'if(r.sourcingNote)html+="<p class=\\"research-sourcing-note\\">"+escapeHtml(r.sourcingNote)+"</p>";' +
'html+="<p class=\\"research-caveat\\">Generated analysis from public SEC filings and cached news, sourced above. Not investment advice.</p>";' +
'return html;}' +


'function buildWhyScoreText(ticker){' +
'var d=STOCK_DETAIL[ticker];' +
'if(!d)return "No score explanation available.";' +
'var b=d.bucketScores||{};' +
'var labels={valuation:"Valuation",quality:"Quality",growth:"Growth",sentiment:"Sentiment",risk:"Risk",momentum:"Momentum"};' +
'var ids=["valuation","quality","growth","sentiment","risk","momentum"];' +
'var present=ids.filter(function(id){return b[id]!==null&&b[id]!==undefined;});' +
'var strongest=null;' +
'var weakest=null;' +
'if(present.length){' +
'present.sort(function(a,z){return b[z]-b[a];});' +
'strongest=present[0];' +
'weakest=present[present.length-1];' +
'}' +
'var parts=[];' +
'parts.push("Overall score "+d.composite.toFixed(1)+", rank #"+d.rank+" of "+Object.keys(STOCK_DETAIL).length+".");' +
'if(strongest)parts.push("Strongest bucket: "+labels[strongest]+" "+b[strongest].toFixed(1)+".");' +
'if(weakest&&weakest!==strongest)parts.push("Weakest bucket: "+labels[weakest]+" "+b[weakest].toFixed(1)+".");' +
'if(d.valueOpportunity!==null&&d.valueOpportunity!==undefined)parts.push("Value Opportunity: "+d.valueOpportunity.toFixed(1)+".");' +
'if(d.valueTrapRisk!==null&&d.valueTrapRisk!==undefined)parts.push("Trap Risk: "+d.valueTrapRisk.toFixed(1)+"; higher means more trap risk.");' +
'if(d.classification)parts.push("Classification: "+d.classification+".");' +
'return parts.join(" ");' +
'}' +


'function buildWhyScoreSimpleHTML(ticker){' +
'var d=STOCK_DETAIL[ticker];' +
'if(!d)return "<p class=\\"hint\\">No score explanation available.</p>";' +
'var b=d.bucketScores||{};' +
'var labels={valuation:"Valuation",quality:"Quality",growth:"Growth",sentiment:"Sentiment",risk:"Risk",momentum:"Momentum"};' +
'var ids=["valuation","quality","growth","sentiment","risk","momentum"];' +
'var cards=ids.map(function(id){' +
'var v=b[id];' +
'if(v===null||v===undefined){' +
'return "<div class=\\"why2-card\\"><div class=\\"why2-head\\"><span class=\\"why2-name\\">"+escapeHtml(labels[id])+"</span><span class=\\"why2-score\\">—</span></div><div class=\\"why2-meta\\">No data</div></div>";' +
'}' +
'return "<div class=\\"why2-card\\"><div class=\\"why2-head\\"><span class=\\"why2-name\\">"+escapeHtml(labels[id])+"</span><span class=\\"why2-score\\">"+v.toFixed(1)+"</span></div><div class=\\"why2-meta\\">Bucket score</div></div>";' +
'}).join("");' +
'return "<div class=\\"why2-wrap\\"><div class=\\"why2-summary\\">"+escapeHtml(buildWhyScoreText(ticker))+"</div><div class=\\"why2-grid\\">"+cards+"</div>"+buildWhyScoreChangeHTML(ticker)+"</div>";' +
'}' +

// Phase 8: per-stock "recent score change" line - null change (no history
// yet, or this ticker is new since the last snapshot) renders nothing
// rather than a placeholder, so unaffected tickers stay uncluttered.
'function buildWhyScoreChangeHTML(ticker){' +
'var d=STOCK_DETAIL[ticker];' +
'var ch=d&&d.change;' +
'if(!ch)return "";' +
'var deltaClass=ch.scoreDelta>0?"move-up":ch.scoreDelta<0?"move-down":"move-flat";' +
'var arrow=ch.scoreDelta>0?"\\u25B2":ch.scoreDelta<0?"\\u25BC":"\\u25CF";' +
'var sign=ch.scoreDelta>0?"+":"";' +
'var text="Score "+sign+ch.scoreDelta.toFixed(1)+" since last snapshot";' +
'var classLine=(ch.classificationBefore!==ch.classificationAfter)' +
'?"<div class=\\"why2-class-change\\">Classification changed: "+escapeHtml(ch.classificationBefore)+" \\u2192 "+escapeHtml(ch.classificationAfter)+"</div>"' +
':"";' +
'return "<div class=\\"why2-change\\"><span class=\\"move-delta "+deltaClass+"\\">"+arrow+" "+escapeHtml(text)+"</span>"+classLine+"</div>";' +
'}' +

'function buildDetailHTML(ticker){' +
'return "<div class=\\"detail-wrap\\">"+' +
'"<div class=\\"detail-section detail-price-section\\"><h4>Price &amp; Chart</h4>"+buildPriceHTML(ticker)+"</div>"+' +
'"<div class=\\"detail-section detail-allmetrics-section\\"><h4>All Metrics</h4>"+buildAllMetricsHTML(ticker)+"</div>"+' +
'"<div class=\\"detail-grid\\">"+' +
'"<div class=\\"detail-section\\"><h4>Recent News</h4>"+buildNewsHTML(ticker)+"</div>"+' +
'"<div class=\\"detail-section\\"><h4>Where It Stands</h4>"+buildStatChartHTML()+"</div>"+' +
'"</div>"+' +
'"<div class=\\"detail-section\\"><h4>Congressional Trading Activity</h4>"+buildPoliticalTradesHTML(ticker)+"</div>"+' +
'"<div class=\\\"detail-section\\\"><h4>Why This Score</h4>"+buildWhyScoreSimpleHTML(ticker)+"</div>"+' +
'"<div class=\\"detail-section detail-research-section\\"><h4>Research &amp; Analyst Reasoning</h4>"+buildResearchHTML(ticker)+"</div>"+' +
'"</div>";}' +

'function fmtStatValue(metricId,v){' +
'if(v===null||v===undefined)return "\\u2014";' +
'if(metricId==="sentiment")return v.toFixed(3);' +
'if(metricId==="analyst"||metricId==="score"||metricId==="valueOpportunity"||metricId==="trapRisk")return v.toFixed(1);' +
'return v.toFixed(2);}' +

'function renderStatChart(container,metricId,ticker){' +
'var cfg=STAT_METRICS[metricId];' +
'var note=cfg.description?("<p class=\\"hint\\">"+escapeHtml(cfg.description)+"</p>"):"";' +
'var values=METRIC_DIST[metricId]||[];' +
'var d=STOCK_DETAIL[ticker];' +
'var myValue=d.metrics[metricId];' +
'var cov=d.scoreCoverage||{};' +
'if(metricId==="score"&&cov.mainEligible===false){' +
'var mainPct=Math.round((cov.main==null?0:cov.main)*100);' +
'container.innerHTML=note+"<p class=\\"hint\\">Insufficient data for universe Score ranking · "+mainPct+"% coverage. This stock is excluded from normal Score percentile/rank comparisons.</p>";return;}' +
'if(metricId==="valueOpportunity"&&cov.valueOpportunityEligible===false){' +
'var voPct=Math.round((cov.valueOpportunity==null?0:cov.valueOpportunity)*100);' +
'container.innerHTML=note+"<p class=\\"hint\\">Insufficient data for Value Opportunity ranking · "+voPct+"% coverage. This stock is excluded from normal Value Opportunity percentile/rank comparisons.</p>";return;}' +
'if(!values.length||myValue===null||myValue===undefined){' +
'container.innerHTML=note+"<p class=\\"hint\\">No data for this metric on this ticker.</p>";return;}' +
'var min=Math.min.apply(null,values),max=Math.max.apply(null,values);' +
'var binCount=20;var span=(max-min)||1;var binWidth=span/binCount;' +
'var bins=new Array(binCount).fill(0);' +
'values.forEach(function(v){var idx=Math.min(binCount-1,Math.max(0,Math.floor((v-min)/binWidth)));bins[idx]++;});' +
'var myBin=Math.min(binCount-1,Math.max(0,Math.floor((myValue-min)/binWidth)));' +
'var maxCount=Math.max.apply(null,bins);' +
'var below=0,equal=0;' +
'values.forEach(function(v){if(v<myValue)below++;else if(v===myValue)equal++;});' +
'var pct=((below+0.5*equal)/values.length)*100;' +
'var goodnessPct=cfg.lowerIsBetter?(100-pct):pct;' +
'var rank=values.filter(function(v){return cfg.lowerIsBetter?v<myValue:v>myValue;}).length+1;' +
'var band=cfg.neutral?null:detailBandFor(goodnessPct);var markColor=cfg.neutral?"#8b949e":(DETAIL_BAND_COLOR[band]||"#8b949e");' +
'var w=520,h=130,barW=w/binCount;' +
'var bars=bins.map(function(count,i){' +
'var barH=maxCount?(count/maxCount)*(h-14):0;' +
'var isMine=(i===myBin);' +
'var fill=isMine?markColor:"#21262d";' +
'return "<rect x=\\""+(i*barW+1)+"\\" y=\\""+(h-barH)+"\\" width=\\""+(barW-2)+"\\" height=\\""+barH+"\\" fill=\\""+fill+"\\"></rect>";' +
'}).join("");' +
'var markerX=myBin*barW+barW/2;' +
'container.innerHTML=note+' +
'"<svg viewBox=\\"0 0 "+w+" "+h+"\\" width=\\"100%\\" height=\\"130\\" preserveAspectRatio=\\"none\\">"+bars+' +
'"<line x1=\\""+markerX+"\\" y1=\\"0\\" x2=\\""+markerX+"\\" y2=\\""+h+"\\" stroke=\\""+markColor+"\\" stroke-width=\\"2\\" stroke-dasharray=\\"3,2\\"></line>"+' +
'"</svg>"+' +
'"<div class=\\"stat-readout\\"><span>This stock: "+fmtStatValue(metricId,myValue)+"</span>"+' +
'"<span style=\\"color:"+markColor+"\\">Percentile: "+goodnessPct.toFixed(0)+"</span>"+' +
'"<span>Rank: "+rank+" of "+values.length+"</span></div>";}' +

'function wireDetailPanel(ticker,detailTr){' +
'var d=STOCK_DETAIL[ticker];' +
'var tvContainer=detailTr.querySelector(".tv-widget-container");' +
'if(tvContainer){' +
'var widgetDiv=document.createElement("div");' +
'widgetDiv.className="tradingview-widget-container__widget";' +
'tvContainer.appendChild(widgetDiv);' +
'var script=document.createElement("script");' +
'script.type="text/javascript";' +
'script.src="https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js";' +
'script.async=true;' +
'script.text=JSON.stringify({symbols:[[d.tvSymbol+"|1D"]],chartOnly:false,width:"100%",height:260,locale:"en",colorTheme:"dark",autosize:true,showVolume:false});' +
'tvContainer.appendChild(script);}' +
'var select=detailTr.querySelector(".stat-select");' +
'var chartContainer=detailTr.querySelector(".stat-chart-container");' +
'select.value="score";' +
'renderStatChart(chartContainer,"score",ticker);' +
'select.addEventListener("change",function(){renderStatChart(chartContainer,select.value,ticker);});' +
'var amExplain=detailTr.querySelector("#amExplain");' +
'if(amExplain){detailTr.querySelectorAll(".am-row").forEach(function(row){' +
'row.addEventListener("click",function(){' +
'var id=row.dataset.m,wasOpen=row.classList.contains("open");' +
'detailTr.querySelectorAll(".am-row").forEach(function(r){r.classList.remove("open");});' +
'if(wasOpen){amExplain.classList.remove("show");amExplain.innerHTML="";return;}' +
'row.classList.add("open");' +
'amExplain.innerHTML=metricExplainHTML(id);' +
'amExplain.classList.add("show");' +
'});});}}' +

// Closing fades the panel out, then fully removes the <tr> once the CSS
// transition finishes (220ms, see .detail-wrap) - opacity:0 alone does NOT
// collapse layout, so the row must actually leave the DOM or its full
// (TradingView-chart-sized) height keeps reserving blank space. Removing the
// node also tears down whatever got injected into it (the TradingView
// <script>/iframe included) - no leftover widget instance to leak or glitch
// on the next open. The "closing" flag lets a rapid re-click cancel the
// pending removal instead of yanking the row out from under a reopen.
// detailTr.dataset.state is the logical source of truth ("open"/"closing"),
// set synchronously the instant an action happens. The "open" CSS class is
// only for the visual fade and is applied a frame later via
// requestAnimationFrame - checking that class instead of a synchronous flag
// would race a fast second click (or a script) that fires before the first
// frame paints, misreading a row that's still opening as already-closed.
'function closeDetail(tr,detailTr){' +
'detailTr.dataset.state="closing";' +
'detailTr.classList.remove("open");' +
'tr.classList.remove("expanded");' +
'setTimeout(function(){' +
'if(detailTr.dataset.state==="closing"&&detailTr.parentNode)detailTr.remove();' +
'},240);}' +

'function reopenDetail(tr,detailTr){' +
'detailTr.dataset.state="open";' +
'tr.classList.add("expanded");' +
'requestAnimationFrame(function(){detailTr.classList.add("open");});}' +

'function expandRow(tr){' +
'var next=tr.nextElementSibling;' +
'if(next&&next.classList.contains("detail-row")){' +
'if(next.dataset.state==="open"){closeDetail(tr,next);}' +
'else{reopenDetail(tr,next);}' + // was mid fade-out (state "closing") - cancel the pending removal instead of rebuilding
'return;}' +
// no panel exists yet (first open, or a prior close already finished removing it) - build fresh
'var colCount=table.querySelector("thead tr").children.length;' +
'var detailTr=document.createElement("tr");' +
'detailTr.className="detail-row";' +
'var td=document.createElement("td");' +
'td.colSpan=colCount;' +
'td.innerHTML=buildDetailHTML(tr.dataset.ticker);' +
'detailTr.appendChild(td);' +
'tr.parentNode.insertBefore(detailTr,tr.nextSibling);' +
'wireDetailPanel(tr.dataset.ticker,detailTr);' +
'reopenDetail(tr,detailTr);}' +

'dataRows().forEach(function(tr){tr.addEventListener("click",function(e){' +
'if(e.target.closest(".star-btn"))return;' +
'expandRow(tr);});});' +

// Phase 9: dashboard "click a ticker -> open it in the real table" - reuses
// expandRow()/applyFilters() as-is rather than a separate preview. Resets
// any active classification/watchlist filter first so the target row can
// never end up hidden right after being expanded. Also force-expands the
// collapsed table when the target sits beyond the top COLLAPSE_ROWS, for
// the same reason - a Morning Brief pick can be ranked anywhere in the 503.
'document.querySelectorAll(".dashboard [data-jump-ticker]").forEach(function(el){' +
'el.addEventListener("click",function(){' +
'var ticker=el.dataset.jumpTicker;' +
'classFilter.value="";' +
'currentView="all";' +
'document.querySelectorAll(".view-tab").forEach(function(b){b.classList.toggle("active",b.dataset.view==="all");});' +
'var tr=document.querySelector(\'tr[data-ticker="\'+ticker+\'"]\');' +
'if(tr&&dataRows().indexOf(tr)>=COLLAPSE_ROWS)tableExpanded=true;' +
'applyFilters();' +
'if(!tr)return;' +
'expandRow(tr);' +
'tr.scrollIntoView({behavior:"smooth",block:"center"});' +
'});});' +

// Page-level tabs: Screener (the table/sector view above) vs. Political
// Trades (new). Plain show/hide of two top-level containers - independent
// of the table's own search/sort/collapse model, same pattern as the
// changes/sector expanders elsewhere on this page.
'document.querySelectorAll(".page-tab").forEach(function(btn){btn.addEventListener("click",function(){' +
'document.querySelectorAll(".page-tab").forEach(function(b){b.classList.remove("active");});' +
'btn.classList.add("active");' +
'var page=btn.dataset.page;' +
'document.getElementById("pageScreener").hidden=(page!=="screener");' +
'document.getElementById("pagePolitical").hidden=(page!=="political");' +
'});});' +

// Political Trades page: a feed table (mirrors the main table's
// collapse/search/sort pattern, minus classification/watchlist) plus two
// leaderboards, all computed client-side from the single POLITICAL_TRADES
// array embedded above - no extra data fetch, no server-side aggregation.
'function ptDataRows(){return [].slice.call(document.getElementById("ptTbody").querySelectorAll("tr"));}' +
'var PT_COLLAPSE_ROWS=25,ptExpanded=false,ptLastCol=null,ptAsc=false;' +
'var ptSearch=document.getElementById("ptSearch");' +
'var ptExpandBtn=document.getElementById("ptExpandBtn");' +

'function parseAmountLow(s){if(!s)return null;var m=String(s).replace(/,/g,"").match(/([\\d.]+)/);return m?parseFloat(m[1]):null;}' +

'function applyPtFilters(){' +
'var q=ptSearch?ptSearch.value.trim().toLowerCase():"";var hasQuery=q.length>0;var matchCount=0;' +
'ptDataRows().forEach(function(r,idx){' +
'var ok=!hasQuery||r.innerText.toLowerCase().includes(q);' +
'if(!ok){r.style.display="none";return;}' +
'matchCount++;' +
'r.style.display=(hasQuery||ptExpanded||idx<PT_COLLAPSE_ROWS)?"":"none";});' +
'if(ptExpandBtn){' +
'ptExpandBtn.style.display=(!hasQuery&&matchCount>PT_COLLAPSE_ROWS)?"":"none";' +
'ptExpandBtn.innerHTML=ptExpanded?"Show top "+PT_COLLAPSE_ROWS+" \\u25B2":"Show all "+matchCount+" \\u25BE";}}' +

'function renderPoliticalFeed(){' +
'var tbody=document.getElementById("ptTbody");' +
// Already sorted newest-first by fetchData.js, so no default sort needed here.
'POLITICAL_TRADES.forEach(function(t){' +
'var ts=t.transactionDate?new Date(t.transactionDate).getTime():0;' +
'var typeClass=/purchase/i.test(t.type||"")?"pt-buy":/sale/i.test(t.type||"")?"pt-sell":"";' +
'var amtLow=parseAmountLow(t.amount);' +
'var tr=document.createElement("tr");tr.className="data-row";tr.dataset.ticker=t.ticker;' +
'tr.innerHTML=' +
'"<td data-col=\\"date\\" data-value=\\""+ts+"\\">"+escapeHtml(t.transactionDate||"")+"</td>"+' +
'"<td data-col=\\"member\\" data-value=\\""+escapeHtml(t.member||"")+"\\">"+escapeHtml(t.member||"")+"</td>"+' +
'"<td data-col=\\"chamber\\" data-value=\\""+escapeHtml(t.chamber||"")+"\\">"+escapeHtml(t.chamber||"")+"</td>"+' +
'"<td data-col=\\"ticker\\" data-value=\\""+escapeHtml(t.ticker||"")+"\\"><b>"+escapeHtml(t.ticker||"")+"</b>"+(t.companyName?(" <span class=\\"news-meta\\">"+escapeHtml(t.companyName)+"</span>"):"")+"</td>"+' +
'"<td data-col=\\"type\\" data-value=\\""+escapeHtml(t.type||"")+"\\"><span class=\\"pt-type "+typeClass+"\\">"+escapeHtml(t.type||"\\u2014")+"</span></td>"+' +
'"<td class=\\"num\\" data-col=\\"amount\\" data-value=\\""+(amtLow==null?0:amtLow)+"\\">"+escapeHtml(t.amount||"")+"</td>"+' +
'"<td data-col=\\"link\\">"+(t.link?("<a href=\\""+safeUrl(t.link)+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" class=\\"pt-link\\">filing</a>"):"")+"</td>";' +
'tbody.appendChild(tr);});' +
'var ptEmpty=document.getElementById("ptEmpty");if(ptEmpty)ptEmpty.hidden=POLITICAL_TRADES.length>0;' +
'applyPtFilters();}' +

'if(ptSearch)ptSearch.addEventListener("input",applyPtFilters);' +
'if(ptExpandBtn)ptExpandBtn.addEventListener("click",function(){ptExpanded=!ptExpanded;applyPtFilters();});' +

'var ptTable=document.getElementById("ptTable");' +
'if(ptTable){ptTable.querySelectorAll("th[data-type]").forEach(function(th){th.addEventListener("click",function(){' +
'var col=th.dataset.col,type=th.dataset.type;ptAsc=(ptLastCol===col)?!ptAsc:false;ptLastCol=col;' +
'var rows=ptDataRows();var tbody=document.getElementById("ptTbody");' +
'rows.sort(function(a,b){' +
'var av=a.querySelector("[data-col=\\""+col+"\\"]").dataset.value;' +
'var bv=b.querySelector("[data-col=\\""+col+"\\"]").dataset.value;' +
'var cmp=(type==="num")?(parseFloat(av)-parseFloat(bv)):String(av).localeCompare(bv);return ptAsc?cmp:-cmp;});' +
'rows.forEach(function(r){tbody.appendChild(r);});' +
'applyPtFilters();});});}' +

'function lbRowHTML(rank,key,label,sub,count){' +
'return "<div class=\\"lb-row\\" tabindex=\\"0\\" data-lb-key=\\""+escapeHtml(key)+"\\"><span class=\\"lb-rank\\">"+rank+"</span>"+' +
'"<span class=\\"lb-name\\">"+escapeHtml(label)+(sub?("<span class=\\"lb-sub\\">"+escapeHtml(sub)+"</span>"):"")+"</span>"+' +
'"<span class=\\"lb-count\\"><b>"+count+"</b> trade"+(count===1?"":"s")+"<span class=\\"lb-arrow\\"></span></span></div>";}' +

'function renderLeaderboards(){' +
'var tickerCounts={},tickerNames={},memberCounts={},memberChamber={};' +
'POLITICAL_TRADES.forEach(function(t){' +
'tickerCounts[t.ticker]=(tickerCounts[t.ticker]||0)+1;' +
'if(t.companyName)tickerNames[t.ticker]=t.companyName;' +
'var key=t.member||"Unknown";' +
'memberCounts[key]=(memberCounts[key]||0)+1;memberChamber[key]=t.chamber;});' +

'var topTickers=Object.keys(tickerCounts).map(function(k){return {ticker:k,count:tickerCounts[k],name:tickerNames[k]};})' +
'.sort(function(a,b){return b.count-a.count;}).slice(0,12);' +
'var topMembers=Object.keys(memberCounts).map(function(k){return {member:k,count:memberCounts[k],chamber:memberChamber[k]};})' +
'.sort(function(a,b){return b.count-a.count;}).slice(0,12);' +

'var tEl=document.getElementById("tickerLeaderboard");' +
'tEl.innerHTML=topTickers.length?topTickers.map(function(row,i){return lbRowHTML(i+1,row.ticker,row.ticker,row.name,row.count);}).join("")' +
':"<p class=\\"hint\\">No congressional trades tracked yet.</p>";' +

'var mEl=document.getElementById("memberLeaderboard");' +
'mEl.innerHTML=topMembers.length?topMembers.map(function(row,i){return lbRowHTML(i+1,row.member,row.member,row.chamber,row.count);}).join("")' +
':"<p class=\\"hint\\">No congressional trades tracked yet.</p>";}' +

// Shared trade-row renderer for both leaderboards' expand panels. showMember
// picks what the row's primary identifier is: the member's name (ticker
// leaderboard, since ticker is already the group heading) or the
// ticker+company (member leaderboard, since member is already the group
// heading) - the group's own key is never repeated inside its own rows.
// Filing link is simply omitted (not a dead/empty link) when a record has
// none - matches every trade currently in cache/congressTrades.json, whose
// provider only ever stores records that already have a link, but this
// stays defensive rather than assuming that always holds.
'function lbTradeRowHTML(t,showMember){' +
'var typeClass=/purchase/i.test(t.type||"")?"pt-buy":/sale/i.test(t.type||"")?"pt-sell":"";' +
'var primary=showMember' +
'?("<span class=\\"pt-member\\">"+escapeHtml(t.member||"")+"</span>")' +
':("<span class=\\"pt-member\\"><b>"+escapeHtml(t.ticker||"")+"</b>"+(t.companyName?(" "+escapeHtml(t.companyName)):"")+"</span>");' +
'var linkHtml=t.link?(" <a href=\\""+safeUrl(t.link)+"\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" class=\\"pt-link\\">filing</a>"):"";' +
'return "<li class=\\"pt-row\\">"+' +
'"<span class=\\"pt-type "+typeClass+"\\">"+escapeHtml(t.type||"\\u2014")+"</span>"+' +
'primary+' +
'"<span class=\\"pt-chamber\\">"+escapeHtml(t.chamber||"")+"</span>"+' +
'"<span class=\\"pt-amount\\">"+escapeHtml(t.amount||"")+"</span>"+' +
'"<span class=\\"pt-date\\">"+escapeHtml(t.transactionDate||"")+"</span>"+' +
'"<span class=\\"pt-date\\">filed "+escapeHtml(t.disclosureDate||"\\u2014")+"</span>"+linkHtml+' +
'"</li>";}' +

'function lbTradeListHTML(trades,showMember){' +
'if(!trades.length)return "<p class=\\"hint\\">No trades found.</p>";' +
'var sorted=trades.slice().sort(function(a,b){' +
'return (a.transactionDate<b.transactionDate)?1:(a.transactionDate>b.transactionDate?-1:0);});' +
'return "<ul class=\\"pt-list\\">"+sorted.map(function(t){return lbTradeRowHTML(t,showMember);}).join("")+"</ul>";}' +

// Click-to-expand: one shared panel per leaderboard (like the All Metrics
// grid's single #amExplain panel) rather than an inline panel per row, so
// position in the ranked list never matters. Click again collapses; clicking
// a different row swaps - same interaction as the All Metrics grid.
'function wireLeaderboard(containerId,explainId,matchField,showMember){' +
'var container=document.getElementById(containerId);' +
'var explain=document.getElementById(explainId);' +
'if(!container||!explain)return;' +
'container.addEventListener("click",function(e){' +
'var row=e.target.closest(".lb-row");if(!row)return;' +
'var key=row.dataset.lbKey,wasOpen=row.classList.contains("open");' +
'container.querySelectorAll(".lb-row").forEach(function(r){r.classList.remove("open");});' +
'if(wasOpen){explain.classList.remove("show");explain.innerHTML="";return;}' +
'row.classList.add("open");' +
'var trades=POLITICAL_TRADES.filter(function(t){return (matchField==="ticker"?t.ticker:(t.member||"Unknown"))===key;});' +
'explain.innerHTML="<div class=\\"exp-title\\">"+escapeHtml(key)+"</div>"+lbTradeListHTML(trades,showMember);' +
'explain.classList.add("show");' +
'});}' +

'renderPoliticalFeed();' +
'renderLeaderboards();' +
'wireLeaderboard("tickerLeaderboard","tickerLbExplain","ticker",true);' +
'wireLeaderboard("memberLeaderboard","memberLbExplain","member",false);' +

'</script></body></html>';
}

/* ---- run ---- */
function loadCompanies() {
  const p = path.join(__dirname, 'companies.json');
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(data) && data.length) { console.log('\n  Using real data from companies.json (' + data.length + ' names)'); return data; }
    } catch (e) { console.warn('\n  companies.json unreadable (' + e.message + ') - using sample data'); }
  } else { console.log('\n  No companies.json found - using built-in sample data'); }
  return SAMPLE_COMPANIES;
}

// A simple ["AAPL","MSFT",...] list, read at generation time and embedded
// into the report. Creates an empty one if missing so there's a real file to
// edit. See the report's Copy-watchlist.json button for how changes made in
// the browser get back into this file (there's no live write-back - it's a
// static HTML page, see the conversation for why).
function loadWatchlist() {
  const p = path.join(__dirname, 'watchlist.json');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '[]\n');
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data.map((t) => String(t).toUpperCase().trim()).filter(Boolean) : [];
  } catch (e) {
    console.warn('\n  watchlist.json unreadable (' + e.message + ') - starting with an empty watchlist');
    return [];
  }
}

// Read-only at generation time - never touches companies.json or the fetch
// layer's own read/write logic in fetchData.js.
function readJSONSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadUniverseExchanges() {
  const universe = readJSONSafe(path.join(__dirname, 'universe.json'));
  const map = {};
  if (universe && Array.isArray(universe.constituents)) {
    for (const c of universe.constituents) if (c.ticker) map[c.ticker] = c.exchange || null;
  }
  return map;
}

// Phase 6 display layer: reads a per-ticker research note written by
// research.js (research/<TICKER>.json) if one exists. Read-only, same
// readJSONSafe() used for everything else in this function - never writes,
// never touches the research files or companies.json. Only EIX/UHS/ALL have
// a file today (the Phase 6 thin slice); every other ticker resolves to
// null here and gets the "Not yet researched" placeholder client-side.
function loadResearchNote(ticker) {
  return readJSONSafe(path.join(__dirname, 'research', ticker + '.json'));
}

// Phase 6 operational layer: attaches a `researchFreshness` field
// ('NEW'|'STALE_AGE'|'STALE_FILING'|'FRESH'|'ORPHANED'|null) to each scored
// company, purely by reading research-queue.json (written by research.js,
// which does the actual live SEC filing-date checks). screener.js never
// makes a live network call itself - it only reads what research.js already
// computed, same "cached, as of X" discipline as price/news elsewhere in
// this file. Missing research-queue.json (never run yet) means every
// ticker just gets null - no freshness badge, same as today's behavior.
function attachResearchFreshness(scored) {
  const queueData = readJSONSafe(path.join(__dirname, 'research-queue.json'));
  const queueByTicker = {};
  const orphanedSet = new Set();
  const freshSet = new Set();
  if (queueData) {
    for (const item of queueData.queue || []) queueByTicker[item.ticker] = item;
    for (const item of queueData.orphaned || []) orphanedSet.add(item.ticker);
    for (const t of queueData.fresh || []) freshSet.add(t);
  }
  for (const c of scored) {
    if (queueByTicker[c.ticker]) {
      c.researchFreshness = queueByTicker[c.ticker].reason;
    } else if (freshSet.has(c.ticker)) {
      c.researchFreshness = 'FRESH';
    } else if (orphanedSet.has(c.ticker)) {
      c.researchFreshness = 'ORPHANED';
    } else {
      c.researchFreshness = null;
    }
  }
  return queueData;
}

// Builds the per-ticker payload embedded into the report for the detail
// panel: cached price (+ its real cache timestamp), the TradingView symbol,
// cached news headlines (+ their real cache timestamp), the raw metric
// values the stat-comparison chart needs, and (Phase 6) the research note if
// one exists. All read-only, all already-fetched/pre-generated data - no
// live calls, no new scoring.
function buildStockDetails(scored, changes) {
  const quoteCache = readJSONSafe(path.join(__dirname, 'cache', 'quote.json')) || {};
  const newsCache = readJSONSafe(path.join(__dirname, 'cache', 'news.json')) || {};
  const exchanges = loadUniverseExchanges();

  const details = {};
  for (const c of scored) {
    const quoteEntry = quoteCache[c.ticker] || {};
    const newsEntry = newsCache[c.ticker] || {};
    const exchange = exchanges[c.ticker] || null;
    const metrics = {};
    for (const id of Object.keys(STAT_METRICS)) metrics[id] = statValueFor(id, c) ?? null;

    details[c.ticker] = {
      price: quoteEntry.price ?? null,
      priceAsOf: quoteEntry.updatedAt || null,
      exchange,
      tvSymbol: tvSymbolFor(c.ticker, exchange),
      headlines: Array.isArray(newsEntry.headlines) ? newsEntry.headlines : [],
      newsAsOf: newsEntry.updatedAt || null,
      metrics,
      classification: c.classification,
      rank: c.rank,
      tier: c.tier,
      composite: c.composite,
      bucketScores: c.bucketScores,
      valueOpportunity: c.valueOpportunity,
      valueTrapRisk: c.valueTrapRisk,


      scoreCoverage: {
        main: c.compositeCoverage ?? 1,
        mainEligible: c.compositeEligible ?? true,
        mainRaw: c.compositeRaw ?? c.composite,
        mainAdjusted: c.composite,

        valueOpportunity: c.valueOpportunityCoverage ?? 1,
        valueOpportunityEligible: c.valueOpportunityEligible ?? true,
        valueOpportunityRaw: c.valueOpportunityRaw ?? c.valueOpportunity,
        valueOpportunityAdjusted: c.valueOpportunity,

        valueTrapRisk: c.valueTrapRiskCoverage ?? 1,
        valueTrapRiskEligible: c.valueTrapRiskEligible ?? true,
        valueTrapRiskRaw: c.valueTrapRiskRaw ?? c.valueTrapRisk,
        valueTrapRiskAdjusted: c.valueTrapRisk,

        growth: c.growthBucketCoverage ?? 1,
        growthEligible: c.growthBucketEligible ?? true,
        growthRaw: c.growthBucketRaw ?? (c.bucketScores && c.bucketScores.growth),
        growthAdjusted: c.bucketScores && c.bucketScores.growth,
      },

      research: loadResearchNote(c.ticker),

      // Phase 8: per-ticker change vs. the most recent prior snapshot -
      // null when there's no history yet or this ticker has no prior entry
      // (new addition to the universe), handled client-side the same way
      // "Not yet researched" already is.
      change: (changes && changes.hasHistory && changes.perTicker[c.ticker]) || null,

      // Phase 6 operational layer: 'NEW'|'STALE_AGE'|'STALE_FILING'|'FRESH'|
      // 'ORPHANED'|null - see attachResearchFreshness(). null means this
      // ticker isn't a research candidate this run (unchanged behavior).
      researchFreshness: c.researchFreshness ?? null,
    };
  }
  return details;
}

function buildMetricDistributions(scored) {
  const distributions = {};
  for (const id of Object.keys(STAT_METRICS)) {
    distributions[id] = scored.map((c) => statValueFor(id, c)).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  }
  return distributions;
}

/* ---- Phase 8: change detection ----
 * Persists a lean daily snapshot of the scored universe, then diffs today's
 * run against the most recent PRIOR day (never today's own snapshot, even
 * on a same-day re-run - see loadPreviousSnapshot()). Read/write only
 * touches history/ - never companies.json, never the scoring functions
 * above. A missing/empty history/ directory (first run) is handled the
 * same way a missing cache file already is elsewhere in this file: treated
 * as "nothing yet," never a crash.
 */
const HISTORY_DIR = path.join(__dirname, 'history');
const HISTORY_RETENTION_DAYS = 90;
const TOP_TIER = 'A';
// "New risk flag" = a stock's classification crossed INTO one of these from
// something else - reuses the classification labels already computed by
// scoreUniverse(), not a separate risk model.
const RISK_CLASSIFICATIONS = new Set([CLASSIFICATION.POSSIBLE_VALUE_TRAP, CLASSIFICATION.DISTRESSED]);

// Lean by design, per spec - not the full 26-field companies.json record,
// just what's needed to compute deltas and explain them.
const HISTORY_FIELDS = [
  'composite', 'tier', 'classification', 'valueOpportunity', 'valueTrapRisk',
  'pe', 'roe', 'debtEquity', 'ret3m', 'ret6m',
  'revenueGrowth', 'epsGrowth', 'fcfGrowth', 'operatingMargin', 'marginTrend',
];

function todayDateStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildSnapshot(scored, dateStr) {
  const companies = {};
  for (const c of scored) {
    const entry = {};
    for (const f of HISTORY_FIELDS) entry[f] = c[f] !== undefined ? c[f] : null;
    companies[c.ticker] = entry;
  }
  return { date: dateStr, generatedAt: new Date().toISOString(), companies };
}

// Same atomic temp+rename pattern as writeCacheAtomic() in fetchData.js.
// Always (re)writes today's file in full - a same-day re-run's fresher
// scoring simply replaces today's snapshot; it never needs to be "merged"
// since the full universe is always available each run.
function writeSnapshotAtomic(dateStr, snapshot) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const file = path.join(HISTORY_DIR, dateStr + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmp, file);
}

function listSnapshotDates() {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

// Deliberately excludes dateStr itself - a same-day re-run must never diff
// today's snapshot against itself (that would always show zero change and
// would also mean the "previous" pointer silently drifts forward every
// re-run instead of staying anchored to the last real prior day).
function loadPreviousSnapshot(dateStr) {
  const priorDates = listSnapshotDates().filter((d) => d < dateStr);
  if (!priorDates.length) return null;
  const prevDate = priorDates[priorDates.length - 1];
  const snap = readJSONSafe(path.join(HISTORY_DIR, prevDate + '.json'));
  return snap && snap.companies ? { date: prevDate, companies: snap.companies } : null;
}

// TURNAROUND CANDIDATE needs a real trajectory, not a single noisy
// day-over-day comparison - requires at least this many prior daily
// snapshots to exist before it's allowed to fire at all. Below this,
// loadTurnaroundBaseline() returns eligible:false and classify() never
// reaches the TURNAROUND branch for any stock this run.
const TURNAROUND_MIN_PRIOR_SNAPSHOTS = 3;
// The baseline is the OLDEST snapshot within this many calendar days back
// (not just "3 snapshots ago") - bounds how stale a "was struggling"
// comparison can be if the tool goes unused for a while, so a month-old
// snapshot never gets treated as "recent" history.
const TURNAROUND_LOOKBACK_DAYS = 7;

function loadTurnaroundBaseline(dateStr) {
  const priorDates = listSnapshotDates().filter((d) => d < dateStr);
  if (priorDates.length < TURNAROUND_MIN_PRIOR_SNAPSHOTS) {
    return { eligible: false, priorCount: priorDates.length, baselineDate: null, companies: {} };
  }
  const cutoff = new Date(dateStr + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - TURNAROUND_LOOKBACK_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const windowDates = priorDates.filter((d) => d >= cutoffStr);
  const baselineDate = (windowDates.length ? windowDates : priorDates)[0]; // oldest within window, else oldest available
  const snap = readJSONSafe(path.join(HISTORY_DIR, baselineDate + '.json'));
  return {
    eligible: true,
    priorCount: priorDates.length,
    baselineDate,
    companies: (snap && snap.companies) || {},
  };
}

function pruneOldSnapshots() {
  const dates = listSnapshotDates();
  if (dates.length <= HISTORY_RETENTION_DAYS) return;
  for (const d of dates.slice(0, dates.length - HISTORY_RETENTION_DAYS)) {
    try { fs.unlinkSync(path.join(HISTORY_DIR, d + '.json')); } catch { /* best-effort */ }
  }
}

function computeChanges(scored, previous) {
  if (!previous) return { hasHistory: false, previousDate: null };

  const prevCompanies = previous.companies;
  const todayByTicker = {};
  for (const c of scored) todayByTicker[c.ticker] = c;

  const allTickers = new Set([...Object.keys(prevCompanies), ...Object.keys(todayByTicker)]);
  const moves = [];
  const newEntries = [];
  const dropped = [];
  const classificationChanges = [];
  const newRiskFlags = [];
  const enteredTopTier = [];
  const leftTopTier = [];

  for (const ticker of allTickers) {
    const before = prevCompanies[ticker];
    const after = todayByTicker[ticker];
    if (!before && after) { newEntries.push(ticker); continue; }
    if (before && !after) { dropped.push(ticker); continue; }
    if (!before || !after) continue;

    const scoreDelta = (after.composite != null && before.composite != null)
      ? +(after.composite - before.composite).toFixed(2) : null;
    const valueOpportunityDelta = (after.valueOpportunity != null && before.valueOpportunity != null)
      ? +(after.valueOpportunity - before.valueOpportunity).toFixed(2) : null;
    const valueTrapRiskDelta = (after.valueTrapRisk != null && before.valueTrapRisk != null)
      ? +(after.valueTrapRisk - before.valueTrapRisk).toFixed(2) : null;
    const classificationChanged = before.classification !== after.classification;

    if (scoreDelta !== null) {
      moves.push({
        ticker, scoreDelta, valueOpportunityDelta, valueTrapRiskDelta,
        tierBefore: before.tier, tierAfter: after.tier,
        classificationBefore: before.classification, classificationAfter: after.classification,
      });
    }
    if (classificationChanged) {
      classificationChanges.push({ ticker, from: before.classification, to: after.classification });
      if (RISK_CLASSIFICATIONS.has(after.classification) && !RISK_CLASSIFICATIONS.has(before.classification)) {
        newRiskFlags.push({ ticker, from: before.classification, to: after.classification });
      }
    }
    if (before.tier !== TOP_TIER && after.tier === TOP_TIER) enteredTopTier.push(ticker);
    if (before.tier === TOP_TIER && after.tier !== TOP_TIER) leftTopTier.push(ticker);
  }

  const gainers = [...moves].sort((a, b) => b.scoreDelta - a.scoreDelta).slice(0, 10);
  const losers = [...moves].sort((a, b) => a.scoreDelta - b.scoreDelta).slice(0, 10);

  const perTicker = {};
  for (const m of moves) perTicker[m.ticker] = m;

  return {
    hasHistory: true,
    previousDate: previous.date,
    perTicker,
    gainers,
    losers,
    classificationChanges,
    newRiskFlags,
    enteredTopTier,
    leftTopTier,
    newEntries,
    dropped,
  };
}

function main() {
  // Computed before scoring (not after, like the rest of Phase 8's history
  // handling below) because classify() needs it DURING scoreUniverse() to
  // evaluate TURNAROUND CANDIDATE for each company. Reused later for the
  // Phase 8 change-detection diff too, rather than recomputed.
  const todayStr = todayDateStr();
  const turnaroundBaseline = loadTurnaroundBaseline(todayStr);

  const scored = scoreUniverse(loadCompanies(), turnaroundBaseline);
  if (turnaroundBaseline.eligible) {
    console.log('\n  Turnaround baseline: ' + turnaroundBaseline.baselineDate + ' (' + turnaroundBaseline.priorCount + ' prior snapshot(s) available)');
  } else {
    console.log('\n  TURNAROUND CANDIDATE inactive this run: only ' + turnaroundBaseline.priorCount + ' prior snapshot(s) available (need ' + TURNAROUND_MIN_PRIOR_SNAPSHOTS + ').');
  }
  const researchQueueData = attachResearchFreshness(scored);
  if (researchQueueData) {
    console.log('\n  Research freshness: ' + (researchQueueData.queue || []).length + ' need (re)research, '
      + (researchQueueData.fresh || []).length + ' fresh, ' + (researchQueueData.orphaned || []).length + ' orphaned'
      + ' (from research-queue.json, generated ' + researchQueueData.generatedAt + ')');
  }
  const sectors = rankSectors(scored);
  console.log('\n  RANK  TIER  TICKER   SCORE');
  console.log('  ' + '-'.repeat(34));
  for (const c of scored) console.log('   ' + String(c.rank).padStart(2) + '     ' + c.tier + '    ' + c.ticker.padEnd(6) + '   ' + c.composite.toFixed(1).padStart(5));
  console.log('\n  Industries (best to worst):');
  sectors.forEach((s, i) => console.log('   ' + (i + 1) + '. ' + s.sector.padEnd(22) + s.avg.toFixed(1)));

  console.log('\n  Top 10 - Value Opportunity (cheap + healthy):');
  [...scored].sort((a, b) => (b.valueOpportunity ?? -1) - (a.valueOpportunity ?? -1)).slice(0, 10)
    .forEach((c, i) => console.log('   ' + String(i + 1).padStart(2) + '. ' + c.ticker.padEnd(6) + (c.valueOpportunity == null ? '  —' : c.valueOpportunity.toFixed(1).padStart(5))));

  console.log('\n  Top 10 - Value Trap Risk (cheap for a reason?):');
  [...scored].sort((a, b) => (b.valueTrapRisk ?? -1) - (a.valueTrapRisk ?? -1)).slice(0, 10)
    .forEach((c, i) => console.log('   ' + String(i + 1).padStart(2) + '. ' + c.ticker.padEnd(6) + (c.valueTrapRisk == null ? '  —' : c.valueTrapRisk.toFixed(1).padStart(5))));

  const highBoth = scored.filter((c) => c.valueOpportunity !== null && c.valueTrapRisk !== null
    && c.valueOpportunity >= HIGH_BOTH_THRESHOLD && c.valueTrapRisk >= HIGH_BOTH_THRESHOLD);
  console.log('\n  High on BOTH (>=' + HIGH_BOTH_THRESHOLD + ' opportunity AND >=' + HIGH_BOTH_THRESHOLD + ' trap risk) - interesting but dangerous:');
  if (!highBoth.length) console.log('   (none this run)');
  highBoth.sort((a, b) => (b.valueOpportunity + b.valueTrapRisk) - (a.valueOpportunity + a.valueTrapRisk))
    .forEach((c) => console.log('   ' + c.ticker.padEnd(6) + 'opp ' + c.valueOpportunity.toFixed(1) + '   trap ' + c.valueTrapRisk.toFixed(1)));
  console.log('  (remember: trap risk here only sees valuation/leverage/momentum/sentiment/analyst -');
  console.log('   it cannot see revenue/EPS trends, margins, or guidance. Research before acting on it.)');

  const watchlist = loadWatchlist();
  console.log('\n  Watchlist: ' + watchlist.length + ' ticker(s) from watchlist.json' + (watchlist.length ? ' (' + watchlist.join(', ') + ')' : ''));

  // Phase 8: diff against the most recent PRIOR day before writing today's
  // snapshot - writing first would make today "its own previous" on a
  // same-day re-run. Read-only with respect to companies.json/scoring;
  // only touches history/. (todayStr computed earlier, before scoring.)
  const previousSnapshot = loadPreviousSnapshot(todayStr);
  const changes = computeChanges(scored, previousSnapshot);
  writeSnapshotAtomic(todayStr, buildSnapshot(scored, todayStr));
  pruneOldSnapshots();
  if (changes.hasHistory) {
    console.log('\n  Change detection: diffed against ' + changes.previousDate + ' - '
      + changes.classificationChanges.length + ' classification change(s), '
      + changes.newRiskFlags.length + ' new risk flag(s), '
      + changes.newEntries.length + ' new entr(ies), ' + changes.dropped.length + ' dropped.');
  } else {
    console.log('\n  Change detection: no prior snapshot yet - history starts today (' + todayStr + ').');
  }

  const stockDetails = buildStockDetails(scored, changes);
  const withPrice = Object.values(stockDetails).filter((d) => d.price !== null).length;
  const withNews = Object.values(stockDetails).filter((d) => d.headlines.length).length;
  console.log('  Detail panels: ' + withPrice + '/' + scored.length + ' have a cached price, ' + withNews + '/' + scored.length + ' have cached headlines');
  const metricDistributions = buildMetricDistributions(scored);

  const outPath = path.join(__dirname, 'screener-report.html');
  fs.writeFileSync(outPath, buildHTML(scored, sectors, watchlist, stockDetails, metricDistributions, changes));
  console.log('\n  Report written -> ' + outPath + '\n');
}

if (require.main === module) {
  main();
}

// Exposed so research.js can reuse the exact same scoring/classification
// logic for candidate selection instead of duplicating it - require()'ing
// this file no longer runs main() (see the require.main guard above), so
// nothing about `node screener.js`'s own output changes.
module.exports = { scoreUniverse, loadCompanies, loadWatchlist, CLASSIFICATION, selectResearchCandidates };
