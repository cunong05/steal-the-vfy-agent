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
// Policy shape (game-theoretic, simulator-verified):
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

function decide(state, params = paramsFromEnv(), memory = null) {
  const turn = state.turn || 1;
  const my = state.myBalance ?? 100;
  const opp = state.oppBalance ?? 100;
  const lead = my - opp;
  const turnsLeft = 20 - turn;
  const mem = memory || { oppExtractedLast: false, oppFortifiedLast: false };

  const oppFortified = isFortified(state.oppFortifiedUntilTurn, turn);
  // Effective gain from extracting now (shield already accounted for).
  const gain = effectiveTake(params.EXTRACT_CAP, opp, oppFortified, params);
  // Declared amount is the pre-shield take (see header).
  const declaredAmount = Math.min(params.EXTRACT_CAP, Math.floor(Math.max(0, opp)));

  const fv = fortifyValue({ ...state, myBalance: my }, params);
  // Fortify only when the opponent is actually extracting (inferred from
  // the previous turn's balance deltas). On turn 1 there is no history
  // and the lead is 0, so fortify cannot trigger there anyway.
  const oppExtracting = mem.oppExtractedLast;
  const late = turnsLeft <= 20 - params.FORTIFY_LATE_TURN;

  if ((late || lead >= params.FORTIFY_MIN_LEAD) && fv > 0 && lead > 0 && oppExtracting) {
    return { action: "FORTIFY", reason: `lead ${lead}, opp extracting, shield value ${fv.toFixed(1)} > 0` };
  }
  if (gain >= params.EXTRACT_MIN_EXPOSED && declaredAmount > 0) {
    return {
      action: "EXTRACT",
      amount: declaredAmount,
      reason: `opponent exposes ${gain.toFixed(1)} effective (fortified=${oppFortified})`,
    };
  }
  if (fv > 0 && oppExtracting && lead > 0) {
    return { action: "FORTIFY", reason: `nothing to extract, shield value ${fv.toFixed(1)} > 0` };
  }
  return { action: "HOLD", reason: "nothing to extract, fortify loses money" };
}

module.exports = {
  decide,
  paramsFromEnv,
  DEFAULT_PARAMS,
  fortifyValue,
  createTracker,
  isFortified,
  nextFortifiedUntilTurn,
  effectiveTake,
};
