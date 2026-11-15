// Checks for the Steal the VFY circuit policy + simulator. No network,
// no secrets. Run: npm test
// Game numbers are OFFICIAL (agentgames.zkverify.io/build):
//   FORTIFY cost 2, EXTRACT cap 10, FORTIFY blocks a flat 6 VFY.
// Policy is the CIRCUIT policy (verified 16 Nov 2026 —
// hidden_files/line75-probe-results.md):
//   self < p1 -> FORTIFY; p3==1 or opp <= p2 -> HOLD; else EXTRACT p0.
//   p4..p7 = 0, 1 <= p0 <= 10, p3 in {0,1}.
// Shield timing (see steal/strategy.js): FORTIFY played on turn t sets
// fortifiedUntilTurn = t+1 — the shield is active during the NEXT turn's
// resolution, not the turn it is played.
"use strict";

const assert = require("node:assert");
const {
  decide,
  circuitPolicyDecision,
  validateCircuitParams,
  DEFAULT_PARAMS,
  isFortified,
  nextFortifiedUntilTurn,
  effectiveTake,
} = require("../steal/strategy");
const { resolveTurn, playMatch, baselines } = require("../steal/simulator");

const AGGRESSIVE = [10, 0, 0, 0, 0, 0, 0, 0];
const MODERATE = [2, 10, 6, 0, 0, 0, 0, 0];

// 1. Aggressive params: 100/100 -> EXTRACT 10.
{
  const d = decide({ turn: 1, myBalance: 100, oppBalance: 100 }, AGGRESSIVE);
  assert.strictEqual(d.action, "EXTRACT");
  assert.strictEqual(d.amount, 10, "EXTRACT amount must equal p0 exactly");
}

// 2. Aggressive params: opp 0 -> HOLD (nothing to take), no amount field.
{
  const d = decide({ turn: 1, myBalance: 100, oppBalance: 0 }, AGGRESSIVE);
  assert.strictEqual(d.action, "HOLD");
  assert.strictEqual(d.amount, undefined, "HOLD must not carry amount");
}

// 3. Aggressive params: self 0 still EXTRACTs (p1=0; verified by probe:
// turn 3, 0/100 -> EXTRACT 10 PROOF OK).
{
  const d = decide({ turn: 3, myBalance: 0, oppBalance: 100 }, AGGRESSIVE);
  assert.strictEqual(d.action, "EXTRACT");
  assert.strictEqual(d.amount, 10);
}

// 4. Aggressive params: opp 1 -> EXTRACT 10 (amount is p0 even when
// opp < p0; probe: turn 3, 100/1 -> EXTRACT 10 PROOF OK).
{
  const d = decide({ turn: 3, myBalance: 100, oppBalance: 1 }, AGGRESSIVE);
  assert.strictEqual(d.action, "EXTRACT");
  assert.strictEqual(d.amount, 10);
}

// 5. Moderate params: 95/105 -> EXTRACT 2 (probe's first passing proof).
{
  const d = decide({ turn: 3, myBalance: 95, oppBalance: 105 }, MODERATE);
  assert.strictEqual(d.action, "EXTRACT");
  assert.strictEqual(d.amount, 2);
}

// 6. Moderate params: self 5 < p1=10 -> FORTIFY, no amount field.
{
  const d = decide({ turn: 3, myBalance: 5, oppBalance: 105 }, MODERATE);
  assert.strictEqual(d.action, "FORTIFY");
  assert.strictEqual(d.amount, undefined, "FORTIFY must not carry amount");
}

// 7. Moderate params: opp 5 <= p2=6 -> HOLD; opp 7 -> EXTRACT 2.
{
  assert.strictEqual(decide({ turn: 3, myBalance: 100, oppBalance: 5 }, MODERATE).action, "HOLD");
  assert.strictEqual(decide({ turn: 3, myBalance: 100, oppBalance: 6 }, MODERATE).action, "HOLD");
  const d = decide({ turn: 3, myBalance: 100, oppBalance: 7 }, MODERATE);
  assert.strictEqual(d.action, "EXTRACT");
  assert.strictEqual(d.amount, 2);
}

