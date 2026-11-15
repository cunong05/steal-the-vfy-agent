// Checks for the Steal the VFY strategy + simulator. No network, no secrets.
// Run: npm test
"use strict";

const assert = require("node:assert");
const { decide, DEFAULT_PARAMS } = require("../steal/strategy");
const { resolveTurn, playMatch, baselines } = require("../steal/simulator");

const P = { ...DEFAULT_PARAMS };

// 1. Against an unfortified opponent with exposed balance, EXTRACT wins over HOLD.
{
  const d = decide({ turn: 1, myBalance: 100, oppBalance: 100 }, P);
  assert.strictEqual(d.action, "EXTRACT", "turn 1 vs 100/100 should EXTRACT");
  assert.ok(d.amount > 0 && d.amount <= P.EXTRACT_CAP, "EXTRACT amount within cap");
}

// 2. Nothing to extract + fortify loses money => HOLD.
{
  const d = decide({ turn: 1, myBalance: 100, oppBalance: 0 }, { ...P, FORTIFY_COST: 100 });
  assert.strictEqual(d.action, "HOLD", "opp 0 + fortify too expensive should HOLD");
}

// 3. Big lead late + opponent extracting => FORTIFY.
{
  const mem = { oppExtractedLast: true, oppFortifiedLast: false };
  const d = decide({ turn: 18, myBalance: 150, oppBalance: 50 }, P, mem);
  assert.strictEqual(d.action, "FORTIFY", "big lead late + opp extracting should FORTIFY");
}

// 3b. Same position but opponent NOT extracting => keep EXTRACTING (fortify
// would just burn the cost).
{
  const mem = { oppExtractedLast: false, oppFortifiedLast: false };
  const d = decide({ turn: 18, myBalance: 150, oppBalance: 50 }, P, mem);
  assert.strictEqual(d.action, "EXTRACT", "big lead late + opp holding should EXTRACT");
}

// 4. Resolver: EXTRACT vs HOLD moves the cap from the exposed balance.
{
  const [a, b] = resolveTurn({ balance: 100 }, { balance: 100 }, "EXTRACT", "HOLD", P);
  assert.strictEqual(a, 100 + P.EXTRACT_CAP);
  assert.strictEqual(b, 100 - P.EXTRACT_CAP);
}

// 5. Resolver: FORTIFY blocks part of the extraction and pays the cost.
{
  const [a, b] = resolveTurn({ balance: 100 }, { balance: 100 }, "EXTRACT", "FORTIFY", P);
  const shielded = 100 * P.PROTECTED_FRACTION;
  const take = Math.min(P.EXTRACT_CAP, 100 - shielded);
  assert.strictEqual(a, 100 + take);
  assert.strictEqual(b, 100 - P.FORTIFY_COST - take);
}

// 6. Resolver: HOLD vs HOLD moves nothing.
{
  const [a, b] = resolveTurn({ balance: 100 }, { balance: 100 }, "HOLD", "HOLD", P);
  assert.strictEqual(a, 100);
  assert.strictEqual(b, 100);
}

// 7. Self-play determinism: same policies, same result twice.
{
  const r1 = playMatch((s) => decide(s, P), baselines.alwaysExtract, P);
  const r2 = playMatch((s) => decide(s, P), baselines.alwaysExtract, P);
  assert.strictEqual(r1, r2, "self-play must be deterministic");
}

// 8. Our policy beats always-HOLD on the default grid point (extracts free value).
{
  const r = playMatch((s, pp, m) => decide(s, pp, m), baselines.alwaysHold, P);
  assert.strictEqual(r, 1, "policy should beat always-HOLD");
}

// 9. Tracker infers EXTRACT: we hold, our balance drops by the cap.
{
  const { createTracker } = require("../steal/strategy");
  const t = createTracker(P);
  t.observe({ turn: 1, myBalance: 100, oppBalance: 100 });
  t.setMyAction("HOLD");
  const snap = t.observe({ turn: 2, myBalance: 100 - P.EXTRACT_CAP, oppBalance: 100 + P.EXTRACT_CAP });
  assert.strictEqual(snap.oppAction, "EXTRACT", "tracker should infer opponent EXTRACT");
  assert.strictEqual(snap.oppExtractedLast, true);
}

// 10. Tracker infers HOLD: we hold, nothing moves.
{
  const { createTracker } = require("../steal/strategy");
  const t = createTracker(P);
  t.observe({ turn: 1, myBalance: 100, oppBalance: 100 });
  t.setMyAction("HOLD");
  const snap = t.observe({ turn: 2, myBalance: 100, oppBalance: 100 });
  assert.strictEqual(snap.oppAction, "HOLD", "tracker should infer opponent HOLD");
}

// 11. Policy beats always-HOLD even at the expensive-fortify grid point
// (cost=5, cap=10, frac=0.75) — the old unconditional-fortify rule drew here.
{
  const p2 = { ...P, FORTIFY_COST: 5, EXTRACT_CAP: 10, PROTECTED_FRACTION: 0.75 };
  const r = playMatch((s, pp, m) => decide(s, pp, m), baselines.alwaysHold, p2);
  assert.strictEqual(r, 1, "policy should beat always-HOLD at cost=5/cap=10/frac=0.75");
}

// 12. Policy never loses to always-extract (mirror draws) across the grid.
{
  const { grid } = require("../steal/simulator");
  for (const p of grid()) {
    const r = playMatch((s, pp, m) => decide(s, pp, m), baselines.alwaysExtract, p);
    assert.ok(r >= 0, `policy should not lose to always-extract at ${JSON.stringify(p)}`);
  }
}

console.log("all strategy tests passed");
