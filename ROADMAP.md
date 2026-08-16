# Development Roadmap

## Product goal

Build an automated stock-research system that can:

- Screen hundreds of U.S. stocks
- Preserve potentially undervalued / beaten-down companies
- Rank companies using valuation, quality, growth, risk, and research
- Detect possible value traps
- Perform live research on the most interesting candidates
- Explain why a company ranks highly or poorly
- Track what changed since yesterday
- Produce an automated morning dashboard
- Eventually run on an always-on server

---

# Phase 0 — Stabilize the current build

Do this before adding features.

### 0.1 Back up the current working project

```bash
cp -R ~/Desktop/Screener ~/Desktop/Screener-Backup
```

### 0.2 Clean `fetchData.js`

Remove duplicate helpers and make sure every function called in `main()` exists.

Specifically verify:

- `fmpProfile`
- `fmpRatios`
- `fmpPriceChange`
- `finnhubAnalyst`
- `finnhubSentiment`
- one and only one `getJSON`

### 0.3 Make `run.sh` fail safely

Desired pattern:

```bash
#!/bin/bash
set -euo pipefail

# load secrets
# cd project
node fetchData.js
node screener.js
```

If data collection fails, the report should not silently rebuild from broken or newly-null data.

### 0.4 Rotate exposed API keys

Replace the keys that appeared in screenshots.

### 0.5 Move secrets out of the script

Preferred:

```text
.env
```

or OS/server environment variables.

Do not commit `.env`.

---

# Phase 1 — Build a reliable data layer

This is the highest-priority architecture change.

## 1.1 Add persistent caching

Suggested structure:

```text
Screener/
├── cache/
│   ├── fundamentals.json
│   ├── market.json
│   ├── analyst.json
│   ├── news.json
│   └── research.json
├── companies.json
├── fetchData.js
├── screener.js
└── screener-report.html
```

Rules:

- Never replace a valid cached value with `null` because an API failed.
- Store `source`, `lastUpdated`, and `status` for important fields.
- If a provider is unavailable, fall back to last known valid data.
- Clearly mark stale data in the report.

## 1.2 Separate refresh frequencies

Do not fetch every metric every morning.

### Daily / market-sensitive

- Price
- Returns / relative strength
- Analyst changes
- News
- Sentiment
- Guidance / major event detection

### Weekly

- P/E
- P/B
- Beta
- Broad company profile
- Common valuation metrics

### Quarterly or after earnings

- Revenue
- EPS
- Free cash flow
- ROIC
- Operating margins
- Debt
- Balance sheet
- Share count / dilution

## 1.3 Multi-source data

Avoid depending on a single provider.

Target model:

```text
Market prices / returns       → market-data provider
Analyst consensus             → Finnhub
News                          → Finnhub + live web research
Financial statements          → SEC / provider
Company profile               → Finnhub / provider
Deep qualitative research     → SEC + IR + reputable web sources
```

FMP can remain optional rather than being a single point of failure.

## 1.4 Provider health logic

For every provider:

- recognize 200
- recognize temporary 429
- recognize account/quota 429
- recognize 401/403
- use exponential/backoff only when appropriate
- stop wasting retries when the quota is exhausted
- preserve cache on failure

---

# Phase 2 — Expand the universe

## 2.1 Remove the manually maintained 50-stock list

Start with an automatically maintained S&P 500 universe.

Later expand to other liquid U.S. common stocks.

## 2.2 Eligibility filter only

The user explicitly does **not** want momentum to remove undervalued stocks.

Initial eligibility should only answer questions such as:

- Is this a U.S.-listed common stock?
- Is it sufficiently liquid?
- Is it not an ETF/closed-end fund/preferred/warrant/etc.?
- Is there enough data to score it?
- If going beyond large caps, is the company above a chosen minimum market cap/liquidity threshold?

Do **not** require:

- positive 3M return
- positive 6M return
- high analyst rating
- high growth
- a minimum P/E
- a minimum price trend

A stock down 30–50% must still be eligible if the business is analyzable.

---

# Phase 3 — Improve quantitative scoring

The current model uses:

```text
Value      25%
Momentum   20%
Quality    20%
Sentiment  20%
Risk       15%
```

The intended direction is to reduce momentum's influence and improve valuation/quality.

A proposed starting architecture:

```text
Valuation             30%
Quality               25%
Growth                15%
Research/Catalysts    15%
Risk                  10%
Momentum               5%
```

This should remain tunable.

## 3.1 Add valuation metrics

Priority:

- Forward P/E
- P/E
- P/B where appropriate
- EV/EBITDA
- Free-cash-flow yield
- Earnings yield
- PEG where meaningful
- Sector-relative valuation
- Historical valuation vs the company's own range

## 3.2 Add growth metrics

- Revenue growth
- EPS growth
- Free-cash-flow growth
- Forward revenue / EPS estimate trend

## 3.3 Add quality metrics

- ROIC
- ROE
- Operating margin
- Margin trend
- FCF conversion
- Interest coverage
- Earnings consistency

## 3.4 Add balance-sheet metrics

- Net debt / EBITDA
- Debt/equity
- Cash position
- Current liquidity where appropriate
- Share dilution / share-count trend

