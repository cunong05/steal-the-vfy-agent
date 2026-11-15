// Strategy for Steal the VFY (CUNONG-2).
//
// Game numbers — OFFICIAL, from https://agentgames.zkverify.io/build
// (verified 16 Nov 2026; they replace the old guessed parameters):
//   20 turns, 100 VFY each at start, simultaneous submission,
//   deterministic resolver on prior public state only.
//   FORTIFY — costs 2 VFY; blocks up to 6 VFY of incoming extraction.
//   EXTRACT — free; takes up to N VFY (max 10) from the opponent's
//             spendable balance. A fortified opponent reduces the
//             effective gain by 6.
//   HOLD    — free; no balance movement.
// Highest balance after 20 turns wins the match.
//
// Shield timing — ASSUMPTION, to be confirmed from the first practice
// turns (see "OPEN ITEM" below). The turn envelope carries
// selfFortifiedUntilTurn / opponentFortifiedUntilTurn for the CURRENT
// turn, which only makes sense if a shield set on turn t is still active
// on a later turn: FORTIFY played on turn t pays 2 and sets
// fortifiedUntilTurn = t+1, i.e. the shield blocks extraction during
// turn t+1's resolution. (Under a same-turn-only shield the envelope
// fields could never be active at envelope time, so the fields would be
// useless.) Confirmation: fortify on turn t, then watch whether the
// opponent's extraction on turn t or on turn t+1 is reduced by 6.
// If practice shows same-turn shielding instead, change
// nextFortifiedUntilTurn() to return `turn` and re-run the simulator.
//
// Declared EXTRACT amount: the amount is the PRE-shield attempted take,
// min(cap, opponent balance). The resolver applies the fortify block
// (take = max(0, min(amount, balance) - 6) when fortified). Declaring
// the post-shield amount would double-count the block and zero the take,
// so never subtract the block from the declared amount. The "effective
// gain" (used only to decide whether extracting is worth it) is
// max(0, min(cap, oppBalance) - (oppFortified ? 6 : 0)).
//
// Policy shape — CIRCUIT POLICY (verified 16 Nov 2026, see
// ~/workspace/zkverify/steal-the-vfy/hidden_files/line75-probe-results.md).
// The vfy-policy circuit prescribes EXACTLY one action per
// (selfBalance, opponentBalance, strategyParams); any other action fails
// the line-140/149 asserts and the turn falls back to HOLD without proof
// (-2). The prescribed policy, for params [p0..p7]:
//   if selfBalance < p1:        FORTIFY 0
//   elif p3 == 1:               HOLD 0        (passive mode: never EXTRACT)
//   elif opponentBalance <= p2: HOLD 0
//   else:                       EXTRACT p0
// Validity (line 75-78, 90, 95, 98): p4=p5=p6=p7=0, 1 <= p0 <= 10,
// p3 in {0,1}; p1, p2 any >= 0. The action does NOT depend on turn,
// matchId, salt, or fortify fields — only (self, opp, params).
// Recommended params (probe §1): [10,0,0,0,0,0,0,0] — maximally
// aggressive: EXTRACT 10 unless the opponent has nothing (HOLD).
// Alternative validated: [2,10,6,0,0,0,0,0] — EXTRACT 2, FORTIFY when
// self < 10, HOLD when opp <= 6.
// The old heuristic below (lead-based fortify, opponent inference) is
// KEPT only as dead documentation in the tracker/resolver helpers;
// decide() MUST follow the circuit policy above, or live proofs fail.
//  4. Never send `amount` for HOLD or FORTIFY — the schema rejects the
//     field even when it is 0. Only EXTRACT carries an amount, and it
//     MUST equal p0 exactly (line 149), even when oppBalance < p0.
//
// `state` shape (see server.js normalizeEnvelope — official /build fields):
//   { matchId, turn (1..20), myBalance, oppBalance,
//     myFortifiedUntilTurn, oppFortifiedUntilTurn, commitmentHash,
//     deadlineAt, mode, raw }
"use strict";

