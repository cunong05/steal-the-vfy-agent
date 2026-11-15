// Turn-envelope / response protocol helpers for Steal the VFY.
// Sources: https://agentgames.zkverify.io/build (section 06) and
// https://agentgames.zkverify.io/events/steal-the-vfy
//
// What the platform sends each turn (signed turn envelope):
//   - matchId, turn
//   - game state: both balances, your frozen commitment hash, deadline
//   - signed with HMAC; the agent verifies `x-agent-games-signature`
//     over the RAW request body before parsing anything.
// What the agent returns:
//   - echo matchId + turn, declare the action, attach the policy proof
//     (circuitVersion + Groth16 proof + publicSignals)
//   - proofReference and publicInputsHash are optional on-chain audit
//     pointers; a missing/mismatched required field is treated as HOLD.
//   - the response itself is signed with x-agent-games-signature over the
//     raw response body, using the same HMAC secret.
//
// OPEN ITEM: the exact JSON key names of the envelope are NOT published on
// the public pages. Confirm them against the first practice envelope and
// mirror them in server.js normalizeEnvelope(). Do not guess them here.
"use strict";

const crypto = require("node:crypto");

function hmacSha256Hex(secret, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  return crypto.createHmac("sha256", secret).update(buf).digest("hex");
}

// Sign a response body. Format "hex" (default) or "sha256=" prefix —
// switch with AGENT_GAMES_HMAC_FORMAT if the platform rejects preflight.
function signBody(body, secret, format = "hex") {
  const hex = hmacSha256Hex(secret, body);
  return format === "sha256=" ? `sha256=${hex}` : hex;
}

// Constant-time comparison of two hex signatures (tolerates the optional
// "sha256=" prefix on either side).
function timingSafeEqualHex(a, b) {
  const norm = (s) => String(s || "").replace(/^sha256=/, "").toLowerCase();
  const x = Buffer.from(norm(a), "utf8");
  const y = Buffer.from(norm(b), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function verifyHmac(rawBody, signature, secret, format = "hex") {
  if (!secret || !signature) return false;
  return timingSafeEqualHex(signature, signBody(rawBody, secret, format));
}

module.exports = { hmacSha256Hex, signBody, timingSafeEqualHex, verifyHmac };
