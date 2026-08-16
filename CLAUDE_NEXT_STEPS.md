# Claude Handoff — Exact Next Steps

## Read first

Before editing anything, inspect:

```text
CURRENT_fetchData.js
CURRENT_screener.js
README.md
ROADMAP.md
SCORING_AND_RESEARCH_SPEC.md
```

The user wants to continue from the current local Node.js project rather than rebuild from zero.

---

# Immediate objective

Do **not** jump straight to web research or a 500-stock universe.

The immediate engineering objective is:

> make the existing fetch/storage layer reliable, cached, and safe under API failure.

Once that is stable, expand the universe and scoring.

---

# Step 1 — Repair current source

Inspect `CURRENT_fetchData.js`.

Known issue:

- duplicate `getJSON()` functions exist
- `main()` calls `fmpRatios(sym)`; verify the function exists in the actual working copy and restore it if missing
- FMP quota exhaustion currently produces 429
- Finnhub currently works

Create a clean `fetchData.js` rather than continuing piecemeal Nano edits.

Preserve current output fields used by `screener.js`:

```js
{
  ticker,
  name,
  sector,
  pe,
  pb,
  ret3m,
  ret6m,
  roe,
  debtEquity,
  sentiment,
  analyst,
  beta
}
```

Do not break `screener.js` while improving the fetcher.

---

# Step 2 — Add cache

Implement cache-first behavior.

Suggested minimum:

```text
cache/fundamentals.json
cache/market.json
cache/analyst.json
cache/news.json
```

Pseudo-logic:

```text
load cache

for each ticker:
    if field is fresh:
        use cache
    else:
        attempt provider request
        if success:
            update cache
        if failure:
            use last valid cached value

write cache safely
build companies.json from best available values
```

Use atomic writes where practical:

```text
write temp file
rename temp file
```

so an interrupted process does not corrupt the cache.

---

# Step 3 — Improve request handling

The request helper should distinguish:

### Successful

```text
200
```

### Authentication

```text
401 / 403
```

Stop/reject clearly.

### Temporary rate limit

```text
429 with Retry-After or clear short-window behavior
```

Use backoff.

### Account / daily quota exhaustion

If the response body says the plan limit is reached, do not wait 65 seconds over and over.

Mark the provider unavailable for the remainder of the run and fall back to cache.

---

# Step 4 — Protect `run.sh`

Change `run.sh` so failed data collection does not silently continue.

Suggested:

```bash
#!/bin/bash
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

# Load secrets from preferred location.
cd "$(dirname "$0")"

echo "=== Run started: $(date) ==="
node fetchData.js
node screener.js
echo "=== Done ==="
```

If using `.env`, load it safely or use a Node dotenv package.

Important: rotate the keys that were exposed in screenshots.

---

# Step 5 — Keep current cron schedule

Current desired schedule:

```cron
0 8 * * 1-5 /Users/kellycontreras/Desktop/Screener/run.sh >> /Users/kellycontreras/Desktop/Screener/run.log 2>&1
```

Cron already has Full Disk Access and was successfully tested.

Do not change this unless required by a later server migration.

---

# Step 6 — After cache works, replace FMP dependency strategically

Do not assume one new provider has to supply everything.

Recommended architecture:

```text
Prices / returns           → market-data provider
Analyst recommendations    → Finnhub
News                       → Finnhub + research layer
Financial statements       → SEC / fundamentals provider
Deep research              → SEC / IR / reputable web
```

Prioritize reliability and provenance.

Use provider adapters so sources can be swapped without rewriting the scorer.

Example:

```text
providers/
  marketData.js
  finnhub.js
  sec.js
  fundamentals.js
```

---

# Step 7 — Expand universe

After request/cache reliability is proven:

1. create `universe.json`
2. populate it automatically with S&P 500 constituents
3. keep metadata such as ticker, company, sector, exchange
4. later expand beyond S&P 500 if desired

Do not use momentum as an eligibility gate.

---

# Step 8 — Upgrade scoring

Maintain backward compatibility first, then add fields.

Target buckets:

```text
Valuation             30%
Quality               25%
Growth                15%
Research/Catalysts    15%
Risk                  10%
Momentum               5%
```

Add:

```text
forwardPE
evEbitda
fcfYield
revenueGrowth
epsGrowth
fcfGrowth
roic
operatingMargin
marginTrend
netDebtEbitda
shareCountGrowth
return1y
relativeStrength
distanceFrom52WeekHigh
```

Implement sector/peer-relative scoring for appropriate valuation metrics.

---

# Step 9 — Add Value Opportunity / Value Trap models

Create separate fields:

```js
valueOpportunityScore
valueTrapRiskScore
classification
```

Do not merge everything into one opaque number.

The user specifically wants to preserve beaten-down potential value names.

---

# Step 10 — Add deep live research

After quantitative scoring works across a large universe, research only selected candidates.

Prioritize:

- top value opportunity
- top overall
- biggest change
- high opportunity + high trap risk
- large price decline + healthy fundamentals
- major new event

Research:

- latest SEC filings
- earnings release
- guidance
- IR material
- reputable recent news
- analyst estimate revisions
- insider activity
- legal/regulatory developments

Require sources and timestamps.

---

# Step 11 — Add dashboard features

The existing `screener.js` already writes a sortable HTML table.

Evolve it into:

```text
Morning brief
Top opportunities
New opportunities
Largest score changes
Value candidates
Possible value traps
New catalysts
New risk flags
Full sortable universe
```

Then add per-stock detail pages.

---

# Step 12 — Add history and change detection

Persist daily snapshots.

Suggested:

```text
history/YYYY-MM-DD.json
```

Compare current vs previous trading day.

Track score/rank/classification/catalyst/risk changes.

---

# Step 13 — Cloud migration last

Do not move to a cloud server until:

- cache is stable
- provider adapters are stable
- large-universe run works
- report works
- secrets are secure

Then move scheduling to a server so the Mac no longer has to be awake.

---

# User preferences / constraints to preserve

1. Do not filter out undervalued companies just because momentum is negative.
2. Momentum should be a small factor, not a gate.
3. The system should help distinguish value from value traps.
4. The user wants live internet research eventually.
5. Deep research should focus on interesting candidates, not blindly browse every stock.
6. The system should automatically update in the morning.
7. The system should eventually run without the Mac being open.
8. Explanations and sources matter; do not return only an unexplained score.
9. Missing API data should never be treated as an actual zero.
10. Build incrementally; preserve the working screener while improving the architecture.
