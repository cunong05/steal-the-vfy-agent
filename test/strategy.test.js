// Checks for the Steal the VFY strategy + simulator. No network, no secrets.
// Run: npm test
// Game numbers are OFFICIAL (agentgames.zkverify.io/build):
//   FORTIFY cost 2, EXTRACT cap 10, FORTIFY blocks a flat 6 VFY.
// Shield timing (see steal/strategy.js): FORTIFY played on turn t sets
// fortifiedUntilTurn = t+1 — the shield is active during the NEXT turn's
// resolution, not the turn it is played.
"use strict";

const assert = require("node:assert");
const { decide, DEFAULT_PARAMS, isFortified, nextFortifiedUntilTurn, effectiveTake } = require("../steal/strategy");
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
  const r = resolveTurn({ balance: 100, fortified: false }, { balance: 100, fortified: false }, "EXTRACT", "HOLD", P);
  assert.strictEqual(r.a, 100 + P.EXTRACT_CAP);
  assert.strictEqual(r.b, 100 - P.EXTRACT_CAP);
}

// 5. Resolver: FORTIFY played THIS turn does not shield THIS turn's
// resolution (shield starts next turn) — but the fortifier pays the cost
// now and is shielded next turn.
{
  const r = resolveTurn({ balance: 100, fortified: false }, { balance: 100, fortified: false }, "EXTRACT", "FORTIFY", P);
  assert.strictEqual(r.a, 100 + P.EXTRACT_CAP, "extract takes full cap when no shield is active yet");
  assert.strictEqual(r.b, 100 - P.FORTIFY_COST - P.EXTRACT_CAP);
  assert.strictEqual(r.bFortifiedNext, true, "fortifier is shielded next turn");
  assert.strictEqual(r.aFortifiedNext, false);
}

// 5b. Resolver: an ACTIVE shield blocks a flat 6 VFY of the take.
{
  const r = resolveTurn({ balance: 100, fortified: false }, { balance: 100, fortified: true }, "EXTRACT", "HOLD", P);
  assert.strictEqual(r.a, 100 + (P.EXTRACT_CAP - P.FORTIFY_BLOCK));
  assert.strictEqual(r.b, 100 - (P.EXTRACT_CAP - P.FORTIFY_BLOCK));
}

// 5c. Resolver: shield blocks the whole take when the take is <= block.
{
  const r = resolveTurn({ balance: 100, fortified: false }, { balance: 5, fortified: true }, "EXTRACT", "HOLD", P);
  assert.strictEqual(r.a, 100, "take 5 fully blocked by 6");
  assert.strictEqual(r.b, 5);
}

// 6. Resolver: HOLD vs HOLD moves nothing.
{
  const r = resolveTurn({ balance: 100, fortified: false }, { balance: 100, fortified: false }, "HOLD", "HOLD", P);
  assert.strictEqual(r.a, 100);
  assert.strictEqual(r.b, 100);
}

// 6b. Shield helpers.
{
  assert.strictEqual(isFortified(6, 6), true);
  assert.strictEqual(isFortified(5, 6), false);
  assert.strictEqual(isFortified(null, 6), false);
  assert.strictEqual(nextFortifiedUntilTurn("FORTIFY", 7), 8);
  assert.strictEqual(nextFortifiedUntilTurn("EXTRACT", 7), null);
  assert.strictEqual(effectiveTake(10, 100, true, P), 4);
  assert.strictEqual(effectiveTake(10, 100, false, P), 10);
  assert.strictEqual(effectiveTake(10, 5, true, P), 0);
}

// 6c. Decide: fortified opponent still leaves a positive effective gain,
// so EXTRACT (declared amount stays the pre-shield take).
{
  const d = decide({ turn: 5, myBalance: 100, oppBalance: 100, oppFortifiedUntilTurn: 5 }, P);
  assert.strictEqual(d.action, "EXTRACT");
  assert.strictEqual(d.amount, P.EXTRACT_CAP, "declared amount is the pre-shield take");
}

// 6d. Decide: fortified opponent with a tiny balance => nothing to gain.
{
  const d = decide({ turn: 5, myBalance: 100, oppBalance: 5, oppFortifiedUntilTurn: 5 }, P);
  assert.strictEqual(d.action, "HOLD", "take 5 fully blocked => HOLD");
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

// 10b. Tracker reads FORTIFY from the envelope field directly.
{
  const { createTracker } = require("../steal/strategy");
  const t = createTracker(P);
  t.observe({ turn: 1, myBalance: 100, oppBalance: 100 });
  t.setMyAction("HOLD");
  const snap = t.observe({ turn: 2, myBalance: 100, oppBalance: 98, oppFortifiedUntilTurn: 2 });
  assert.strictEqual(snap.oppAction, "FORTIFY", "envelope fortify field => opponent FORTIFIED");
  assert.strictEqual(snap.oppFortifiedLast, true);
}

// 11. Policy beats always-HOLD even at the expensive-fortify grid point
// (cost=3, cap=10, block=9).
{
  const p2 = { ...P, FORTIFY_COST: 3, EXTRACT_CAP: 10, FORTIFY_BLOCK: 9 };
  const r = playMatch((s, pp, m) => decide(s, pp, m), baselines.alwaysHold, p2);
  assert.strictEqual(r, 1, "policy should beat always-HOLD at cost=3/cap=10/block=9");
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