const DEFAULT_PARAMS = {
  // Official numbers (agentgames.zkverify.io/build).
  FORTIFY_COST: 2, // fixed cost paid when fortifying
  EXTRACT_CAP: 10, // max taken per EXTRACT from exposed balance
  FORTIFY_BLOCK: 6, // flat VFY a fortify blocks from incoming extraction
  // Policy knobs (tuned by the simulator grid search):
  FORTIFY_MIN_LEAD: 5, // fortify only when ahead by at least this
  FORTIFY_LATE_TURN: 15, // from this turn on, defend a lead
  EXTRACT_MIN_EXPOSED: 1, // extract only if effective gain >= this
};

function paramsFromEnv(env = process.env) {
  const p = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(DEFAULT_PARAMS)) {
    if (env[k] !== undefined && env[k] !== "") {
      const v = Number(env[k]);
      if (Number.isFinite(v)) p[k] = v;
    }
  }
  return p;
}

// Is a side fortified for the resolution of `turn`?
function isFortified(untilTurn, turn) {
  return untilTurn !== null && untilTurn !== undefined && Number(untilTurn) >= turn;
}

// fortifiedUntilTurn set by playing FORTIFY on `turn` (see header:
// shield active during the NEXT turn's resolution).
function nextFortifiedUntilTurn(action, turn) {
  return action === "FORTIFY" ? turn + 1 : null;
}

// Effective VFY gained by extracting `amount` from a balance, with or
// without the defender's shield. (Resolver model: the shield reduces the
// take by up to FORTIFY_BLOCK.)
function effectiveTake(amount, balance, fortified, p) {
  const take = Math.min(amount, Math.max(0, balance));
  return fortified ? Math.max(0, take - p.FORTIFY_BLOCK) : take;
}

// Per-match memory: infers the opponent's last action.
// Flow per turn: observe(state) with the new envelope (balances after the
// previous resolution + fortify fields for the current turn), then
// decide(), then setMyAction(action).
// - Opponent FORTIFY is read DIRECTLY from the envelope:
//   opponentFortifiedUntilTurn >= current turn means the opponent
//   fortified on the previous turn (shield active now).
// - Opponent EXTRACT is inferred from balance deltas: we know our own
//   previous action and both shields during the previous resolution, so
//   the opponent's take from us is
//     expectedDelta (without opponent extraction) - actualDelta.
//   expectedDelta = (we extracted ? our effective take : 0)
//                 - (we fortified ? cost : 0)
function createTracker(params) {
  const p = params;
  let prev = null; // { turn, myBalance, oppBalance, myAction, myFortified, oppFortified }
  let last = { oppAction: "UNKNOWN", oppExtractedLast: false, oppFortifiedLast: false };

  function observe(state) {
    const oppFortifiedNow = isFortified(state.oppFortifiedUntilTurn, state.turn);
    if (prev && prev.myAction) {
      const myTake =
        prev.myAction === "EXTRACT"
          ? effectiveTake(p.EXTRACT_CAP, prev.oppBalance, prev.oppFortified, p)
          : 0;
      const myCost = prev.myAction === "FORTIFY" ? p.FORTIFY_COST : 0;
      const expected = myTake - myCost;
      const actual = state.myBalance - prev.myBalance;
      const oppTook = expected - actual;
      if (oppTook > 0.001) {
        last = { oppAction: "EXTRACT", oppExtractedLast: true, oppFortifiedLast: false };
      } else if (oppFortifiedNow) {
        last = { oppAction: "FORTIFY", oppExtractedLast: false, oppFortifiedLast: true };
      } else {
        last = { oppAction: "HOLD", oppExtractedLast: false, oppFortifiedLast: false };
      }
    } else if (oppFortifiedNow) {
      last = { oppAction: "FORTIFY", oppExtractedLast: false, oppFortifiedLast: true };
    }
    prev = {
      turn: state.turn,
      myBalance: state.myBalance,
      oppBalance: state.oppBalance,
      myAction: null,
      myFortified: isFortified(state.myFortifiedUntilTurn, state.turn),
      oppFortified: oppFortifiedNow,
    };
    return last;
  }

  function setMyAction(action) {
    if (prev) prev.myAction = action;
  }

  return {
    observe,
    setMyAction,
    snapshot: () => ({ ...last }),
  };
}

