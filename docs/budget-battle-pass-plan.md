# Budget Battle Pass — Feature Design Plan

## Concept

Instead of a single thermometer tracking "spent vs. budget," the month's
discretionary spending is broken into **sequential tiers** — stepping stones
laid out in a path. Each stone is a named spending category with a dollar
cap. You move through stones as you spend. The visual language is a battle
pass: locked ahead of you, active right now, completed behind you.

**Why this is better than a thermometer:**
- Forces you to decide *what kind* of spending comes first, not just *how much*
- Makes "I'm on stone 3 of 8" feel like progress rather than guilt
- Spending within a tier feels like unlocking the next reward, not depleting a pool

---

## Budget Pool

Each month's pass is seeded from the **previous month's net income**. You
configure this once per month (or the system pulls it from an income ingest).

```
July 2026 pass budget = June 2026 net income (manually entered or auto-read)
```

If income is variable (freelance, commissions), you can lock in a conservative
floor and adjust upward as income arrives — unlocking more tiers dynamically.

---

## Tier Structure

Each tier is an ordered stone on the path:

| Stone | Category | Amount | Tags |
|---|---|---|---|
| 1 | Restaurants | $20 | food, dining |
| 2 | Treats / Coffee | $30 | food, personal |
| 3 | Gifts | $50 | personal |
| 4 | Restaurants (round 2) | $40 | food, dining |
| 5 | Bankroll Goal | $100 | savings |
| 6 | Entertainment | $60 | personal |
| 7 | Misc / Buffer | $30 | misc |
| 8 | End Boss (big want) | $150 | reward |

Tiers are user-defined per month. You can save a default template that
carries over. Total of all tiers = X (your budget pool).

---

## Unlock Mechanic (choose one or combine)

Three models — pick what fits how Drake's income flows:

### A. Income-Triggered (recommended for variable income)
As money arrives (paycheck, transfer, side income), you "deposit" it into the
pass. Tiers unlock sequentially once the cumulative deposit covers them.

```
Deposit $200 → tiers 1-4 unlock (covers first $140, partial buffer on 5)
Deposit $150 more → tier 5 fully unlocks, tier 6 unlocks
```

Feels most like a real battle pass: tiers unlock in real time as you earn.

### B. Month-Start Lock-In (simpler, good for salaried income)
At the start of the month, set X from last month's income. All tiers visible
but only tier 1 is active. Completing (spending within) a tier unlocks the
next one.

Completion means: you hit the tier's budget or you explicitly "close" it.
Unspent balance from a tier rolls into a "carry pool" (optional).

### C. Calendar-Paced
Tiers unlock on a weekly cadence regardless of spending:
- Week 1: tiers 1-2 active
- Week 2: tiers 3-4 active
- Etc.

Simplest to implement, least gamified.

**Recommendation**: Start with **B** (month-start lock-in). Add **A** later
once an income-ingest endpoint exists.

---

## Visual Design — The Path

```
[✓] ──── [✓] ──── [●] ──── [○] ──── [○] ──── [○] ──── [🔒] ──── [🔒]
Rest     Treats  Gifts*   Rest2   Bankroll   Enter   Misc    End Boss
$20      $30     $50      $40     $100       $60     $30     $150
spent    spent   active   locked...
```

Stone states:
- **Completed** `✓` — spent within cap, next tier unlocked
- **Active** `●` — current spending tier, pulsing/highlighted
- **Queued** `○` — visible but spending not yet allowed
- **Locked** `🔒` — beyond current income deposit (only in mode A)

Mobile layout: stones wrap into a winding path (S-curve), not a horizontal
line that goes off-screen.

Each stone taps open a mini-panel:
- Category name + remaining balance (`$32 of $50 left`)
- Recent transactions tagged to this category
- "Close this tier" button (explicitly moves to next)

---

## Data Model

New block types on the existing `blocks` table:

### `budget_pass` block
One per month, parented to the day root or a workspace root.

