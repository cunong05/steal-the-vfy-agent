// Groth16 policy-proof generation for Steal the VFY.
//
// Circuit (official): vfy-policy, Groth16/BN128, Circom 2.x.
// Artifacts (official, agentgames.zkverify.io):
//   circuits/vfy-policy.wasm
//   circuits/vfy-policy_final.zkey
// Registered vkHash (from /api/circuit-info):
//   0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047
// The platform re-verifies every proof against its OWN registered key —
// you cannot swap in your own.
//
// Response field (official, agentgames.zkverify.io/build):
//   policyProof: { circuitVersion: "v1", proof: <raw snarkjs Groth16
//   proof {pi_a, pi_b, pi_c, protocol, curve}>, public_signals: [...],
//   publicInputsHash?: "0x..." }
// public_signals are the circuit's public signals as decimal strings in
// output-then-public order (exactly what snarkjs returns).
//
// === INPUT SIGNAL NAMES — RECOVERED 16 Nov 2026 (see
// ~/workspace/zkverify/steal-the-vfy/hidden_files/signal-probe-results.md)
// Method: wasm getInputSignalSize oracle (existence + array size) +
// witness-calculator input counting. All 17 inputs found:
//   commitment(1), matchId(1), turnNumber(1) [= turn], selfBalance(1),
//   opponentBalance(1), action(1), amount(1), circuitVersion(1),
//   salt(1), strategyParams(8)  — total 1*8 + 1 + 8 = 17.
// Public-signal order confirmed by witness dump:
//   [out, commitment, matchId, turnNumber, selfBalance,
//    opponentBalance, action, amount, circuitVersion]
//   (matches the publicInputsHash field order on /build).
// Commitment construction (VERIFIED 16 Nov 2026 —
// ~/workspace/zkverify/steal-the-vfy/hidden_files/line75-probe-results.md):
// commitment == Poseidon([strategyParams[0..7], salt]) (circomlibjs,
// params first, salt last). The line-72 assert passes iff the envelope's
// strategyCommitment.hash equals this value; the publicSignals[1]
// (pubCommit) returned by fullProve equals it too. The dashboard's
// "Update commitment" form registers this hash (replacing the default
// vkHash); the platform then sends it back in every turn envelope.
// LINE-75 BLOKER — SOLVED 16 Nov 2026 ~03:35 WIB: line 75 asserts
// params[4] == 0 (lines 76-78: params[5..7] == 0; line 90: p0 > 0;
// line 95: p0 <= 10; line 98: p3 < 2). The full circuit policy is:
//   self < p1 -> FORTIFY; p3==1 or opp <= p2 -> HOLD; else EXTRACT p0.
// decide() in steal/strategy.js implements exactly this — the proof
// only verifies when the decision matches the circuit's prescription.
// Old guesses (SHA256 over JSON; "p3<=p0 and p2<=p1") are WRONG and
// were removed. Do NOT go live until selfTest() below passes with the
// registered params + salt.
"use strict";

const path = require("node:path");
const fs = require("node:fs");

// Circuit version sent in policyProof — official value is the string "v1".
const CIRCUIT_VERSION = process.env.CIRCUIT_VERSION || "v1";
const VK_HASH =
  "0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047";

const WASM_PATH = path.join(__dirname, "..", "circuits", "vfy-policy.wasm");
const ZKEY_PATH = path.join(__dirname, "..", "circuits", "vfy-policy_final.zkey");
const VK_PATH = path.join(__dirname, "..", "circuits", "vfy-vk.json");

const { keccak256 } = require("./keccak");

// Action codes for publicInputsHash (official, /build).
const ACTION_CODE = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 };

