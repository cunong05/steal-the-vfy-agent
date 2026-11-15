// Local smoke test for the Steal the VFY agent (CUNONG-2).
// Loads .env into process.env WITHOUT printing it, starts server.js on a
// test port, and replays an official /build turn envelope signed with the
// HMAC secret from .env. Expects the HOLD fallback (INPUT_MAPPING is
// still empty, so no proof can be generated yet) — with the OFFICIAL
// response shape: action object, no amount for HOLD, agentTimestamp,
// idempotencyKey, signed response.
// Run: node test/smoke.js
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const DIR = path.join(__dirname, "..");
const PORT = 18081;

// Load .env (never log its values).
const env = { ...process.env };
for (const line of fs.readFileSync(path.join(DIR, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
env.PORT = String(PORT);
assert.ok(env.AGENT_GAMES_HMAC_SECRET && env.AGENT_GAMES_HMAC_SECRET.length >= 16, ".env must have a real HMAC secret");

function hmac(body) {
  return crypto.createHmac("sha256", env.AGENT_GAMES_HMAC_SECRET).update(body).digest("hex");
}

function req(method, url, bodyObj, sign = true) {
  return new Promise((resolve, reject) => {
    const body = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), "utf8");
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: url, method, headers: body ? { "content-type": "application/json", "content-length": body.length, ...(sign ? { "x-agent-games-signature": hmac(body) } : {}) } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const child = spawn("node", ["server.js"], { cwd: DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  child.stdout.on("data", (d) => { serverLog += d; });
  child.stderr.on("data", (d) => { serverLog += d; });
  try {
    await sleep(1500);

    // 1. Health.
    const health = await req("GET", "/health");
    assert.strictEqual(health.status, 200, "GET /health 200");
    const h = JSON.parse(health.body);
    assert.strictEqual(h.hmacConfigured, true, "health: hmacConfigured true");
    assert.strictEqual(h.circuitVersion, "v1", "health: circuitVersion v1");
    assert.strictEqual(h.circuitsPresent, true, "health: circuits present");
    console.log("health OK:", JSON.stringify({ status: h.status, agent: h.agent, hmacConfigured: h.hmacConfigured, circuitVersion: h.circuitVersion }));

    // 2. Preflight GET /agent.
    const pre = await req("GET", "/agent");
    assert.strictEqual(pre.status, 200, "GET /agent 200");
    const preJson = JSON.parse(pre.body);
    assert.strictEqual(preJson.ok, true);
    assert.strictEqual(preJson.protocolVersion, "v1");
    assert.ok(pre.headers["x-agent-games-signature"], "preflight response signed");
    console.log("preflight GET /agent OK");

    // 3. Official turn envelope (from /build, turn 3, 95 vs 105).
    const envelope = {
      protocolVersion: "v1",
      eventId: "steal-the-vfy",
      mode: "competition",
      matchId: "9f4e1b2a-1111-4222-8333-444455556666",
      turn: 3,
      issuedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      state: { selfBalance: "95", opponentBalance: "105", selfFortifiedUntilTurn: null, opponentFortifiedUntilTurn: null },
      strategyCommitment: { hash: "0x7d00000000000000000000000000000000000000000000000000000000000091" },
      resolverVersion: "v1",
      nonce: "3c2f1a00000000000000000000000000",
    };
    const turn1 = await req("POST", "/agent", envelope);
    assert.strictEqual(turn1.status, 200, `POST /agent 200 (got ${turn1.status}: ${turn1.body})`);
    const t1 = JSON.parse(turn1.body);
    assert.strictEqual(t1.matchId, envelope.matchId, "echo matchId");
    assert.strictEqual(t1.turn, 3, "echo turn");
    // INPUT_MAPPING empty -> proof fails -> HOLD fallback, no policyProof.
    assert.deepStrictEqual(t1.action, { type: "HOLD" }, "fallback action is HOLD with no amount");
    assert.strictEqual(t1.policyProof, undefined, "no policyProof on fallback (never send a fake proof)");
    assert.ok(typeof t1.agentTimestamp === "string" && t1.agentTimestamp.length > 0, "agentTimestamp present");
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t1.idempotencyKey), "idempotencyKey is a UUID");
    assert.strictEqual(turn1.headers["x-agent-games-signature"], hmac(turn1.body), "response signature valid");
    console.log("POST /agent turn 3 OK (HOLD fallback, official shape):", JSON.stringify({ action: t1.action, idempotencyKey: t1.idempotencyKey }));

    // 4. Retry of the same turn returns the identical body + key.
    const retry = await req("POST", "/agent", envelope);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(retry.body, turn1.body, "retry returns cached body");
    console.log("retry same turn OK (identical body)");

    // 5. Bad signature -> 401.
    const bad = await req("POST", "/agent", { ...envelope, turn: 4 }, false);
    assert.strictEqual(bad.status, 401, "unsigned POST -> 401");
    console.log("unsigned POST -> 401 OK");

    // 6. /steal alias works (different turn).
    const turn4 = await req("POST", "/steal", { ...envelope, turn: 4 });
    assert.strictEqual(turn4.status, 200, "POST /steal 200");
    const t4 = JSON.parse(turn4.body);
    assert.strictEqual(t4.turn, 4);
    assert.notStrictEqual(t4.idempotencyKey, t1.idempotencyKey, "different turn => different idempotencyKey");
    console.log("POST /steal alias OK");

    console.log("smoke test: ALL PASSED");
  } finally {
    child.kill("SIGTERM");
  }
})().catch((err) => {
  console.error("smoke test FAILED:", err.message);
  process.exit(1);
});
