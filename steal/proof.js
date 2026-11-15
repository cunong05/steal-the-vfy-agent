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
// === OPEN ITEM — INPUT_MAPPING (read this before going live) ===
// The circuit takes 17 inputs (9 public: 1 output + 8 public inputs,
// confirmed by vfy-vk.json IC length 10). The exact input SIGNAL NAMES
// are NOT published anywhere checked so far (16 Nov 2026):
//   (a) GET /api/circuit-info — only vkHash + artifact URLs, no inputs.
//   (b) /build page text — envelope/response shapes + the
//       publicInputsHash formula, but NO circuit signal names.
//   (c) strings on circuits/vfy-policy.wasm — only obfuscated Circom
//       component names (Ark_148, AND_82, VfyPolicyProof_154); signal
//       names are NOT embedded in the wasm (they live in the .sym file).
//   (d) https://agentgames.zkverify.io/circuits/vfy-policy.sym — 404.
// The 8 public inputs are KNOWN by value from the publicInputsHash
// formula on /build (in order): strategyCommitment.hash, matchId (UUID
// without dashes, as int), turn, selfBalance, opponentBalance,
// actionCode (HOLD 0, FORTIFY 1, EXTRACT 2), amount (0 for HOLD /
// FORTIFY), circuitVersion "v1" -> 1. So the public signals are almost
// certainly [output, commitment, matchId, turn, selfBalance,
// opponentBalance, actionCode, amount, 1] — but the circuit's input
// signal NAMES (needed to build the witness for snarkjs fullProve) are
// still missing, and a practice turn envelope does NOT carry them either.
// NEXT STEP: obtain the .circom source or the .sym file for vfy-policy
// from the platform (docs / dashboard / support) and fill INPUT_MAPPING
// below; then run `node -e "require('./steal/proof').selfTest()"`.
//
// Until INPUT_MAPPING is filled, generatePolicyProof() throws a clear
// error and server.js answers HOLD with no proof (safe fallback — the
// turn resolves as HOLD; note /build says a turn with no proof is scored
// as an invalid proof, -2, so the proof pipeline is the critical path
// before any scored round).
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

// TODO: map turn-envelope fields + strategy params to the circuit's input
// signal names, e.g.:
//   INPUT_MAPPING = {
//     <signalName>: (env, decision) => ...,
//     ...
//   };
// The key names must match the circuit's input signal names exactly.
// See the OPEN ITEM header above for where the names must come from.
const INPUT_MAPPING = null;

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
      "INPUT_MAPPING not filled: the circuit input signal names are not published on /build, /api/circuit-info, or in the wasm — obtain the .circom source or .sym file (see steal/proof.js header)"
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
    commitmentHash: "0x7d00000000000000000000000000000000000000000000000000000000000091",
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
