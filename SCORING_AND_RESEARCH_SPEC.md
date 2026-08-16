# Scoring, Research, and Product Specification

## Guiding principle

The system should not optimize for stocks that have already performed well.

It should identify **interesting investment research candidates**, including companies whose stock prices have fallen but whose underlying economics remain healthy.

Negative momentum is information, not automatic disqualification.

---

# 1. Eligibility

Eligibility is intentionally permissive.

A stock can proceed if:

- it is an eligible common equity
- it meets chosen liquidity requirements
- it has enough financial information to analyze

A stock should **not** be eliminated because:

- price is down
- analyst sentiment is poor
- P/E is low
- recent earnings were weak
- it is currently unpopular

Those factors belong in scoring/research.

---

# 2. Quantitative score

Proposed initial weights:

```text
Valuation             30
Quality               25
Growth                15
Research/Catalysts    15
Risk                  10
Momentum               5
                     ---
                     100
```

This is a starting point, not a permanent formula.

## Valuation

Possible fields:

- Forward P/E
- Trailing P/E
- EV/EBITDA
- FCF yield
- Earnings yield
- P/B when sector-appropriate
- PEG
- Discount/premium vs sector
- Discount/premium vs historical valuation

Avoid simplistic rules such as:

```text
lower P/E = always better
```

A low valuation can signal genuine value or deteriorating fundamentals.

## Quality

- ROIC
- ROE
- Operating margin
- Margin trend
- FCF conversion
- Interest coverage
- Earnings consistency
- Debt / leverage

## Growth

- Revenue growth
- EPS growth
- FCF growth
- Forward estimate revisions
- Guidance trend

## Research / Catalysts

- Earnings quality
- Guidance change
- Analyst estimate revisions
- New product / contract / strategic catalyst
- Industry improvement
- Insider activity
- Material SEC filing
- Major news

## Risk

- Leverage
- Beta / volatility
- Concentration risks
- Regulatory/litigation risk
- Deteriorating fundamentals
- Dilution
- Cyclicality

## Momentum

- 3M return
- 6M return
- 1Y return
- Relative strength vs S&P 500

Low momentum should contribute a modest penalty/context, not exclusion.

---

# 3. Value Opportunity Score

Purpose:

> detect "cheap + healthy" rather than merely "cheap."

Suggested prototype:

```text
Relative valuation              25
FCF strength / FCF yield        20
ROIC / profitability            15
Revenue/EPS stability           15
Balance-sheet strength          10
Margin stability                10
Price/momentum context           5
                               ---
                               100
```

Interpretation example:

```text
85–100  Strong value candidate
70–84   Worth deeper research
50–69   Mixed
<50     Weak value setup
```

Do not treat these bands as investment recommendations.

---

# 4. Value Trap Risk Score

Purpose:

> detect reasons a low valuation may be deserved.

Possible inputs:

- declining revenue
- declining EPS
- falling FCF
- falling margins
- rising debt
- weakening interest coverage
- repeated guidance cuts
- negative estimate revisions
- customer loss
- dilution
- major litigation
- structural competitive loss
- regulatory threat

High trap risk can coexist with high value opportunity.

Example:

```text
Value Opportunity    82
Value Trap Risk      77
```

This is an interesting but dangerous situation and should trigger deeper research rather than automatic rejection.

---

# 5. Classification

Possible labels:

### UNDERVALUED QUALITY

Cheap relative to peers/history while business quality remains strong.

### UNDERVALUED / HIGH RISK

Cheap but meaningful financial/operational risk exists.

### POSSIBLE VALUE TRAP

Valuation is low and fundamentals/revisions are deteriorating.

### TURNAROUND CANDIDATE

Recent weakness exists, but evidence suggests operating improvement.

### QUALITY AT FAIR VALUE

Excellent business but not obviously discounted.

### GROWTH AT REASONABLE PRICE

Strong growth without extreme valuation.

### EXPENSIVE QUALITY

Strong company but valuation materially above peers/history.

### MOMENTUM LEADER

Strong market performance and improving fundamentals.

### DISTRESSED

Material solvency, liquidity, operating, or legal risk.

---

# 6. Live research output

For every deeply researched candidate, produce structured data rather than an unstructured paragraph.

Example schema:

```json
{
  "ticker": "XYZ",
  "researchedAt": "ISO timestamp",
  "researchScore": 84,
  "classification": "UNDERVALUED QUALITY",
  "whyCheap": "Short explanation",
  "businessTrend": "improving | stable | deteriorating | mixed",
  "guidanceTrend": "raised | maintained | cut | unavailable",
  "estimateTrend": "rising | flat | falling | unavailable",
  "bullCase": [
    "..."
  ],
  "bearCase": [
    "..."
  ],
  "catalysts": [
    "..."
  ],
  "risks": [
    "..."
  ],
  "sources": [
    {
      "title": "...",
      "url": "...",
      "date": "...",
      "type": "SEC | earnings | IR | news | analyst"
    }
  ]
}
```

---

# 7. Research prioritization

Do not browse every company equally.

Deep-research candidates may include:

- top overall score
- top value-opportunity score
- biggest daily score improvement
- high value score + high trap risk
- large price decline with healthy fundamentals
- major new filing/event
- analyst estimate inflection
- new guidance change

This preserves the ability to discover beaten-down companies.

---

# 8. Freshness metadata

Every field should eventually have provenance/freshness.

Example:

```json
"pe": {
  "value": 14.2,
  "source": "provider",
  "updatedAt": "2026-08-10T08:00:00-05:00"
}
```

At minimum maintain source/update metadata internally even if `companies.json` stays flat for compatibility.

The UI should be able to indicate:

- current
- stale
- unavailable
- cached

---

# 9. Missing-data policy

Never convert missing data into a real zero.

Bad:

```json
"analyst": 0
```

when the API actually failed.

Good:

```json
"analyst": null
```

with cache fallback if a valid older value exists.

A zero must mean the actual metric is zero.

The current scoring engine already skips null metric values. Preserve that behavior.

---

# 10. Historical/change data

Store enough history to calculate:

- score today vs yesterday
- ranking today vs yesterday
- score 7 days ago
- new/removed risks
- new/removed catalysts
- analyst revision change
- valuation change
- research classification change

This is central to the future morning brief.
