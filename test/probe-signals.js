"use strict";
// One-off probe: recover vfy-policy input signal names via the wasm
// getInputSignalSize oracle (existence + array size). No proving is run;
// probes fail fast at input validation. Run: node test/probe-signals.js
const fs = require("node:fs");
const path = require("node:path");
const { WitnessCalculatorBuilder } = require("circom_runtime");

// FNV-1a 64-bit, copied exactly from circom_runtime/js/utils.js
function fnvHash(str) {
  const uint64_max = 2n ** 64n;
  let hash = 0xCBF29CE484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= 0x100000001B3n;
    hash %= uint64_max;
  }
  let shash = hash.toString(16);
  shash = "0".repeat(16 - shash.length) + shash;
  return shash;
}

const CANDIDATES = [
  // Public (from publicInputsHash formula + envelope fields)
  "commitment", "strategyCommitment", "matchId", "turn",
  "selfBalance", "opponentBalance", "action", "amount",
  "circuitVersion", "resolverVersion", "nonce", "protocolVersion",
  "eventId", "issuedAt", "deadlineAt",
  "selfFortifiedUntilTurn", "opponentFortifiedUntilTurn",
  "self_balance", "opponent_balance", "actionCode", "actionType",
  "myBalance", "oppBalance",
  // Private (strategy / salt / params)
  "salt", "strategySalt", "fortifyCost", "extractCap", "blockAmount",
  "fortifyBlock", "protectedAmount", "params", "strategyParams",
  "fortify_cost", "extract_cap", "block", "shield", "cost", "cap",
  "secret", "seed", "strategyHash", "commitmentHash", "balance",
  "balances",
  // Extra variants (fortified flags, misc)
  "selfFortified", "opponentFortified", "fortified",
  "selfFortifiedUntil", "opponentFortifiedUntil",
  "fortifyUntil", "strategy", "hash", "version", "mode",
  "maxAmount", "maxExtract", "extractMax", "fortifyAmount",
  "blockValue", "privateSalt", "commitmentSalt",
  "isFortified", "selfIsFortified", "opponentIsFortified",
  "actionAmount", "startingBalance", "initialBalance",
  "publicInputsHash", "policyParams", "decision", "round",
  "turnsLeft", "state",
];

async function main() {
  const wasm = fs.readFileSync(
    path.join(__dirname, "..", "circuits", "vfy-policy.wasm")
  );
  const wc = await WitnessCalculatorBuilder(wasm);
  const ex = wc.instance.exports;
  console.log("circom_version:", wc.circom_version());
  console.log("getInputSize:", ex.getInputSize(), "getWitnessSize:", ex.getWitnessSize());
  console.log("has getInputSignalSize:", typeof ex.getInputSignalSize === "function");

  function probe(name) {
    const h = fnvHash(name);
    const hMSB = parseInt(h.slice(0, 8), 16);
    const hLSB = parseInt(h.slice(8, 16), 16);
    try {
      return ex.getInputSignalSize(hMSB, hLSB); // >=0 exists (size), <0 absent
    } catch (e) {
      return `THREW: ${e.message}`;
    }
  }

  console.log("--- oracle validation ---");
  console.log("turn (expect >=0):", probe("turn"));
  console.log("zzzznotasignal (expect <0):", probe("zzzznotasignal"));
  try {
    await wc.calculateWitness({ turn: 1 });
    console.log("calculateWitness({turn:1}): NO ERROR (unexpected)");
  } catch (e) {
    console.log("calculateWitness({turn:1}) ->", String(e.message).trim());
  }
  try {
    await wc.calculateWitness({ zzzznotasignal: 1 });
    console.log("calculateWitness({zzzznotasignal:1}): NO ERROR (unexpected)");
  } catch (e) {
    console.log("calculateWitness({zzzznotasignal:1}) ->", String(e.message).trim());
  }

  console.log("--- candidates ---");
  const found = [];
  for (const name of CANDIDATES) {
    const r = probe(name);
    console.log(`${name}\t${r}`);
    if (typeof r === "number" && r >= 0) found.push([name, r]);
  }
  const total = found.reduce((s, [, n]) => s + n, 0);
  console.log("--- summary ---");
  console.log("found:", JSON.stringify(found));
  console.log("total elements found:", total, "of", ex.getInputSize());
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
