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
// === OPEN ITEM — INPUT_MAPPING (read this before going live) ===
// The circuit takes 17 inputs (9 public). The exact input signal names
// and the publicInputsHash field order are NOT published on the public
// pages; they are revealed by the dashboard's practice flow (the first
// practice turn envelope + the preflight response show the exact shapes).
// Fill in INPUT_MAPPING below from that first practice turn, then run
//   node -e "require('./steal/proof').selfTest()"
// which generates a proof for a synthetic turn and verifies it locally
// with snarkjs before you ever send one to the platform.
//
// Until INPUT_MAPPING is filled, generatePolicyProof() throws a clear
// error and server.js answers HOLD with no proof (safe fallback).
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const CIRCUIT_VERSION = process.env.CIRCUIT_VERSION || "vfy-policy-v1";
const VK_HASH =
  "0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047";

const WASM_PATH = path.join(__dirname, "..", "circuits", "vfy-policy.wasm");
const ZKEY_PATH = path.join(__dirname, "..", "circuits", "vfy-policy_final.zkey");
const VK_PATH = path.join(__dirname, "..", "circuits", "vfy-vk.json");

// TODO (from practice): map turn-envelope fields + strategy params to the
// circuit's input signals, e.g.:
//   INPUT_MAPPING = {
//     matchId: (env) => ...,
//     turn: (env) => env.turn,
//     myBalance: (env) => env.myBalance,
//     oppBalance: (env) => env.oppBalance,
//     action: (env, decision) => ACTION_CODE[decision.action],
//     amount: (env, decision) => decision.amount || 0,
//     commitment: (env) => env.commitmentHash,
//     salt: () => process.env.STEAL_STRATEGY_SALT,
//     params: () => strategyParams(),
//   };
// The key names must match the circuit's input signal names exactly.
const INPUT_MAPPING = null;

// Strategy parameters committed at registration (numbers) + private salt.
// The commitment registered in the dashboard is the hash of these.
// commitmentHash() below must match what the dashboard expects — confirm
// the hash function from the dashboard during registration.
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
  const salt = process.env.STEAL_STRATEGY_SALT || "";
  if (!salt) throw new Error("STEAL_STRATEGY_SALT missing: set a random hex salt in .env");
  const params = strategyParams();
  // Default construction: keccak256(abi.encode(params, salt)) equivalent —
  // replace with the dashboard's construction if it differs.
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({ params, salt }));
  return `0x${h.digest("hex")}`;
}

async function generatePolicyProof(env, decision) {
  if (!INPUT_MAPPING) {
    throw new Error(
      "INPUT_MAPPING not filled: confirm the circuit input signal names + publicInputsHash order from the first practice turn (see steal/proof.js header)"
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
  return { proof, publicSignals, circuitVersion: CIRCUIT_VERSION };
}

async function selfTest() {
  console.log("vkHash:", VK_HASH);
  console.log("artifacts present:", fs.existsSync(WASM_PATH), fs.existsSync(ZKEY_PATH));
  console.log("INPUT_MAPPING filled:", !!INPUT_MAPPING);
  if (!INPUT_MAPPING) {
    console.log("selfTest: fill INPUT_MAPPING first (see header).");
    return false;
  }
  const env = { matchId: "selftest", turn: 1, myBalance: 100, oppBalance: 100 };
  const t0 = Date.now();
  const out = await generatePolicyProof(env, { action: "EXTRACT", amount: 10 });
  console.log(`selfTest: proof OK in ${Date.now() - t0}ms, publicSignals=${out.publicSignals.length}`);
  return true;
}

module.exports = { generatePolicyProof, commitmentHash, strategyParams, selfTest, CIRCUIT_VERSION, VK_HASH };