// Circuit input signals -> turn-envelope fields + decision + env.
// Key names MUST match the circuit's input signal names exactly
// (recovered 16 Nov 2026 — see header). Values: BigInt for the large
// hashes/ids (snarkjs handles BigInt), plain numbers for the small ones.
const INPUT_MAPPING = {
  // Public inputs.
  commitment: (env) => BigInt(env.commitmentHash),
  matchId: (env) => BigInt(`0x${String(env.matchId).replace(/-/g, "")}`),
  turnNumber: (env) => env.turn,
  selfBalance: (env) => env.myBalance,
  opponentBalance: (env) => env.oppBalance,
  action: (env, decision) => ACTION_CODE[decision.action],
  amount: (env, decision) => (decision.action === "EXTRACT" ? decision.amount || 0 : 0),
  circuitVersion: () => 1, // "v1" -> 1 (official /build formula)
  // Private inputs.
  salt: () => {
    const s = String(process.env.STEAL_STRATEGY_SALT || "").trim();
    if (!s) throw new Error("STEAL_STRATEGY_SALT missing: set a hex salt in .env");
    return BigInt(s.startsWith("0x") ? s : `0x${s}`);
  },
  strategyParams: () => strategyParams(),
};

// === STRATEGY COMMITMENT — Poseidon([params, salt]) ===
// Verified against the circuit (line-72 assert + publicSignals[1]).
// Async because circomlibjs builds the Poseidon instance on first use;
// the instance is cached across calls.
let _poseidon = null;
async function poseidonInstance() {
  if (!_poseidon) {
    const { buildPoseidon } = require("circomlibjs");
    _poseidon = await buildPoseidon();
  }
  return _poseidon;
}

function strategyParams() {
  const { validateCircuitParams } = require("./strategy");
  const raw = process.env.STEAL_STRATEGY_PARAMS || "";
  const nums = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error("STEAL_STRATEGY_PARAMS missing: set comma-separated numbers in .env");
  }
  return validateCircuitParams(nums);
}

function saltBigInt() {
  const s = String(process.env.STEAL_STRATEGY_SALT || "").trim();
  if (!s) throw new Error("STEAL_STRATEGY_SALT missing: set a hex salt in .env");
  return BigInt(s.startsWith("0x") ? s : `0x${s}`);
}

async function commitmentHash() {
  const poseidon = await poseidonInstance();
  const params = strategyParams();
  const input = [...params.map(BigInt), saltBigInt()];
  const out = poseidon(input);
  return `0x${BigInt(poseidon.F.toString(out)).toString(16).padStart(64, "0")}`;
}

// publicInputsHash (official formula, /build): keccak256 of 8 fields,
// each padded to 32 bytes big-endian:
//   [strategyCommitment.hash, matchId (UUID without "-" as int), turn,
//    selfBalance, opponentBalance, actionCode, amount, 1]
// The platform independently computes this hash and rejects proofs whose
// hashes diverge. Returns null when the inputs are not usable
// (e.g. non-UUID matchId in a local test) — the caller then omits the
// optional field instead of sending a wrong hash.
function publicInputsHash(env, action, amount) {
  try {
    const fields = [
      BigInt(env.commitmentHash),
      BigInt(`0x${String(env.matchId).replace(/-/g, "")}`),
      BigInt(env.turn),
      BigInt(env.myBalance),
      BigInt(env.oppBalance),
      BigInt(ACTION_CODE[action]),
      BigInt(amount),
      1n,
    ];
    const buf = Buffer.concat(
      fields.map((f) => Buffer.from(f.toString(16).padStart(64, "0"), "hex"))
    );
    return `0x${keccak256(buf)}`;
  } catch {
    return null;
  }
}

