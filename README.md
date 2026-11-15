# Steal the VFY — Agent CUNONG-2

Agent for the **Steal the VFY** track of zkVerify Agent Games Season 01
(21 Oct – 21 Nov 2026). One Node.js server, no framework, plain `http`.

- Track: head-to-head strategy match, 20 turns, starting balance 100 VFY each
  (simulated — no real value moves). Actions: `FORTIFY` / `EXTRACT` / `HOLD`.
- Every turn must carry a Groth16 **policy proof** (circuit `vfy-policy`,
  Groth16/BN128, Circom 2.x) proving the action follows the strategy committed
  at registration. The platform re-verifies the proof against its own
  registered verification key.
- Score: win +18, draw +9, loss +3, reliability bonus +0..+2 per match,
  timeout −1/turn, invalid proof −2/turn. Swiss 5 rounds (7 rounds total
  per /build) → Top 16 knockout.

Sources (official): https://agentgames.zkverify.io/build ·
https://agentgames.zkverify.io/events/steal-the-vfy ·
https://agentgames.zkverify.io/rules ·
circuit info: https://agentgames.zkverify.io/api/circuit-info

## Game numbers (official, /build)

- **FORTIFY** — costs 2 VFY, blocks up to **6 VFY** (flat) of incoming
  extraction.
- **EXTRACT** — free, takes up to N VFY (max 10) from the opponent's
  spendable balance. A fortified opponent reduces the effective gain by 6.
- **HOLD** — free, no transfer.
- 100 VFY starting balance, 20 turns, highest balance wins.

Shield timing (assumption — see `steal/strategy.js`): FORTIFY played on
turn t pays 2 and sets `fortifiedUntilTurn = t+1`; the shield is active
during the NEXT turn's resolution. Confirm from the first practice turns.

## Quick start

```bash
npm install
cp .env.example .env   # fill AGENT_GAMES_HMAC_SECRET from the dashboard
node server.js         # listens on $PORT (default 8080)
# health:  GET /health
# turns:   POST /agent   (POST /steal is an alias)
```

Deploy the server to a public HTTPS host (the platform requires a public
HTTPS endpoint — no localhost, no private IPs, no custom ports). Railway is
the proven path for this tournament (deploy from this repo; the dashboard
registers the `https://<app>.up.railway.app/agent` URL). Free-tier hosts that
sleep after inactivity will cost you turns — use a host that stays awake.
`railway.json` is included (NIXPACKS, `node server.js`, healthcheck
`/health`). Set `AGENT_GAMES_HMAC_SECRET` in the Railway dashboard —
never commit it.

## Registration checklist (dashboard)

1. Register the agent: name `CUNONG-2`, check **only** `Steal the VFY`,
   repository URL = this repo, endpoint = `https://<your-host>/agent`
   (endpoint is optional at registration and can be added later).
   ✅ DONE 16 Nov 2026 ~02:15 WIB — registration accepted, pending first
   health check.
2. Copy the HMAC secret from the dashboard ("Rotate Secret") into `.env`
   as `AGENT_GAMES_HMAC_SECRET`. It is shown exactly once — never commit it.
   ✅ DONE — stored in local `.env` (gitignored).
3. Complete the **signed preflight** and at least **1 practice turn** from the
   dashboard. The practice turn is the first real turn envelope you will see:
   confirm the exact field names against `steal/protocol.js` (already
   matched to /build) and the shield timing against `steal/strategy.js`.
4. **Commit the strategy** before the next Swiss pairing — the platform
   cannot pair you without an active commitment. The commitment is the
   hash of the POLICY CIRCUIT (vkHash
   `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`),
   NOT a hash of parameters+salt. The dashboard shows the commitment it
   expects when you tap "Set up strategy commitment" — compare it with
   `steal/proof.js` `commitmentHash()` (marked UNVERIFIED) before trusting
   any value. `circuitVersion` sent in proofs is `"v1"`.

## How a turn works

1. The platform POSTs a signed turn envelope to `/agent`. It contains:
   `protocolVersion`, `eventId`, `mode`, `matchId`, `turn`, `issuedAt`,
   `deadlineAt`, `state` (`selfBalance`, `opponentBalance`,
   `selfFortifiedUntilTurn`, `opponentFortifiedUntilTurn` — balances are
   decimal strings), `strategyCommitment.hash`, `resolverVersion`, `nonce`.
2. The server verifies the `x-agent-games-signature` HMAC-SHA256 header over
   the raw body **before parsing**. Bad signature → 401, nothing else.
3. `steal/strategy.js` picks an action from the state (see Strategy below).
4. `steal/proof.js` generates the Groth16 policy proof locally with snarkjs
   and the official `vfy-policy` circuit, and returns it with the response.
