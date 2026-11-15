// Self-play simulator for Steal the VFY + policy calibration.
//
// Resolver model, from https://agentgames.zkverify.io/build (official):
//   - Both actions resolve against the PRIOR exposed balances.
//   - EXTRACT vs HOLD: extractor takes up to the cap from the opponent's
//     exposed balance.
//   - EXTRACT vs FORTIFY (shield active this turn): the defender's
//     shield reduces the take by up to FORTIFY_BLOCK (flat 6); the
//     defender pays the fortify cost on the turn FORTIFY was played.
//   - EXTRACT vs EXTRACT: both resolve against prior exposed balances.
//   - FORTIFY vs HOLD: fortifier pays the cost; nothing else moves.
//   - FORTIFY vs FORTIFY: both pay the cost; no transfer.
//   - HOLD vs HOLD: nothing moves.
//
// Shield timing (assumption — see steal/strategy.js header): FORTIFY
// played on turn t pays the cost on turn t and sets fortifiedUntilTurn
// = t+1, so the shield is active during turn t+1's resolution. The
// simulator tracks fortifiedUntilTurn per side and passes it to decide()
// exactly like the real turn envelope does.
//
// Usage:
//   node steal/simulator.js            -> plays the default policy against
//                                          baselines across a parameter grid
//                                          and prints win rates.
//   node steal/simulator.js calibrate  -> same grid, plus a note on which
//                                          knobs to adjust.
//
// The official numbers are FORTIFY_COST=2, EXTRACT_CAP=10,
// FORTIFY_BLOCK=6. The grid varies each one around the official value
// to check sensitivity in case practice turns show the numbers are
// parameters that can change (see STATUS.md).
"use strict";

const {
  decide,
  createTracker,
  DEFAULT_PARAMS,
  isFortified,
  nextFortifiedUntilTurn,
  effectiveTake,
} = require("./strategy");

// Resolve one turn.
//   a, b: { balance, fortified } — prior public state for this turn's
//   resolution (fortified = shield active this turn, from a fortify
//   played on the previous turn).
// Returns { a, b, aFortifiedNext, bFortifiedNext } — new balances plus
// whether each side's shield is active NEXT turn (i.e. they played
// FORTIFY this turn).
function resolveTurn(a, b, myAction, oppAction, p) {
  let na = a.balance;
  let nb = b.balance;

  if (myAction === "FORTIFY") na -= p.FORTIFY_COST;
  if (oppAction === "FORTIFY") nb -= p.FORTIFY_COST;

  if (myAction === "EXTRACT") {
    const take = effectiveTake(p.EXTRACT_CAP, b.balance, b.fortified, p);
    na += take;
    nb -= take;
  }
  if (oppAction === "EXTRACT") {
    const take = effectiveTake(p.EXTRACT_CAP, a.balance, a.fortified, p);
    nb += take;
    na -= take;
  }
  return {
    a: na,
    b: nb,
    aFortifiedNext: myAction === "FORTIFY",
    bFortifiedNext: oppAction === "FORTIFY",
  };
}

function playMatch(policyA, policyB, p, turns = 20) {
  let a = 100;
  let b = 100;
  let aFortUntil = null;
  let bFortUntil = null;
  const ta = createTracker(p);
  const tb = createTracker(p);
  for (let t = 1; t <= turns; t++) {
    const sa = {
      turn: t,
      myBalance: a,
      oppBalance: b,
      myFortifiedUntilTurn: aFortUntil,
      oppFortifiedUntilTurn: bFortUntil,
    };
    const sb = {
      turn: t,
      myBalance: b,
      oppBalance: a,
      myFortifiedUntilTurn: bFortUntil,
      oppFortifiedUntilTurn: aFortUntil,
    };
    ta.observe(sa);
    tb.observe(sb);
    const aa = policyA(sa, p, ta.snapshot()).action;
    const ab = policyB(sb, p, tb.snapshot()).action;
    ta.setMyAction(aa);
    tb.setMyAction(ab);
    const r = resolveTurn(
      { balance: a, fortified: isFortified(aFortUntil, t) },
      { balance: b, fortified: isFortified(bFortUntil, t) },
      aa,
      ab,
      p
    );
    a = r.a;
    b = r.b;
    aFortUntil = r.aFortifiedNext ? nextFortifiedUntilTurn(aa, t) : aFortUntil;
    bFortUntil = r.bFortifiedNext ? nextFortifiedUntilTurn(ab, t) : bFortUntil;
  }
  return a > b ? 1 : a < b ? -1 : 0; // 1 = A wins, -1 = B wins, 0 = draw
}

const baselines = {
  alwaysExtract: (s, p) => ({ action: "EXTRACT", amount: Math.min(p.EXTRACT_CAP, Math.max(0, s.oppBalance)) }),
  alwaysHold: () => ({ action: "HOLD" }),
  alwaysFortify: () => ({ action: "FORTIFY" }),
  extractThenFortifyAhead: (s, p) => {
    if (s.myBalance - s.oppBalance >= 10 && s.turn >= 12) return { action: "FORTIFY" };
    return { action: "EXTRACT", amount: Math.min(p.EXTRACT_CAP, Math.max(0, s.oppBalance)) };
  },
};

// Sensitivity grid around the official numbers (2 / 10 / 6).
function grid() {
  const costs = [1, 2, 3];
  const caps = [5, 10, 15];
  const blocks = [3, 6, 9];
  const out = [];
  for (const FORTIFY_COST of costs)
    for (const EXTRACT_CAP of caps)
      for (const FORTIFY_BLOCK of blocks)
        out.push({ ...DEFAULT_PARAMS, FORTIFY_COST, EXTRACT_CAP, FORTIFY_BLOCK });
  return out;
}

function main() {
  const mode = process.argv[2] || "evaluate";
  const official = { ...DEFAULT_PARAMS };
  const points = [{ label: "OFFICIAL cost=2 cap=10 block=6", p: official }, ...grid().map((p) => ({
    label: `cost=${p.FORTIFY_COST} cap=${p.EXTRACT_CAP} block=${p.FORTIFY_BLOCK}`,
    p,
  }))];
  for (const { label, p } of points) {
    const row = {};
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
      row[name] = `${w}W/${d}D/${l}L`;
    }
    console.log(label, JSON.stringify(row));
  }
  if (mode === "calibrate") {
    console.log("\n(calibration: adjust FORTIFY_MIN_LEAD / FORTIFY_LATE_TURN in strategy.js, re-run)");
  }
}

if (require.main === module) main();

module.exports = { resolveTurn, playMatch, baselines, grid };
