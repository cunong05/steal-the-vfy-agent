// Self-play simulator for Steal the VFY + policy calibration.
//
// Resolver model, from the official event page ("simultaneous submission,
// deterministic resolver", "uses prior public state only"):
//   - Both actions resolve against the PRIOR exposed balances.
//   - EXTRACT vs HOLD: extractor takes up to the cap from the opponent's
//     exposed balance.
//   - EXTRACT vs FORTIFY: the defender's shield reduces/blocks the
//     extraction; the defender pays the fortify cost.
//   - EXTRACT vs EXTRACT: both resolve against prior exposed balances.
//   - FORTIFY vs HOLD: fortifier pays the cost; nothing else moves.
//   - FORTIFY vs FORTIFY: both pay the cost; no transfer.
//   - HOLD vs HOLD: nothing moves.
//
// A fortify shields PROTECTED_FRACTION of the fortifier's balance for the
// NEXT resolution (the turn it is played in). Shielded balance cannot be
// extracted that turn.
//
// Usage:
//   node steal/simulator.js            -> plays the default policy against
//                                          baselines across a parameter grid
//                                          and prints win rates.
//   node steal/simulator.js calibrate  -> grid-searches the policy knobs
//                                          for the most robust setting.
//
// The game numbers are parameters because they are not published on the
// public pages. When practice turns reveal the real numbers, run the
// calibration with those exact values and paste the winning knobs into
// strategy.js / .env.
"use strict";

const { decide, createTracker, DEFAULT_PARAMS } = require("./strategy");

function resolveTurn(a, b, myAction, oppAction, p) {
  // a, b: { balance, fortified } — prior public state.
  // Returns new balances [aBalance, bBalance].
  let na = a.balance;
  let nb = b.balance;
  const aShielded = myAction === "FORTIFY" ? a.balance * p.PROTECTED_FRACTION : 0;
  const bShielded = oppAction === "FORTIFY" ? b.balance * p.PROTECTED_FRACTION : 0;
  const aExposed = a.balance - aShielded;
  const bExposed = b.balance - bShielded;

  if (myAction === "FORTIFY") na -= p.FORTIFY_COST;
  if (oppAction === "FORTIFY") nb -= p.FORTIFY_COST;

  if (myAction === "EXTRACT") {
    const take = Math.min(p.EXTRACT_CAP, Math.max(0, bExposed));
    na += take;
    nb -= take;
  }
  if (oppAction === "EXTRACT") {
    const take = Math.min(p.EXTRACT_CAP, Math.max(0, aExposed));
    nb += take;
    na -= take;
  }
  return [na, nb];
}

function playMatch(policyA, policyB, p, turns = 20) {
  let a = 100;
  let b = 100;
  const ta = createTracker(p);
  const tb = createTracker(p);
  for (let t = 1; t <= turns; t++) {
    const sa = { turn: t, myBalance: a, oppBalance: b };
    const sb = { turn: t, myBalance: b, oppBalance: a };
    ta.observe(sa);
    tb.observe(sb);
    const aa = policyA(sa, p, ta.snapshot()).action;
    const ab = policyB(sb, p, tb.snapshot()).action;
    ta.setMyAction(aa);
    tb.setMyAction(ab);
    [a, b] = resolveTurn({ balance: a }, { balance: b }, aa, ab, p);
  }
  return a > b ? 1 : a < b ? -1 : 0; // 1 = A wins, -1 = B wins, 0 = draw
}

const baselines = {
  alwaysExtract: () => ({ action: "EXTRACT", amount: 10 }),
  alwaysHold: () => ({ action: "HOLD" }),
  alwaysFortify: () => ({ action: "FORTIFY" }),
  extractThenFortifyAhead: (s, p) => {
    if (s.myBalance - s.oppBalance >= 10 && s.turn >= 12) return { action: "FORTIFY" };
    return { action: "EXTRACT", amount: 10 };
  },
};

function grid() {
  const costs = [1, 2, 3, 5];
  const caps = [5, 10, 15];
  const fracs = [0.25, 0.5, 0.75];
  const out = [];
  for (const FORTIFY_COST of costs)
    for (const EXTRACT_CAP of caps)
      for (const PROTECTED_FRACTION of fracs)
        out.push({ ...DEFAULT_PARAMS, FORTIFY_COST, EXTRACT_CAP, PROTECTED_FRACTION });
  return out;
}

function main() {
  const mode = process.argv[2] || "evaluate";
  const results = {};
  for (const p of grid()) {
    const key = `cost=${p.FORTIFY_COST} cap=${p.EXTRACT_CAP} frac=${p.PROTECTED_FRACTION}`;
    results[key] = {};
    for (const [name, base] of Object.entries(baselines)) {
      let w = 0;
      let d = 0;
      let l = 0;
      // Both seats: our policy as A and as B (symmetric check).
      for (let seat = 0; seat < 2; seat++) {
        const r =
          seat === 0
            ? playMatch((s, pp, m) => decide(s, pp, m), base, p)
            : playMatch(base, (s, pp, m) => decide(s, pp, m), p) * -1;
        if (r === 1) w++;
        else if (r === 0) d++;
        else l++;
      }
      results[key][name] = `${w}W/${d}D/${l}L`;
    }
  }
  for (const [k, v] of Object.entries(results)) {
    console.log(k, JSON.stringify(v));
  }
  if (mode === "calibrate") {
    console.log("\n(calibration: adjust FORTIFY_MIN_LEAD / FORTIFY_LATE_TURN in strategy.js, re-run)");
  }
}

if (require.main === module) main();

module.exports = { resolveTurn, playMatch, baselines, grid };
