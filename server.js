// Steal the VFY agent — server
// Node.js, no framework, plain http. Protocol: official shapes from
// https://agentgames.zkverify.io/build (verified 16 Nov 2026).
//
//   GET  /health  -> readiness (hmac configured? proof artifacts present?)
//   GET  /agent   -> preflight responder { ok: true, protocolVersion: "v1" }
//   POST /agent   -> signed turn envelope in, signed action+proof out
//   POST /steal   -> alias of /agent (kept for compatibility)
//
// Env (see .env.example):
//   PORT, AGENT_GAMES_HMAC_SECRET, STEAL_STRATEGY_* , CIRCUIT_VERSION
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const {
  verifyHmac,
  signBody,
  timingSafeEqualHex,
  newIdempotencyKey,
} = require("./steal/protocol");
const { decide, createTracker, paramsFromEnv, circuitParamsFromEnv } = require("./steal/strategy");
const {
  generatePolicyProof,
  publicInputsHash,
  CIRCUIT_VERSION,
} = require("./steal/proof");

const PORT = Number(process.env.PORT || 8080);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "";
const HMAC_FORMAT = (process.env.AGENT_GAMES_HMAC_FORMAT || "hex").toLowerCase();

const CIRCUITS_DIR = path.join(__dirname, "circuits");
const WASM_PATH = path.join(CIRCUITS_DIR, "vfy-policy.wasm");
const ZKEY_PATH = path.join(CIRCUITS_DIR, "vfy-policy_final.zkey");

// Idempotency: matchId + turn -> cached response body (string) + key.
// The platform may retry after a network failure; a retry of the same
// turn is NOT a new turn, and the idempotency key must never be reused
// for a different turn.
const seenTurns = new Map();

// Per-match strategy memory (opponent-action inference). One tracker per
// matchId; it only observes a turn once (retries return the cached
// response before the tracker is touched).
const trackers = new Map();
function trackerFor(matchId) {
  if (!trackers.has(matchId)) trackers.set(matchId, createTracker(paramsFromEnv()));
  return trackers.get(matchId);
}

function hmacConfigured() {
  return HMAC_SECRET.length >= 16;
}

function circuitsPresent() {
  return fs.existsSync(WASM_PATH) && fs.existsSync(ZKEY_PATH);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, sign = false) {
  const body = JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  if (sign && hmacConfigured()) {
    headers["x-agent-games-signature"] = signBody(body, HMAC_SECRET, HMAC_FORMAT);
  }
  res.writeHead(status, headers);
  res.end(body);
}

function sendSigned(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...(hmacConfigured()
      ? { "x-agent-games-signature": signBody(body, HMAC_SECRET, HMAC_FORMAT) }
      : {}),
  });
  res.end(body);
}

function healthPayload() {
  return {
    status: "ok",
    agent: "CUNONG-2",
    event: "steal_the_vfy",
    hmacConfigured: hmacConfigured(),
    circuitsPresent: circuitsPresent(),
    circuitVersion: CIRCUIT_VERSION,
    uptimeSec: Math.floor(process.uptime()),
    seenTurns: seenTurns.size,
  };
}