// 8. Passive mode p3=1: always HOLD (except self < p1 -> FORTIFY).
{
  const passive = [2, 10, 6, 1, 0, 0, 0, 0];
  assert.strictEqual(decide({ turn: 3, myBalance: 95, oppBalance: 105 }, passive).action, "HOLD");
  assert.strictEqual(decide({ turn: 3, myBalance: 5, oppBalance: 105 }, passive).action, "FORTIFY");
}

// 9. Policy does not depend on turn: same balances, different turns.
{
  const a = circuitPolicyDecision({ turn: 1, myBalance: 95, oppBalance: 105 }, MODERATE);
  const b = circuitPolicyDecision({ turn: 20, myBalance: 95, oppBalance: 105 }, MODERATE);
  assert.deepStrictEqual(a, b);
}

// 10. Validation rejects what the circuit rejects.
{
  assert.throws(() => validateCircuitParams([2, 10, 6, 5, 15, 1, 100, 20]), /0/);
  assert.throws(() => validateCircuitParams([0, 0, 0, 0, 0, 0, 0, 0]), /1\.\.10/);
  assert.throws(() => validateCircuitParams([11, 0, 0, 0, 0, 0, 0, 0]), /1\.\.10/);
  assert.throws(() => validateCircuitParams([2, 10, 6, 2, 0, 0, 0, 0]), /0 or 1/);
  assert.throws(() => validateCircuitParams([2, 10, 6]), /8 numbers/);
  assert.doesNotThrow(() => validateCircuitParams(AGGRESSIVE));
  assert.doesNotThrow(() => validateCircuitParams(MODERATE));
}

// 11. decide() with no params arg reads STEAL_STRATEGY_PARAMS from env.
{
  process.env.STEAL_STRATEGY_PARAMS = "10,0,0,0,0,0,0,0";
  const d = decide({ turn: 1, myBalance: 100, oppBalance: 100 });
  assert.strictEqual(d.action, "EXTRACT");
  assert.strictEqual(d.amount, 10);
}

// 12. Resolver: EXTRACT vs HOLD moves the cap from the exposed balance.
{
  const P = { ...DEFAULT_PARAMS };
  const r = resolveTurn({ balance: 100, fortified: false }, { balance: 100, fortified: false }, "EXTRACT", "HOLD", P);
  assert.strictEqual(r.a, 100 + P.EXTRACT_CAP);
  assert.strictEqual(r.b, 100 - P.EXTRACT_CAP);
}

// 13. Resolver: FORTIFY played THIS turn does not shield THIS turn's
// resolution (shield starts next turn) — but the fortifier pays the cost
// now and is shielded next turn.
{
  const P = { ...DEFAULT_PARAMS };
  const r = resolveTurn({ balance: 100, fortified: false }, { balance: 100, fortified: false }, "EXTRACT", "FORTIFY", P);
  assert.strictEqual(r.a, 100 + P.EXTRACT_CAP, "extract takes full cap when no shield is active yet");
  assert.strictEqual(r.b, 100 - P.FORTIFY_COST - P.EXTRACT_CAP);
  assert.strictEqual(r.bFortifiedNext, true, "fortifier is shielded next turn");
  assert.strictEqual(r.aFortifiedNext, false);
}

// 14. Simulator: aggressive policy beats alwaysHold / alwaysFortify.
{
  const P = { ...DEFAULT_PARAMS };
  const policy = (s, pp, m) => decide(s, AGGRESSIVE, m);
  assert.strictEqual(playMatch(policy, baselines.alwaysHold, P), 1);
  assert.strictEqual(playMatch(policy, baselines.alwaysFortify, P), 1);
}

console.log("strategy tests: all passed");