// Expected value of fortifying this turn: the extraction it blocks
// (opponent's likely extraction next turn, capped, minus the flat block)
// minus its cost. Positive => fortify (if the opponent is actually
// extracting — the caller gates on that).
function fortifyValue(state, p) {
  const exposed = Math.max(0, state.myBalance);
  const blocked = Math.min(p.FORTIFY_BLOCK, Math.min(p.EXTRACT_CAP, exposed));
  return blocked - p.FORTIFY_COST;
}

// === Circuit policy (the ONLY policy decide() may use) ===

// Parse + validate the 8 strategy params from env STEAL_STRATEGY_PARAMS
// (comma-separated, e.g. "10,0,0,0,0,0,0,0"). Throws on anything the
// circuit rejects (line 75-78: p4..p7 must be 0; line 90: p0 >= 1;
// line 95: p0 <= 10; line 98: p3 in {0,1}).
function validateCircuitParams(params) {
  if (!Array.isArray(params) || params.length !== 8) {
    throw new Error("strategyParams must be an array of 8 numbers");
  }
  if (params.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error("strategyParams must be non-negative integers");
  }
  const [p0, , , p3, p4, p5, p6, p7] = params;
  if (p4 !== 0 || p5 !== 0 || p6 !== 0 || p7 !== 0) {
    throw new Error("strategyParams[4..7] must be 0 (circuit lines 75-78)");
  }
  if (p0 < 1 || p0 > 10) {
    throw new Error("strategyParams[0] must be 1..10 (circuit lines 90/95)");
  }
  if (p3 !== 0 && p3 !== 1) {
    throw new Error("strategyParams[3] must be 0 or 1 (circuit line 98)");
  }
  return params;
}

function circuitParamsFromEnv(env = process.env) {
  const raw = String(env.STEAL_STRATEGY_PARAMS || "");
  const nums = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (nums.length === 0) {
    throw new Error("STEAL_STRATEGY_PARAMS missing: set 8 comma-separated numbers in .env");
  }
  return validateCircuitParams(nums);
}

// Pure circuit policy: the action the circuit prescribes for this state.
// params = validated 8-number array. Returns { action, amount?, reason }.
// EXTRACT amount is ALWAYS p0 exactly (line 149) — never min(p0, opp).
function circuitPolicyDecision(state, params) {
  const [p0, p1, p2, p3] = validateCircuitParams(params);
  const my = state.myBalance ?? 100;
  const opp = state.oppBalance ?? 100;
  if (my < p1) {
    return { action: "FORTIFY", reason: `self ${my} < p1=${p1}` };
  }
  if (p3 === 1 || opp <= p2) {
    return { action: "HOLD", reason: p3 === 1 ? "passive mode p3=1" : `opp ${opp} <= p2=${p2}` };
  }
  return { action: "EXTRACT", amount: p0, reason: `opp ${opp} > p2=${p2}, extract p0=${p0}` };
}

// Resolve the circuit params from whatever the caller passed:
// an 8-number array, { strategyParams: [...] }, or anything else
// (game-knob object, undefined) -> read STEAL_STRATEGY_PARAMS from env.
function resolveCircuitParams(paramsArg, env = process.env) {
  if (Array.isArray(paramsArg)) return validateCircuitParams(paramsArg);
  if (paramsArg && Array.isArray(paramsArg.strategyParams)) {
    return validateCircuitParams(paramsArg.strategyParams);
  }
  return circuitParamsFromEnv(env);
}

function decide(state, paramsArg, memory = null) {
  void memory; // the circuit policy needs no opponent inference
  const params = resolveCircuitParams(paramsArg);
  return circuitPolicyDecision(state, params);
}

module.exports = {
  decide,
  circuitPolicyDecision,
  circuitParamsFromEnv,
  validateCircuitParams,
  resolveCircuitParams,
  paramsFromEnv,
  DEFAULT_PARAMS,
  fortifyValue,
  createTracker,
  isFortified,
  nextFortifiedUntilTurn,
  effectiveTake,
};