// Official turn envelope (agentgames.zkverify.io/build):
//   { protocolVersion, eventId, mode, matchId, turn, issuedAt,
//     deadlineAt, state: { selfBalance, opponentBalance,
//     selfFortifiedUntilTurn, opponentFortifiedUntilTurn },
//     strategyCommitment: { hash }, resolverVersion, nonce }
// Balances arrive as decimal STRINGS. Old key names are kept as a
// fallback only — the official names take precedence.
function normalizeEnvelope(raw) {
  const e = raw || {};
  const state = e.state || {};
  return {
    protocolVersion: e.protocolVersion || null,
    eventId: e.eventId || null,
    mode: e.mode || "competition",
    matchId: e.matchId ?? e.match_id ?? e.matchID ?? null,
    turn: Number(e.turn ?? e.turnNumber ?? e.turn_number ?? 0),
    issuedAt: e.issuedAt || null,
    deadlineAt: e.deadlineAt ?? e.deadline ?? null,
    myBalance: Number(
      state.selfBalance ?? state.myBalance ?? e.myBalance ?? e.selfBalance ?? 100
    ),
    oppBalance: Number(
      state.opponentBalance ?? state.oppBalance ?? e.oppBalance ?? e.opponentBalance ?? 100
    ),
    myFortifiedUntilTurn:
      state.selfFortifiedUntilTurn ?? state.myFortifiedUntilTurn ?? null,
    oppFortifiedUntilTurn:
      state.opponentFortifiedUntilTurn ?? state.oppFortifiedUntilTurn ?? null,
    commitmentHash:
      (e.strategyCommitment && e.strategyCommitment.hash) ||
      e.commitmentHash ||
      e.commitment_hash ||
      e.commitment ||
      null,
    resolverVersion: e.resolverVersion || null,
    nonce: e.nonce || null,
    raw: e,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, healthPayload());
    }

    // Preflight responder (dashboard health check): signed
    // { ok: true, protocolVersion: "v1" }.
    if (req.method === "GET" && (req.url === "/agent" || req.url === "/agent/")) {
      return sendJson(res, 200, { ok: true, protocolVersion: "v1", agent: "CUNONG-2", event: "steal_the_vfy" }, true);
    }

    if (req.method === "POST" && (req.url === "/steal" || req.url === "/agent" || req.url === "/agent/")) {
      const rawBody = await readBody(req);

      // 1. Verify the HMAC over the RAW body before parsing anything.
      if (hmacConfigured()) {
        const sig = req.headers["x-agent-games-signature"] || "";
        if (!sig || !timingSafeEqualHex(sig, signBody(rawBody, HMAC_SECRET, HMAC_FORMAT))) {
          return sendJson(res, 401, { error: "bad signature" });
        }
      }

      let parsed;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return sendJson(res, 400, { error: "invalid json" });
      }

      // Preflight POST (platform sends type "agent-games.preflight.v1"):
      // signed { ok: true, protocolVersion: "v1" }.
      if (parsed && (parsed.mode === "preflight" || parsed.type === "preflight" || parsed.type === "agent-games.preflight.v1")) {
        return sendJson(res, 200, { ok: true, protocolVersion: "v1" }, true);
      }

      const env = normalizeEnvelope(parsed);
      if (!env.matchId || !env.turn) {
        return sendJson(res, 400, { error: "missing matchId/turn" });
      }

      const key = `${env.matchId}:${env.turn}`;
      if (seenTurns.has(key)) {
        // Retry of the same turn: return the exact cached response
        // (same body, same idempotencyKey).
        return sendSigned(res, 200, seenTurns.get(key));
      }

      // 2. Decide the action with the CIRCUIT policy (strategy params
      // from env). Any other action fails the circuit's line-140/149
      // asserts and the turn falls back to HOLD without proof.
      const tracker = trackerFor(env.matchId);
      tracker.observe(env);
      const decision = decide(env, circuitParamsFromEnv(), tracker.snapshot());
      tracker.setMyAction(decision.action);

      // 3. Prove it. On proof failure, answer HOLD with NO policyProof
      // rather than timing out or sending a fake proof: the turn resolves
      // as HOLD (per /build a missing proof is scored as invalid proof,
      // -2 — the proof pipeline is the critical path before scored
      // rounds; see steal/proof.js).
      let action = decision.action;
      let policyProof = null;
      try {
        const proof = await generatePolicyProof(env, decision);
        policyProof = {
          circuitVersion: proof.circuitVersion,
          proof: proof.proof,
          public_signals: proof.publicSignals,
          ...(proof.publicInputsHash ? { publicInputsHash: proof.publicInputsHash } : {}),
        };
      } catch (err) {
        console.error(`[turn ${key}] proof failed, falling back to HOLD:`, err.message);
        action = "HOLD";
        policyProof = null;
      }

      // Official response shape (agentgames.zkverify.io/build).
      // amount ONLY for EXTRACT — never for HOLD/FORTIFY, even 0.
      const response = {
        matchId: env.matchId,
        turn: env.turn,
        action:
          action === "EXTRACT"
            ? { type: "EXTRACT", amount: decision.amount || 0 }
            : { type: action },
        ...(policyProof ? { policyProof } : {}),
        agentTimestamp: new Date().toISOString(),
        idempotencyKey: newIdempotencyKey(),
      };

      const body = JSON.stringify(response);
      seenTurns.set(key, body);
      return sendSigned(res, 200, body);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    console.error("server error:", err);
    return sendJson(res, 500, { error: "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`CUNONG-2 steal-the-vfy agent listening on :${PORT}`);
  console.log(`health: hmacConfigured=${hmacConfigured()} circuitsPresent=${circuitsPresent()}`);
});