async function generatePolicyProof(env, decision) {
  if (!INPUT_MAPPING) {
    throw new Error(
      "INPUT_MAPPING not filled in steal/proof.js — cannot build a policy proof"
    );
  }
  if (!fs.existsSync(WASM_PATH) || !fs.existsSync(ZKEY_PATH)) {
    throw new Error("circuit artifacts missing in circuits/");
  }
  // Practice envelopes may omit strategyCommitment.hash entirely (the
  // platform's practice dispatcher does not always echo the registered
  // commitment). The circuit input `commitment` is Poseidon(params,
  // salt), which we compute locally — it MUST equal the registered hash,
  // so filling it in here is safe. Without this, BigInt(null) throws
  // "Cannot convert null to a BigInt" and the turn falls back to HOLD
  // with no policyProof (platform schema fail).
  if (!env.commitmentHash) {
    env.commitmentHash = await commitmentHash();
  }
  const snarkjs = require("snarkjs");
  const input = {};
  for (const [signal, fn] of Object.entries(INPUT_MAPPING)) {
    input[signal] = fn(env, decision);
  }
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    WASM_PATH,
    ZKEY_PATH
  );
  // Local verification against the exported verification key before sending.
  const vk = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  if (!ok) throw new Error("local proof verification failed");
  const amount = decision.action === "EXTRACT" ? decision.amount || 0 : 0;
  return {
    proof,
    publicSignals,
    circuitVersion: CIRCUIT_VERSION,
    publicInputsHash: publicInputsHash(env, decision.action, amount),
  };
}

async function selfTest() {
  console.log("vkHash:", VK_HASH);
  console.log("circuitVersion:", CIRCUIT_VERSION);
  console.log("artifacts present:", fs.existsSync(WASM_PATH), fs.existsSync(ZKEY_PATH));
  console.log("INPUT_MAPPING filled:", !!INPUT_MAPPING);
  const params = strategyParams();
  console.log("strategyParams:", JSON.stringify(params));
  // publicInputsHash is testable without the circuit: recompute the
  // documented example values by hand and check determinism + format.
  const env = {
    matchId: "9f4e1b2a-1111-4222-8333-444455556666",
    turn: 3,
    myBalance: 95,
    oppBalance: 105,
    // The commitment MUST equal Poseidon([strategyParams, salt]) or the
    // proof fails the line-72 assert. Computed from the live env unless
    // STEAL_SELFTEST_COMMITMENT overrides it (test-only).
    commitmentHash:
      process.env.STEAL_SELFTEST_COMMITMENT || (await commitmentHash()),
  };
  console.log("commitmentHash:", env.commitmentHash);
  const h1 = publicInputsHash(env, "EXTRACT", 5);
  const h2 = publicInputsHash(env, "EXTRACT", 5);
  const h3 = publicInputsHash(env, "HOLD", 0);
  console.log("publicInputsHash EXTRACT:", h1);
  console.log("publicInputsHash HOLD:   ", h3);
  const hashOk =
    typeof h1 === "string" &&
    /^0x[0-9a-f]{64}$/.test(h1) &&
    h1 === h2 &&
    h1 !== h3;
  console.log("publicInputsHash deterministic + action-sensitive:", hashOk);
  if (!hashOk) return false;
  if (!INPUT_MAPPING) {
    console.log("selfTest: fill INPUT_MAPPING first (see header).");
    return false;
  }
  // The decision MUST be the circuit-prescribed action for this state,
  // or the proof fails lines 140/149. decide() implements the policy.
  const { decide } = require("./strategy");
  const decision = decide(env, params);
  console.log("decision for 95/105:", JSON.stringify(decision));
  const t0 = Date.now();
  const out = await generatePolicyProof(env, decision);
  console.log(`selfTest: proof OK in ${Date.now() - t0}ms, publicSignals=${out.publicSignals.length}`);
  // publicSignals[1] must equal the commitment we registered.
  const pubCommit = BigInt(out.publicSignals[1]).toString(16).padStart(64, "0");
  const commitOk = `0x${pubCommit}`.toLowerCase() === env.commitmentHash.toLowerCase();
  console.log("publicSignals[1] == commitmentHash:", commitOk);
  return commitOk;
}

module.exports = {
  generatePolicyProof,
  commitmentHash,
  strategyParams,
  publicInputsHash,
  selfTest,
  CIRCUIT_VERSION,
  VK_HASH,
  ACTION_CODE,
};