## 3.5 Add market context

- 3M return
- 6M return
- 1Y return
- Relative strength vs S&P 500
- Distance from 52-week high

These are context, not hard gates.

---

# Phase 4 — Sector / peer-relative scoring

Do not treat all ratios as universally comparable.

Examples:

- Banks and utilities naturally carry different leverage than software firms.
- P/B is more informative in some industries than others.
- A P/E of 20 can be cheap in one sector and expensive in another.

Move toward:

```text
company metric
vs
industry / sector peers
```

and eventually:

```text
current company valuation
vs
its own 3–5 year historical range
```

This is one of the most important upgrades for finding real value.

---

# Phase 5 — Value Opportunity + Value Trap models

## 5.1 Value Opportunity Score

Goal:

> Find companies that are inexpensive but still fundamentally healthy.

Example components:

```text
Cheap vs peers                 25
Free-cash-flow strength        20
ROIC / profitability           15
Revenue/EPS stability          15
Manageable debt                10
Margin stability               10
Momentum/context                5
                              ---
                              100
```

A negative price trend should not automatically kill the score.

## 5.2 Value Trap Risk Score

Look for:

- Revenue deterioration
- EPS deterioration
- FCF deterioration
- Rising leverage
- Margin compression
- Repeated guidance cuts
- Analyst estimate cuts
- Share dilution
- Customer concentration/loss
- Lawsuits / regulatory threats
- Structural industry decline

Example output:

```text
Value Opportunity: 88
Value Trap Risk:    21
```

or:

```text
Value Opportunity: 71
Value Trap Risk:    84
```

---

# Phase 6 — Live research agent

The screener should have internet/research access through code that calls appropriate web/search APIs and directly uses public sources.

Do not deeply research every stock every day.

Target flow:

```text
500 stocks
   ↓
quantitative score
   ↓
top / unusual 30–50 candidates
   ↓
deep live research
```

Research sources should prioritize:

- SEC 10-K
- SEC 10-Q
- SEC 8-K
- Latest earnings release
- Company investor-relations page
- Earnings call / prepared remarks if available
- Reputable financial news
- Analyst estimate/revision data
- Insider transactions
- Major legal / regulatory events

Structured questions:

1. Why is the stock cheap / down?
2. Is revenue deteriorating?
3. Is EPS deteriorating?
4. Is FCF improving or worsening?
5. Are margins expanding or shrinking?
6. Has management changed guidance?
7. Are analysts raising or cutting estimates?
8. Is leverage becoming a problem?
9. What are the three biggest catalysts?
10. What are the three biggest risks?
11. Does the current valuation appear justified?
12. Is there evidence this is a temporary problem or a structural problem?

Store every research result with:

- source
- source URL
- date
- research timestamp
- confidence / completeness
- summary
- bull case
- bear case
- catalysts
- risks

---

# Phase 7 — Classification system

Keep A/B/C/D/F if useful, but add explanatory classifications:

- UNDERVALUED QUALITY
- UNDERVALUED / HIGH RISK
- POSSIBLE VALUE TRAP
- QUALITY AT FAIR VALUE
- GROWTH AT REASONABLE PRICE
- TURNAROUND CANDIDATE
- MOMENTUM LEADER
- EXPENSIVE QUALITY
- DISTRESSED

The classification should explain the type of opportunity, not just rank.

---

# Phase 8 — Change detection

Persist yesterday's output and compare it with today's.

Track:

- Overall score change
- Value score change
- Analyst revisions
- Estimate revisions
- News sentiment change
- New SEC filing
- New guidance
- New risk flag
- New catalyst
- Material valuation move

Example:

```text
NVDA

Overall score      78 → 84
Analyst score      78 → 84
News sentiment    .31 → .58

New:
- Analyst estimates raised
- New earnings release

Removed:
- Prior supply-risk flag
```

---

# Phase 9 — Morning dashboard

The 8 AM job should eventually produce something like:

```text
THE DESK — MORNING SCREEN

487 companies screened

5 new opportunities
3 major score changes
7 new catalysts
2 new risk flags

Top Value Opportunity
XYZ       91

Top Quality
ABC       94

Top Turnaround
DEF       86

Biggest Overnight Change
GHI       68 → 81
```

Then provide the full sortable table underneath.

---

# Phase 10 — Individual stock pages

Clicking a ticker should show:

```text
AAPL

Overall                 84
Valuation               72
Quality                 95
Growth                  88
Research                81
Risk                    79

Classification:
QUALITY AT REASONABLE PRICE

Why it ranks here
Valuation
Growth
Financial quality
Catalysts
Risks
Latest research
Recent score changes
Sources
```

Every research claim should retain a source.

---

# Phase 11 — Move to always-on infrastructure

Only after the local version is stable.

Target:

```text
Cloud/server
   ↓
scheduled jobs
   ↓
database/cache
   ↓
research pipeline
   ↓
dashboard
```

Benefits:

- Mac can be closed
- Reliable 8 AM runs
- Easier historical storage
- Dashboard accessible from phone/laptop
- Easier alerts and notifications

Do not move to cloud before the data model and cache are stable.
