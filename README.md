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
  timeout −1/turn, invalid proof −2/turn. Swiss 5 rounds → Top 16 knockout.

Sources (official): https://agentgames.zkverify.io/events/steal-the-vfy ·
https://agentgames.zkverify.io/build · https://agentgames.zkverify.io/rules ·
circuit info: https://agentgames.zkverify.io/api/circuit-info

## Quick start

```bash
npm install
cp .env.example .env   # fill AGENT_GAMES_HMAC_SECRET from the dashboard
node server.js         # listens on $PORT (default 8080)
# health:  GET /health
# turns:   POST /steal
```

Deploy the server to a public HTTPS host (the platform requires a public
HTTPS endpoint — no localhost, no private IPs, no custom ports). Railway is
the proven path for this tournament (deploy from this repo; the dashboard
registers the `https://<app>.up.railway.app/steal` URL). Free-tier hosts that
sleep after inactivity will cost you turns — use a host that stays awake.

## Registration checklist (dashboard)

1. Register the agent: name `CUNONG-2`, check **only** `Steal the VFY`,
   repository URL = this repo, endpoint = `https://<your-host>/steal`
   (endpoint is optional at registration and can be added later).
2. Copy the HMAC secret from the dashboard ("Rotate Secret") into `.env`
   as `AGENT_GAMES_HMAC_SECRET`. It is shown exactly once — never commit it.
3. Complete the **signed preflight** and at least **1 practice turn** from the
   dashboard. The practice turn is the first real turn envelope you will see:
   confirm the exact field names against `steal/protocol.js` and fill in
   `steal/proof.js` `INPUT_MAPPING` (see "Open items" below).
4. **Commit the strategy** before Swiss Round 1 opens — the platform cannot
   pair you without an active commitment. The commitment is the hash of the
   strategy parameters + salt (`STEAL_STRATEGY_PARAMS` /
   `STEAL_STRATEGY_SALT`); the dashboard shows the commitment it expects.

## How a turn works

1. The platform POSTs a signed turn envelope to `/steal`. It contains the
   game state: both balances, your frozen commitment hash, and the deadline.
2. The server verifies the `x-agent-games-signature` HMAC-SHA256 header over
   the raw body **before parsing**. Bad signature → 401, nothing else.
3. `steal/strategy.js` picks an action from the state (see Strategy below).
4. `steal/proof.js` generates the Groth16 policy proof locally with snarkjs
   and the official `vfy-policy` circuit, and returns it with the response.
5. The response echoes `matchId` + `turn`, declares the action, attaches the
   proof (`circuitVersion`, Groth16 `proof`, `publicSignals`), and is signed
   with the same HMAC over the raw response body.
6. Retries of the same turn (same `matchId`+`turn`) return the cached
   response — the idempotency key is never reused for a different turn.
7. Turn deadline is 5 minutes; the platform waits ~30 s per push. If proof
   generation fails, the server answers `HOLD` with no proof instead of
   timing out (a missing proof scores the turn as HOLD; a submitted-but-
   invalid proof costs −2; a timeout costs −1 and the opponent keeps
   extracting against forced HOLDs).

## Strategy

See `steal/strategy.js` and `steal/simulator.js`.

- `EXTRACT` is free and takes a bounded amount from the opponent's exposed
  balance, so against an unfortified opponent it dominates `HOLD`.
- `FORTIFY` costs a small fixed amount and protects part of your balance for
  the next resolution; it pays when the opponent is about to extract and the
  amount it shields exceeds its cost — typically when you are ahead and the
  lead is worth defending, or late in the match.
- `HOLD` preserves state; it is the safe answer only when extraction would
  gain nothing (opponent fully protected / exposed balance ~0) and fortifying
  would cost more than it shields.

The policy is parameterized (`FORTIFY_COST`, `EXTRACT_CAP`,
`PROTECTED_FRACTION` in `.env` / `steal/strategy.js`) because the exact
numbers are not published on the public pages — they are revealed by the
turn envelopes and by observing resolutions in practice. `simulator.js`
runs self-play across a grid of those parameters so the policy can be
calibrated the moment real numbers arrive. Until then the defaults encode
the game-theoretic shape above, not tuned constants.

## Files

| File | What it is |
|---|---|
| `server.js` | HTTP server: `GET /health`, `POST /steal`, HMAC, idempotency, signed responses |
| `steal/protocol.js` | Turn-envelope parsing, response building, HMAC helpers |
| `steal/strategy.js` | Parameterized policy: FORTIFY / EXTRACT / HOLD decision |
| `steal/simulator.js` | Self-play simulator + grid calibration of the policy |
| `steal/proof.js` | Groth16 policy-proof generation (snarkjs + official circuit) |
| `circuits/` | Official `vfy-policy` artifacts from agentgames.zkverify.io |
| `test/strategy.test.js` | Strategy + simulator checks (no network, no secrets) |

## Open items (fill in from the dashboard practice turn)

1. **Exact turn-envelope field names** — the public pages say the envelope
   carries "both balances, your frozen commitment hash, and the deadline"
   plus `matchId`/`turn`; the exact JSON keys must be confirmed from the
   first practice envelope and mirrored in `steal/protocol.js`.
2. **Policy-proof input mapping** — the `vfy-policy` circuit takes 17 inputs
   (9 public). The signal names and the `publicInputsHash` field order are
   not published on the public pages; they come from the practice flow.
   `steal/proof.js` has a single `INPUT_MAPPING` table for exactly this.
3. **Game numbers** — FORTIFY cost, EXTRACT cap, protected fraction. Calibrate
   via `steal/simulator.js` once practice resolutions show them.
4. **Strategy commitment hash function** — the dashboard shows the commitment
   it expects; make `steal/proof.js` `commitmentHash()` match it.

## Security

No wallet keys, seeds, or private keys live on this server and it never
signs a transaction or spends anything. The only secret is the HMAC secret
from the dashboard (`.env`, never committed). Never paste a private key,
wallet seed, or API key into any tool or repo.
