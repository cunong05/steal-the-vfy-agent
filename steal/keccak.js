// Minimal pure-JS Keccak-256 (Keccak-f[1600], rate 1088, pad10*1).
// No dependencies — the agent runs on Railway with only snarkjs installed.
//
// Verified against:
//   keccak256("")    = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
//   keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
// and cross-checked on random inputs against ~/workspace/pheromone/keccak.py
// (run: node -e "require('./steal/keccak').selfTest()" — see bottom).
//
// Round constants (64-bit, shown as [hi, lo] 32-bit limbs). NOTE RC[23] =
// 0x8000000080008008 — bit 31 set. The commonly-copied table has
// 0x8000000000008008 (bit 31 missing); that flips bit 31 of lane 0 and
// breaks any hash that needs it. Always verify against keccak256("") first.
"use strict";

const RC = [
  [0x00000000, 0x00000001], [0x00000000, 0x00008082],
  [0x80000000, 0x0000808a], [0x80000000, 0x80008000],
  [0x00000000, 0x0000808b], [0x00000000, 0x80000001],
  [0x80000000, 0x80008081], [0x80000000, 0x00008009],
  [0x00000000, 0x0000008a], [0x00000000, 0x00000088],
  [0x00000000, 0x80008009], [0x00000000, 0x8000000a],
  [0x00000000, 0x8000808b], [0x80000000, 0x0000008b],
  [0x80000000, 0x00008089], [0x80000000, 0x00008003],
  [0x80000000, 0x00008002], [0x80000000, 0x00000080],
  [0x00000000, 0x0000800a], [0x80000000, 0x8000000a],
  [0x80000000, 0x80008081], [0x80000000, 0x00008080],
  [0x00000000, 0x80000001], [0x80000000, 0x80008008],
];

// Rho offsets r[x][y] (Keccak spec / FIPS 202).
const RHO = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

// 64-bit lane as [hi, lo] (unsigned 32-bit halves). All ops use >>> 0.
function rotl64(lane, n) {
  const [hi, lo] = lane;
  if (n === 0) return [hi, lo];
  if (n < 32) {
    return [
      (((hi << n) | (lo >>> (32 - n))) >>> 0),
      (((lo << n) | (hi >>> (32 - n))) >>> 0),
    ];
  }
  // n >= 32: halves swap, rotate by n-32.
  const m = n - 32;
  return [
    (((lo << m) | (hi >>> (32 - m))) >>> 0),
    (((hi << m) | (lo >>> (32 - m))) >>> 0),
  ];
}

function xor64(a, b) {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

function notAnd64(a, b) {
  // (~a) & b, per 32-bit half.
  return [(~a[0] & b[0]) >>> 0, (~a[1] & b[1]) >>> 0];
}

// State: 25 lanes, index = x + 5*y.
function keccakF1600(s) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const C = [];
    for (let x = 0; x < 5; x++) {
      let c = [0, 0];
      for (let y = 0; y < 5; y++) c = xor64(c, s[x + 5 * y]);
      C.push(c);
    }
    const D = [];
    for (let x = 0; x < 5; x++) {
      D.push(xor64(C[(x + 4) % 5], rotl64(C[(x + 1) % 5], 1)));
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s[x + 5 * y] = xor64(s[x + 5 * y], D[x]);
    }
    // Rho + Pi: B[y][(2x+3y)%5] = ROT(A[x][y], r[x][y])
    const B = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], RHO[x][y]);
      }
    }
    // Chi: A[x][y] = B[x][y] ^ ((~B[(x+1)%5][y]) & B[(x+2)%5][y])
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        s[x + 5 * y] = xor64(
          B[x + 5 * y],
          notAnd64(B[((x + 1) % 5) + 5 * y], B[((x + 2) % 5) + 5 * y])
        );
      }
    }
    // Iota
    s[0] = xor64(s[0], RC[round]);
  }
}

// Keccak-256 of a Buffer/Uint8Array/string (UTF-8). Returns 0x-less hex.
function keccak256(input) {
  const data = Buffer.isBuffer(input)
    ? input
    : Buffer.from(typeof input === "string" ? input : input, "utf8");
  const RATE = 136; // bytes (1088 bits)
  const state = Array.from({ length: 25 }, () => [0, 0]);
  let off = 0;
  while (off + RATE <= data.length) {
    for (let i = 0; i < RATE / 8; i++) {
      const lo = data.readUInt32LE(off + i * 8);
      const hi = data.readUInt32LE(off + i * 8 + 4);
      state[i] = xor64(state[i], [hi, lo]);
    }
    keccakF1600(state);
    off += RATE;
  }
  // Last block + pad10*1 (0x01 ... 0x80).
  const tail = Buffer.alloc(RATE, 0);
  data.copy(tail, 0, off);
  tail[data.length - off] ^= 0x01;
  tail[RATE - 1] ^= 0x80;
  for (let i = 0; i < RATE / 8; i++) {
    const lo = tail.readUInt32LE(i * 8);
    const hi = tail.readUInt32LE(i * 8 + 4);
    state[i] = xor64(state[i], [hi, lo]);
  }
  keccakF1600(state);
  // Squeeze 32 bytes, little-endian per lane.
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeUInt32LE(state[i][1], i * 8);
    out.writeUInt32LE(state[i][0], i * 8 + 4);
  }
  return out.toString("hex");
}

function selfTest() {
  const vectors = [
    ["", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
  ];
  let ok = true;
  for (const [input, want] of vectors) {
    const got = keccak256(input);
    if (got !== want) {
      console.error(`keccak selfTest FAIL: input=${JSON.stringify(input)} got=${got} want=${want}`);
      ok = false;
    }
  }
  console.log(`keccak selfTest: ${ok ? "PASS" : "FAIL"} (${vectors.length} vectors)`);
  return ok;
}

if (require.main === module) {
  if (!selfTest()) process.exit(1);
  // Extra: cross-check helper — print hash of argv input for comparison
  // against ~/workspace/pheromone/keccak.py sel().
  if (process.argv[2] !== undefined) {
    console.log(keccak256(process.argv[2]));
  }
}

module.exports = { keccak256, selfTest };
