// Strategy for Steal the VFY (CUNONG-2).
//
// Game (official pages): 20 turns, 100 VFY each at start, simultaneous
// submission, deterministic resolver on prior public state only.
//   FORTIFY — small fixed cost; protects part of your balance for the
//             next resolution.
//   EXTRACT — free; takes a bounded amount from the opponent's exposed
//             balance.
//   HOLD    — free; no balance movement.
// Highest balance after 20 turns wins the match.
//
// The exact numbers (FORTIFY_COST, EXTRACT_CAP, PROTECTED_FRACTION) are
// NOT published on the public pages. They are parameters here, and
// simulator.js calibrates the policy across a grid of them the moment real
// numbers arrive from practice turns. The rules below encode the
// game-theoretic shape, not tuned constants:
//
//  1. EXTRACT dominates HOLD against an unfortified opponent: it is free
//     and moves balance your way. HOLD only when extraction gains ~nothing
//     (opponent's exposed balance ~ 0) or when you must not reveal that
//     you will extract (there is no such signalling in simultaneous
//     submission — so HOLD is almost never right).
//  2. FORTIFY pays ONLY when the opponent is about to extract and the
//     amount it shields exceeds its cost. Fortifying against an opponent
//     who holds just burns the cost every turn (verified in the simulator:
//     an unconditional "fortify when ahead" rule stalls the lead). So the
//     policy fortifies only when the opponent extracted on the previous
//     turn (inferred from balance deltas — see createTracker) or, on turn
//     1-2 with no history yet, when ahead and the shield value is clearly
//     positive.
//  3. Late game: with few turns left, protect a lead (FORTIFY) or chase a
//     deficit (EXTRACT); never HOLD away the last turns.
//  4. Never send `amount` for HOLD or FORTIFY — the schema rejects the
//     field even when it is 0. Only EXTRACT carries an amount.
//
// `state` shape (see server.js normalizeEnvelope):
//   { matchId, turn (1..20), myBalance, oppBalance, commitmentHash,
//     deadline, raw } — plus optional fields the envelope may carry.
"use strict";

const DEFAULT_PARAMS = {
  // Placeholders — calibrate from practice (see simulator.js).
  FORTIFY_COST: 2, // fixed cost paid when fortifying
  EXTRACT_CAP: 10, // max taken per EXTRACT from exposed balance
  PROTECTED_FRACTION: 0.5, // fraction of balance FORTIFY shields
  // Policy knobs (tuned by the simulator grid search):
  FORTIFY_MIN_LEAD: 5, // fortify only when ahead by at least this
  FORTIFY_LATE_TURN: 15, // from this turn on, defend a lead
  EXTRACT_MIN_EXPOSED: 1, // extract only if opponent exposes >= this
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

// Per-match memory: infers the opponent's last action from balance deltas.
// Flow per turn: observe(state) with the new envelope (balances after the
// previous resolution), then decide(), then setMyAction(action).
// We know our own previous action and the balances before/after, so the
// opponent's take from us is:
//   expectedDelta (without opponent extraction) - actualDelta.
//   expectedDelta = (we extracted ? min(cap, oppExposedPrev) : 0)
//                 - (we fortified ? cost : 0)
// If the opponent's take > 0 they EXTRACTED; if their own balance fell by
// ~cost while we took nothing, they FORTIFIED; else they HELD.
function createTracker(params) {
  const p = params;
  let prev = null; // { turn, myBalance, oppBalance, myAction }
  let last = { oppAction: "UNKNOWN", oppExtractedLast: false, oppFortifiedLast: false };

  function observe(state) {
    if (prev && prev.myAction) {
      const oppExposedPrev = Math.max(0, prev.oppBalance);
      const myTake = prev.myAction === "EXTRACT"
        ? Math.min(p.EXTRACT_CAP, oppExposedPrev)
        : 0;
      const myCost = prev.myAction === "FORTIFY" ? p.FORTIFY_COST : 0;
      const expected = myTake - myCost;
      const actual = state.myBalance - prev.myBalance;
      const oppTook = expected - actual;
      const oppDelta = state.oppBalance - prev.oppBalance;
      // Opponent's own balance fell by ~cost while we took nothing => FORTIFY.
      const oppPaidCost = myTake === 0 && oppDelta <= -p.FORTIFY_COST + 0.001;
      if (oppTook > 0.001) {
        last = { oppAction: "EXTRACT", oppExtractedLast: true, oppFortifiedLast: false };
      } else if (oppPaidCost) {
        last = { oppAction: "FORTIFY", oppExtractedLast: false, oppFortifiedLast: true };
      } else {
        last = { oppAction: "HOLD", oppExtractedLast: false, oppFortifiedLast: false };
      }
    }
    prev = { turn: state.turn, myBalance: state.myBalance, oppBalance: state.oppBalance, myAction: null };
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
// (opponent's likely extraction, capped, times the shielded fraction)
// minus its cost. Positive => fortify (if the opponent is actually
// extracting — the caller gates on that).
function fortifyValue(state, p) {
  const exposed = Math.max(0, state.myBalance);
  const blocked = Math.min(p.EXTRACT_CAP, exposed) * p.PROTECTED_FRACTION;
  return blocked - p.FORTIFY_COST;
}

function decide(state, params = paramsFromEnv(), memory = null) {
  const turn = state.turn || 1;
  const my = state.myBalance ?? 100;
  const opp = state.oppBalance ?? 100;
  const lead = my - opp;
  const turnsLeft = 20 - turn;
  const mem = memory || { oppExtractedLast: false, oppFortifiedLast: false };

  // Opponent's exposed balance: their full balance unless they fortified
  // last turn (then only the unprotected part is exposed this resolution).
  const oppExposed = mem.oppFortifiedLast
    ? opp * (1 - params.PROTECTED_FRACTION)
    : opp;

  const fv = fortifyValue({ ...state, myBalance: my }, params);
  // Fortify only when the opponent is actually extracting (inferred from
  // the previous turn's balance deltas). On turn 1 there is no history
  // and the lead is 0, so fortify cannot trigger there anyway.
  const oppExtracting = mem.oppExtractedLast;
  const late = turnsLeft <= 20 - params.FORTIFY_LATE_TURN;

  if ((late || lead >= params.FORTIFY_MIN_LEAD) && fv > 0 && lead > 0 && oppExtracting) {
    return { action: "FORTIFY", reason: `lead ${lead}, opp extracting, shield value ${fv.toFixed(1)} > 0` };
  }
  if (oppExposed >= params.EXTRACT_MIN_EXPOSED) {
    return {
      action: "EXTRACT",
      amount: Math.min(params.EXTRACT_CAP, Math.floor(oppExposed)),
      reason: `opponent exposes ${oppExposed.toFixed(1)}`,
    };
  }
  if (fv > 0 && oppExtracting && lead > 0) {
    return { action: "FORTIFY", reason: `nothing to extract, shield value ${fv.toFixed(1)} > 0` };
  }
  return { action: "HOLD", reason: "nothing to extract, fortify loses money" };
}

module.exports = { decide, paramsFromEnv, DEFAULT_PARAMS, fortifyValue, createTracker };