5. The response echoes `matchId` + `turn`, declares the action as an
   object (`{ type: "EXTRACT", amount: N }` — `amount` ONLY for EXTRACT,
   never for HOLD/FORTIFY), attaches `policyProof` (`circuitVersion: "v1"`,
   raw snarkjs `proof`, `public_signals` in output-then-public order,
   optional `publicInputsHash`), plus `agentTimestamp` and a fresh
   `idempotencyKey` (UUID, unique per turn), and is signed with the same
   HMAC over the raw response body.
6. Retries of the same turn (same `matchId`+`turn`) return the cached
   response — the idempotency key is never reused for a different turn.
7. Turn deadline is 5 minutes; the platform waits ~30 s per push. If proof
   generation fails, the server answers `HOLD` with no proof instead of
   timing out or sending a fake proof (a missing proof scores the turn as
   HOLD with an invalid-proof −2 — so the proof pipeline in
   `steal/proof.js` is the critical path before any scored round).

## Strategy

See `steal/strategy.js` and `steal/simulator.js`.

- `EXTRACT` is free and takes a bounded amount from the opponent's exposed
  balance, so against an unfortified opponent it dominates `HOLD`.
- `FORTIFY` costs 2 and blocks up to 6 VFY of the opponent's next
  extraction; it pays when the opponent is about to extract and the amount
  it shields exceeds its cost — typically when you are ahead and the lead
  is worth defending, or late in the match.
- `HOLD` preserves state; it is the safe answer only when extraction would
  gain nothing (opponent fully protected / exposed balance ~0) and fortifying
  would cost more than it shields.

The policy is parameterized (`FORTIFY_COST`, `EXTRACT_CAP`,
`FORTIFY_BLOCK` in `.env` / `steal/strategy.js`) with the official
numbers as defaults. `simulator.js` runs self-play across a sensitivity
grid (cost 1–3 × cap 5–15 × block 3–9) — the policy never loses to
always-EXTRACT (mirror draws) and beats always-HOLD / always-FORTIFY at
every grid point, including the official point (2/10/6).

## Files

| File | What it is |
|---|---|
| `server.js` | HTTP server: `GET /health`, `GET /agent` (preflight), `POST /agent` (+ `/steal` alias), HMAC, idempotency, signed responses |
| `steal/protocol.js` | Turn-envelope parsing, response building, HMAC helpers |
| `steal/strategy.js` | Parameterized policy: FORTIFY / EXTRACT / HOLD decision + opponent tracker |
| `steal/simulator.js` | Self-play simulator + sensitivity grid |
| `steal/proof.js` | Groth16 policy-proof generation (snarkjs + official circuit) + `publicInputsHash` (keccak256) |
| `steal/keccak.js` | Pure-JS Keccak-256 (verified vs pycryptodome + standard vectors) |
| `circuits/` | Official `vfy-policy` artifacts from agentgames.zkverify.io |
| `test/strategy.test.js` | Strategy + simulator checks (no network, no secrets) |
| `test/smoke.js` | Local end-to-end smoke test (loads `.env`, replays a signed /build envelope) |
| `railway.json` | Railway deploy config (NIXPACKS, healthcheck `/health`) |

## Open items (fill in from the dashboard / platform)

1. **Policy-proof input mapping** — the `vfy-policy` circuit takes 17 inputs
   (9 public). The signal NAMES are not published on `/build`,
   `/api/circuit-info`, in the wasm (obfuscated names only), or as a `.sym`
   file (404). The 8 public input VALUES are known from the
   `publicInputsHash` formula on `/build` (commitment, matchId, turn,
   selfBalance, opponentBalance, actionCode, amount, 1) — but the witness
   needs the signal names. Next step: obtain the `.circom` source or the
   `.sym` file for `vfy-policy` from the platform, fill `INPUT_MAPPING`
   in `steal/proof.js`, then run `node -e "require('./steal/proof').selfTest()"`.
   A practice turn envelope does NOT carry signal names.
2. **Shield timing** — `fortifiedUntilTurn = turn+1` (next-turn shield) is
   an assumption from the envelope fields' existence. Confirm from the
   first practice resolutions (fortify on turn t, see whether the
   opponent's extraction on turn t or t+1 is reduced by 6).
3. **Strategy commitment hash function** — the dashboard shows the
   commitment it expects; `commitmentHash()` in `steal/proof.js` is
   marked UNVERIFIED (old SHA256 params+salt guess) and must be compared
   against the dashboard value before use.

## Security

No wallet keys, seeds, or private keys live on this server and it never
signs a transaction or spends anything. The only secret is the HMAC secret
from the dashboard (`.env`, never committed). Never paste a private key,
wallet seed, or API key into any tool or repo.
