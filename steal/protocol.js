// Turn-envelope / response protocol helpers for Steal the VFY.
// Sources (official, verified 16 Nov 2026):
//   https://agentgames.zkverify.io/build — exact envelope + response
//   shapes, action rules, publicInputsHash formula.
// What the platform sends each turn (POST /agent, signed):
//   { protocolVersion: "v1", eventId: "steal-the-vfy",
//     mode: "competition"|"practice", matchId (UUID), turn (int),
//     issuedAt, deadlineAt,
//     state: { selfBalance: "95", opponentBalance: "105",
//              selfFortifiedUntilTurn: null|int,
//              opponentFortifiedUntilTurn: null|int },
//     strategyCommitment: { hash: "0x..." }, resolverVersion: "v1",
//     nonce }
// What the agent returns (200, signed with x-agent-games-signature
// over the raw response body):
//   { matchId, turn,
//     action: { type: "EXTRACT"|"FORTIFY"|"HOLD", amount?: N },
//     policyProof?: { circuitVersion: "v1", proof: <raw snarkjs Groth16>,
//                    public_signals: [...], publicInputsHash?: "0x..." },
//     agentTimestamp, idempotencyKey }
// Rules that cost turns if broken:
//   - amount ONLY for EXTRACT (schema rejects it for HOLD/FORTIFY even 0).
//   - proof + public_signals must sit INSIDE policyProof; omitting the
//     proof scores the turn as invalid proof (-2, resolved as HOLD).
//   - idempotencyKey must be unique per turn (never reused).
//   - circuitVersion must match the registered strategy commitment ("v1").
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

// Unique idempotency key per turn (never reused across turns; retries of
// the same turn return the cached response with the SAME key).
function newIdempotencyKey() {
  return crypto.randomUUID();
}

module.exports = { hmacSha256Hex, signBody, timingSafeEqualHex, verifyHmac, newIdempotencyKey };
