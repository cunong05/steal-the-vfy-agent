// Steal the VFY agent — server
// Node.js, no framework, plain http. See README.md for the protocol.
//
//   GET  /health  -> readiness (hmac configured? proof artifacts present?)
//   POST /steal   -> signed turn envelope in, signed action+proof out
//
// Env (see .env.example):
//   PORT, AGENT_GAMES_HMAC_SECRET, STEAL_STRATEGY_* , CIRCUIT_VERSION
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { verifyHmac, signBody, timingSafeEqualHex } = require("./steal/protocol");
const { decide, createTracker, paramsFromEnv } = require("./steal/strategy");
const { generatePolicyProof, CIRCUIT_VERSION } = require("./steal/proof");

const PORT = Number(process.env.PORT || 8080);
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || "";
const HMAC_FORMAT = (process.env.AGENT_GAMES_HMAC_FORMAT || "hex").toLowerCase();

const CIRCUITS_DIR = path.join(__dirname, "circuits");
const WASM_PATH = path.join(CIRCUITS_DIR, "vfy-policy.wasm");
const ZKEY_PATH = path.join(CIRCUITS_DIR, "vfy-policy_final.zkey");

// Idempotency: matchId + turn -> cached response body (string).
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

// Minimal envelope normalization. The exact JSON keys of the turn envelope
// are confirmed from the first practice envelope (see steal/protocol.js);
// unknown extra fields are preserved and passed to the strategy as-is.
function normalizeEnvelope(raw) {
  const e = raw || {};
  return {
    matchId: e.matchId ?? e.match_id ?? e.matchID ?? null,
    turn: Number(e.turn ?? e.turnNumber ?? e.turn_number ?? 0),
    myBalance: Number(e.myBalance ?? e.my_balance ?? e.balance ?? 100),
    oppBalance: Number(e.oppBalance ?? e.opp_balance ?? e.opponentBalance ?? 100),
    // Optional fields the envelope may carry (fortify state, deadline, ...).
    commitmentHash: e.commitmentHash ?? e.commitment_hash ?? e.commitment ?? null,
    deadline: e.deadline ?? null,
    raw: e,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, healthPayload());
    }

    if (req.method === "POST" && (req.url === "/steal" || req.url === "/agent")) {
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

      const env = normalizeEnvelope(parsed);
      if (!env.matchId || !env.turn) {
        return sendJson(res, 400, { error: "missing matchId/turn" });
      }

      const key = `${env.matchId}:${env.turn}`;
      if (seenTurns.has(key)) {
        // Retry of the same turn: return the exact cached response.
        const cached = seenTurns.get(key);
        res.writeHead(200, {
          "content-type": "application/json",
          ...(hmacConfigured()
            ? { "x-agent-games-signature": signBody(cached, HMAC_SECRET, HMAC_FORMAT) }
            : {}),
        });
        return res.end(cached);
      }

      // 2. Decide the action (per-match memory infers the opponent's
      // last action from balance deltas).
      const tracker = trackerFor(env.matchId);
      tracker.observe(env);
      const decision = decide(env, paramsFromEnv(), tracker.snapshot());
      tracker.setMyAction(decision.action);

      // 3. Prove it. On proof failure, answer HOLD with no proof rather
      // than timing out: a missing proof scores the turn as HOLD, while a
      // submitted-but-invalid proof costs -2 and a timeout costs -1 plus
      // the opponent keeps extracting against forced HOLDs.
      let action = decision.action;
      let proof = null;
      try {
        proof = await generatePolicyProof(env, decision);
      } catch (err) {
        console.error(`[turn ${key}] proof failed, falling back to HOLD:`, err.message);
        action = "HOLD";
        proof = null;
      }

      const response = {
        matchId: env.matchId,
        turn: env.turn,
        action,
        ...(action === "EXTRACT" ? { amount: decision.amount } : {}),
        ...(proof
          ? {
              proof: {
                circuitVersion: CIRCUIT_VERSION,
                proof: proof.proof,
                publicSignals: proof.publicSignals,
              },
              ...(proof.publicInputsHash ? { publicInputsHash: proof.publicInputsHash } : {}),
              ...(proof.proofReference ? { proofReference: proof.proofReference } : {}),
            }
          : {}),
      };

      const body = JSON.stringify(response);
      seenTurns.set(key, body);
      res.writeHead(200, {
        "content-type": "application/json",
        ...(hmacConfigured()
          ? { "x-agent-games-signature": signBody(body, HMAC_SECRET, HMAC_FORMAT) }
          : {}),
      });
      return res.end(body);
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