```json
{
  "type": "budget_pass",
  "properties": {
    "month": "2026-07",
    "pool": 680,
    "income_source": "manual",
    "income_deposited": 500,
    "status": "active",
    "template_id": "default",
    "created_at": "2026-07-01T00:00:00Z"
  }
}
```

### `budget_tier` block
One per stone, parented to a `budget_pass`.

```json
{
  "type": "budget_tier",
  "sort_order": 3,
  "properties": {
    "title": "Gifts",
    "category": "gifts",
    "cap": 50,
    "spent": 32,
    "status": "active",
    "tags": ["personal"],
    "unlocked_at": "2026-07-01T00:00:00Z",
    "completed_at": null
  }
}
```

### `budget_transaction` block (optional — could reuse existing blocks)
Tagged spending events that increment a tier's `spent`.

```json
{
  "type": "budget_transaction",
  "properties": {
    "tier_id": "<block_id>",
    "amount": 18,
    "note": "Amazon birthday gift",
    "date": "2026-07-03"
  }
}
```

---

## API Surface

All endpoints are bearer-token auth (same as existing quick-task pattern).

```
GET  /api/budget/pass?month=2026-07
     → { pass, tiers[] }

POST /api/budget/pass
     → create pass for month; body: { month, pool, tiers: [...] }

PATCH /api/budget/pass/:id/deposit
     → body: { amount } — adds to income_deposited, unlocks tiers (mode A)

PATCH /api/budget/tier/:id/spend
     → body: { amount, note } — adds a transaction, updates spent

PATCH /api/budget/tier/:id/complete
     → marks tier complete, unlocks next

GET  /api/budget/templates
POST /api/budget/templates        → save tier layout as reusable template
```

---

## Frontend Component

Lives in `public/js/budget-pass.js`. Rendered in a new section of `index.html`
(or a dedicated `/budget` route if it gets big).

Key UI states:
1. **No pass this month** → "Set up your July budget" CTA
2. **Pass active** → path of stones, current tier expanded
3. **Pass complete** → celebration state, summary of how you did, rollover prompt

Use the same design tokens as the rest of the DCC. Stones are SVG circles or
CSS `border-radius: 50%` divs with a connecting line (CSS `border-top` or
an SVG polyline behind them).

Animation: completing a tier triggers the same satisfying "tick" animation
already used for task completion.

---

## Integration with Existing DCC Systems

| System | How it connects |
|---|---|
| Slot rewards | Completing a tier awards a slot spin (hooks into `slot-store.js`) |
| Points | Each tier completion = points (hooks into evaluation/scoring) |
| Punishments | Going over a tier cap could trigger a punishment block |
| Quick-task | Log "spent $18 on gift" as a task *and* a budget transaction at once |
| Blocks API | Everything is a block — pass and tiers query the same `/api/blocks` endpoint with type filter |

---

## Implementation Phases

### Phase 1 — Core (MVP)
- `budget_pass` and `budget_tier` block types in `pg-schema.js`
- Basic CRUD API endpoints
- Frontend path component with stone states
- Manual spend logging via the "spend" endpoint

### Phase 2 — Polish
- Templates (save/load a tier layout)
- Carry-over pool (unspent tier balance rolls to next)
- Mobile-friendly winding path layout
- Slot spin reward on tier completion

### Phase 3 — Automation
- Income ingest endpoint for mode A (income-triggered unlocks)
- Link to bank transaction feed if Drake adds one
- Claude can log spending directly: "I spent $18 on a gift" → hits `/api/budget/tier/:id/spend`

---

## Open Questions for Drake

1. **Unlock mechanic**: month-start lock-in (simple) or income-triggered (dynamic)?
2. **Carry-over**: if you spend only $15 of a $20 restaurant tier, does the $5 go to a free pool, roll to the next same-category tier, or disappear?
3. **Over-budget behavior**: does going over a tier just lock the next one, or is it punishable?
4. **Where on the page**: separate `/budget` route, or a panel on the main DCC dashboard?
5. **Template persistence**: one default template, or multiple named configs (e.g., "lean month" vs. "normal month")?
