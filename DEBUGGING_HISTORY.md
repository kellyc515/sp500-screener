# Current Project Context and Debugging History

This file records the important work already completed so the next assistant does not repeat troubleshooting.

## Original state

The stock screener was a local Node.js project on macOS.

The data fetcher originally had 16 manually selected tickers.

It pulled from:

- Financial Modeling Prep (FMP)
- Finnhub

and wrote:

```text
companies.json
```

The scoring engine then generated:

```text
screener-report.html
```

---

## Automation work completed

A `run.sh` script was created to:

```text
export API keys
run node fetchData.js
run node screener.js
```

It was manually tested and worked.

A cron job was added for:

```text
8:00 AM Monday–Friday
```

A temporary scheduled test initially failed with:

```text
/bin/bash: /Users/kellycontreras/Desktop/Screener/run.sh: Operation not permitted
```

The cause was macOS privacy restrictions on cron accessing Desktop files.

Fix:

```text
System Settings
→ Privacy & Security
→ Full Disk Access
→ add /usr/sbin/cron
```

A second temporary test then ran successfully and `run.log` ended with:

```text
=== Done ===
```

The schedule was returned to 8 AM weekdays.

---

## Expansion from 16 to 50 stocks

The manually hard-coded ticker list was expanded to 50 names.

During editing, the file temporarily contained two `const TICKERS` declarations, causing:

```text
SyntaxError: Identifier 'TICKERS' has already been declared
```

The old 16-stock block was deleted and the duplicate declaration problem was fixed.

A 50-stock run then completed, but only a subset had full data and many later stocks scored 0 because API calls failed.

This revealed the API bottleneck.

---

## API-limit debugging

The fetcher was run with output redirected to:

```text
api-test.log
```

The log showed many:

```text
HTTP 429
```

A separate provider test was performed.

### FMP

Response:

```text
HTTP/2 429
```

with a message indicating the plan/account usage limit had been reached.

Conclusion:

> FMP quota was exhausted. This was not merely a per-second burst problem.

### Finnhub

Response:

```text
HTTP/2 200
x-ratelimit-limit: 60
x-ratelimit-remaining: 59
```

Conclusion:

> Finnhub was working.

---

## Retry-code debugging

A retrying `getJSON()` helper was added manually in Nano.

This caused brace/syntax problems during editing, including:

```text
SyntaxError: Unexpected token '}'
```

and later:

```text
SyntaxError: Unexpected end of input
```

Those syntax errors were repaired and:

```bash
node --check fetchData.js
```

eventually returned cleanly.

However, the conceptual issue remains:

> Retrying does not solve an exhausted plan quota.

The correct next step is cache/provider architecture, not more aggressive retrying.

---

## Current product discussion

The project direction changed from a small watchlist screener toward a real research engine.

The user wants:

- large universe
- no hard momentum gate
- strong ability to find undervalued companies
- value-trap detection
- live web research
- SEC / earnings / IR research
- analyst/news context
- score explanations
- morning brief
- change detection
- eventual cloud deployment

See the other handoff documents for the specification.
