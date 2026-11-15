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
// Commitment construction (verified by probe): the line-72 assert passes
// iff commitment == Poseidon([strategyParams[0..7], salt]) (circomlibjs
// poseidon, params first, salt last); any other commitment fails line 72.
// OPEN — line-75 assert: blocks EVERY input combination tried so far
// (all 3 actions; EXTRACT amounts 0-10; turns 1/3/20; balances incl.
// 100/100 at turn 1; params [2,10,6,5,15,1,100,20] and all-1s;
// salt 1/2; matchId UUID-int and 1; circuitVersion 0/1). It almost
// certainly needs the TRUE strategyParams semantics — most likely defined
// by the dashboard's "Set up strategy commitment" form. Do NOT go live
// until a proof verifies locally (selfTest below).
// ANOMALY (documented, not yet explained): strategyParams[4..7] are
// accepted by the witness calculator (counted 8/8) yet never appear as
// witness signals — only params[0..3] + salt materialize (witness
// indices 10-14). The line-72 hash still depends on params[4..7]
// (changing params[4] requires recomputing the commitment), so they
// ARE read by the circuit somehow. Do not "fix" this by reordering;
// it needs the .circom source to explain.
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

// === STRATEGY COMMITMENT — UNVERIFIED, DO NOT TRUST YET ===
// The platform freezes the HASH OF THE POLICY CIRCUIT (vkHash above),
// NOT a hash of strategy parameters + salt. The old construction below
// (SHA256 over JSON {params, salt}) was a guess made before /build was
// read and is almost certainly NOT what the dashboard expects.
// It is kept only so the value can be compared once the dashboard shows
// the commitment it expects (tap "Set up strategy commitment" in the
// dashboard); do NOT use it to register a commitment. The commitment
// that matters is the circuit hash:
//   vfy-policy vkHash =
//   0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047
// and circuitVersion "v1" must match the registered commitment.
function strategyParams() {
  const raw = process.env.STEAL_STRATEGY_PARAMS || "";
  const nums = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error("STEAL_STRATEGY_PARAMS missing: set comma-separated numbers in .env");
  }
  return nums;
}

function commitmentHash() {
  // UNVERIFIED — see header above. Kept for comparison only.
  const crypto = require("node:crypto");
  const salt = process.env.STEAL_STRATEGY_SALT || "";
  if (!salt) throw new Error("STEAL_STRATEGY_SALT missing: set a random hex salt in .env");
  const params = strategyParams();
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({ params, salt }));
  return `0x${h.digest("hex")}`;
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
  // publicInputsHash is testable without the circuit: recompute the
  // documented example values by hand and check determinism + format.
  const env = {
    matchId: "9f4e1b2a-1111-4222-8333-444455556666",
    turn: 3,
    myBalance: 95,
    oppBalance: 105,
    // Test-only override: the commitment MUST equal
    // Poseidon([strategyParams, salt]) or the proof fails the line-72
    // assert. Pass it via STEAL_SELFTEST_COMMITMENT (decimal or 0x hex);
    // the hardcoded dummy below is NOT a valid commitment and only
    // exercises the publicInputsHash part.
    commitmentHash:
      process.env.STEAL_SELFTEST_COMMITMENT ||
      "0x7d00000000000000000000000000000000000000000000000000000000000091",
  };
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
  if (!INPUT_MAPPING) {
    console.log("selfTest: fill INPUT_MAPPING first (see header).");
    return false;
  }
  const t0 = Date.now();
  const out = await generatePolicyProof(env, { action: "EXTRACT", amount: 5 });
  console.log(`selfTest: proof OK in ${Date.now() - t0}ms, publicSignals=${out.publicSignals.length}`);
  return true;
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
