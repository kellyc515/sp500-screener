# Paste This Into Claude

I am continuing an existing local Node.js stock-screener project. I am attaching a handoff folder that contains:

- README.md
- ROADMAP.md
- SCORING_AND_RESEARCH_SPEC.md
- CLAUDE_NEXT_STEPS.md
- DEBUGGING_HISTORY.md
- CURRENT_fetchData.js
- CURRENT_screener.js

Please read all of those before proposing code changes.

My priorities are:

1. Preserve potentially undervalued / beaten-down stocks. Do not use positive momentum as a hard eligibility filter.
2. Stabilize the current data-fetch architecture before adding major features.
3. Add caching so a failed API request never overwrites valid old data with null/zero.
4. Clean the current fetcher and verify that every function used in `main()` exists.
5. Handle FMP quota exhaustion intelligently instead of endlessly retrying 429s.
6. Keep Finnhub where useful, but design provider adapters so FMP can be reduced or replaced.
7. Eventually expand from a manually hard-coded 50-stock universe to an automatically maintained S&P 500 universe.
8. Improve scoring toward valuation, quality, growth, research/catalysts, risk, and only a small momentum weight.
9. Add a Value Opportunity Score and a separate Value Trap Risk Score.
10. Eventually add live research using SEC filings, earnings releases, investor-relations material, reputable news, analyst revisions, insider activity, and material legal/regulatory developments.
11. Require sources/timestamps for qualitative research.
12. Add change detection, a morning brief, per-stock detail pages, and later migrate to an always-on server.

Please start with the immediate engineering task in CLAUDE_NEXT_STEPS.md: clean and harden the fetch/storage layer without breaking the existing `screener.js` output contract.

Before writing code, summarize what you found in the current files and tell me the exact files you intend to change. Then provide clean replacement files rather than asking me to make many fragile Nano edits.
