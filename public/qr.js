/* Minimal QR encoder — byte mode, ECC level L, versions 1..10.
   Exposes window.QR.matrix(text) -> 2D array of 0/1 (no quiet zone). */
(function (global) {
  'use strict';

  // --- Galois field GF(256) ------------------------------------------------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, eccLen) {
    const gen = rsGenerator(eccLen);
    const res = new Array(eccLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < eccLen; i++) res[i] ^= mul(gen[i + 1], factor);
    }
    return res;
  }

  // --- version tables (ECC level L) ----------------------------------------
  // [ eccPerBlock, [ [numBlocks, dataPerBlock], ... ] ]
  const VERSIONS = {
    1: [7, [[1, 19]]],
    2: [10, [[1, 34]]],
    3: [15, [[1, 55]]],
    4: [20, [[1, 80]]],
    5: [26, [[1, 108]]],
    6: [18, [[2, 68]]],
    7: [20, [[2, 78]]],
    8: [24, [[2, 97]]],
    9: [30, [[2, 116]]],
    10: [18, [[2, 68], [2, 69]]],
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  const dataCapacity = (v) => VERSIONS[v][1].reduce((s, [n, d]) => s + n * d, 0);

  // --- bit buffer ----------------------------------------------------------
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  // --- encode data codewords ----------------------------------------------
  function encodeBytes(bytes) {
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const lenBits = v < 10 ? 8 : 16;
      const needed = Math.ceil((4 + lenBits + bytes.length * 8) / 8);
      if (needed <= dataCapacity(v)) { version = v; break; }
    }
    if (!version) throw new Error('QR: conteúdo muito longo');

    const buf = new BitBuffer();
    buf.put(0b0100, 4);
    buf.put(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) buf.put(b, 8);

    const capBits = dataCapacity(version) * 8;
    buf.put(0, Math.min(4, capBits - buf.bits.length));
    while (buf.bits.length % 8 !== 0) buf.bits.push(0);

    const codewords = [];
    for (let i = 0; i < buf.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j];
      codewords.push(byte);
    }
    const PAD = [0xec, 0x11];
    let k = 0;
    while (codewords.length < dataCapacity(version)) codewords.push(PAD[k++ % 2]);

    // split into blocks, compute ECC, interleave
    const [eccLen, groups] = VERSIONS[version];
    const dataBlocks = [];
    const eccBlocks = [];
    let pos = 0;
    for (const [count, size] of groups) {
      for (let i = 0; i < count; i++) {
        const block = codewords.slice(pos, pos + size);
        pos += size;
        dataBlocks.push(block);
        eccBlocks.push(rsEncode(block, eccLen));
      }
    }
    const out = [];
    const maxData = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++)
      for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < eccLen; i++) for (const b of eccBlocks) out.push(b[i]);

    return { version, codewords: out };
  }

  // --- matrix construction -------------------------------------------------
  function buildMatrix(version, codewords) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));

    const setF = (r, c, v) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = v;
      fn[r][c] = true;
    };

    // finder patterns + separators
    const finder = (row, col) => {
      for (let r = -1; r <= 7; r++)
        for (let c = -1; c <= 7; c++) {
          const rr = row + r, cc = col + c;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const d = Math.max(Math.abs(r - 3), Math.abs(c - 3));
          setF(rr, cc, d === 2 || d > 3 ? 0 : 1);
        }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // timing patterns
    for (let i = 8; i < size - 8; i++) {
      setF(6, i, i % 2 === 0 ? 1 : 0);
      setF(i, 6, i % 2 === 0 ? 1 : 0);
    }

    // alignment patterns
    const centers = ALIGN[version];
    for (const r of centers)
      for (const c of centers) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++) {
            const d = Math.max(Math.abs(dr), Math.abs(dc));
            setF(r + dr, c + dc, d === 1 ? 0 : 1);
          }
      }

    // dark module + reserved format areas
    setF(size - 8, 8, 1);
    // (col/row 6 belongs to the timing patterns — must not be reserved)
    for (let i = 0; i < 9; i++) { if (i === 6) continue; setF(8, i, 0); setF(i, 8, 0); }
    for (let i = 0; i < 8; i++) { setF(8, size - 1 - i, 0); setF(size - 1 - i, 8, 0); }

    // reserved version areas (v >= 7)
    if (version >= 7) {
      for (let i = 0; i < 6; i++)
        for (let j = 0; j < 3; j++) { setF(size - 11 + j, i, 0); setF(i, size - 11 + j, 0); }
    }

    // data placement: upward/downward zigzag over column pairs, skipping col 6
    const bits = [];
    for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (fn[r][c]) continue;
          m[r][c] = bi < bits.length ? bits[bi++] : 0;
        }
      }
    }
    return { m, fn, size };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function bch(data, poly, bitsLen) {
    let d = data << (bitsLen - 1);
    const polyBits = 32 - Math.clz32(poly);
    while (32 - Math.clz32(d) >= polyBits) d ^= poly << (32 - Math.clz32(d) - polyBits);
    return (data << (bitsLen - 1)) | d;
  }

  function applyFormat(m, size, mask) {
    const data = (0b01 << 3) | mask; // ECC level L = 01
    const value = bch(data, 0x537, 11) ^ 0x5412;
    const bit = (i) => (value >>> i) & 1; // i = 0 is the LSB (bit 14 of the spec)
    // copy 1: around the top-left finder
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);
    // copy 2: right of the top-right finder + under the bottom-left one
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i);
    m[size - 8][8] = 1;
  }

  function applyVersion(m, size, version) {
    if (version < 7) return;
    const value = bch(version, 0x1f25, 13);
    for (let i = 0; i < 18; i++) {
      const b = (value >>> i) & 1;
      m[Math.floor(i / 3)][size - 11 + (i % 3)] = b;
      m[size - 11 + (i % 3)][Math.floor(i / 3)] = b;
    }
  }

  function penalty(m, size) {
    let score = 0;
    // rule 1: runs of 5+
    const run = (get) => {
      for (let a = 0; a < size; a++) {
        let last = -1, len = 0;
        for (let b = 0; b < size; b++) {
          const v = get(a, b);
          if (v === last) { len++; if (len === 5) score += 3; else if (len > 5) score += 1; }
          else { last = v; len = 1; }
        }
      }
    };
    run((a, b) => m[a][b]);
    run((a, b) => m[b][a]);
    // rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++)
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    // rule 3: finder-like patterns
    const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const check = (get, a, b) => {
      for (let i = 0; i < 11; i++) if (get(a, b + i) !== PAT[i]) return false;
      return true;
    };
    const checkRev = (get, a, b) => {
      for (let i = 0; i < 11; i++) if (get(a, b + i) !== PAT[10 - i]) return false;
      return true;
    };
    for (let a = 0; a < size; a++)
      for (let b = 0; b <= size - 11; b++) {
        if (check((x, y) => m[x][y], a, b)) score += 40;
        if (checkRev((x, y) => m[x][y], a, b)) score += 40;
        if (check((x, y) => m[y][x], a, b)) score += 40;
        if (checkRev((x, y) => m[y][x], a, b)) score += 40;
      }
    // rule 4: dark ratio
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function matrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const { version, codewords } = encodeBytes(bytes);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const { m, fn, size } = buildMatrix(version, codewords);
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
          if (!fn[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
      applyFormat(m, size, mask);
      applyVersion(m, size, version);
      const score = penalty(m, size);
      if (!best || score < best.score) best = { score, m, size };
    }
    return best.m;
  }

  function svg(text, opts) {
    const o = opts || {};
    const m = matrix(text);
    const n = m.length;
    const quiet = o.quiet === undefined ? 2 : o.quiet;
    const total = n + quiet * 2;
    let d = '';
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (m[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="${o.light || '#fff'}"/>` +
      `<path d="${d}" fill="${o.dark || '#000'}"/></svg>`
    );
  }

  const api = { matrix, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.QR = api;
})(typeof window !== 'undefined' ? window : globalThis);
