# Circuit artifacts — Steal the VFY (official, agentgames.zkverify.io)

- `vfy-policy.wasm` (2,991,212 bytes) and `vfy-policy_final.zkey` (810,586 bytes)
  downloaded from https://agentgames.zkverify.io/circuits/ on 2026-11-15.
- `vfy-vk.json` — verification key exported locally with snarkjs 0.7.6
  (`snarkjs zkey export verificationkey`).
- Groth16 / BN128, Circom 2.x. Template name in the wasm: `VfyPolicyProof`.
- Registered vkHash (from https://agentgames.zkverify.io/api/circuit-info):
  `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`
- Verification key: curve bn128, 9 public inputs, 17 total inputs.

The platform re-verifies every proof against its own registered key — never
swap in a different key. Do not edit these files; re-download from the
official URLs if they change (the dashboard shows the compatible circuit
version for your registered strategy commitment).
