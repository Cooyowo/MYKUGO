'use strict';

/**
 * KGG 音频流解密算法（QMC2 家族）。
 *
 * 按音频密钥长度分流：
 *   - 短密钥（<= 300 字节）：MapCipher —— 由 (偏移, 密钥) 推出的伪随机掩码做异或
 *   - 长密钥（>  300 字节）：Rc4Cipher —— 5120 字节分段 + 段间跳过的 RC4 式流密码
 *
 * 本文件是据公开算法规格的独立实现，常量与规格保持一致；
 * 出处与许可见 docs/format-notes.md。
 * 所有方法都接受「缓冲区 + 长度 + 该数据在音频流中的绝对偏移」，
 * 因此可以分块流式解密，无需把整个音频读进内存。
 */

const MAP_OFFSET_BOUNDARY = 0x7fffn;
const MAP_INDEX_OFFSET = 71214n;
const RC4_FIRST_SEGMENT_SIZE = 128n;
const RC4_SEGMENT_SIZE = 5120n;

function makeMapCipher(key) {
  const k = Buffer.from(key);
  const keyLen = BigInt(k.length);

  return {
    apply(buffer, length, absoluteOffset) {
      if (length < 0 || length > buffer.length) throw new Error('QMC2 缓冲区长度非法');
      if (absoluteOffset < 0n) throw new Error('QMC2 偏移不能为负');

      for (let i = 0; i < length; i++) {
        let offset = absoluteOffset + BigInt(i);
        if (offset > MAP_OFFSET_BOUNDARY) offset = offset % MAP_OFFSET_BOUNDARY;

        const keyIndex = Number(((offset * offset + MAP_INDEX_OFFSET) % keyLen));
        const value = k[keyIndex] & 0xff;
        const shift = BigInt((keyIndex & 7) + 4) % 8n;
        const shifted =
          shift === 0n
            ? value
            : Number(((BigInt(value) << shift) | (BigInt(value) >> shift)) & 0xffn);

        buffer[i] = (buffer[i] ^ shifted) & 0xff;
      }
    },
  };
}

function makeRc4Cipher(key) {
  const k = Buffer.from(key);
  const box = new Uint8Array(k.length);
  for (let i = 0; i < k.length; i++) box[i] = i;

  // KSA：用密钥打乱 S 盒
  let swapIndex = 0;
  for (let i = 0; i < k.length; i++) {
    swapIndex = (swapIndex + box[i] + (k[i] & 0xff)) % k.length;
    const t = box[i];
    box[i] = box[swapIndex];
    box[swapIndex] = t;
  }

  // 密钥哈希：所有非零字节在 2^32 内连乘
  let hash = 1n;
  for (const b of k) {
    const u = BigInt(b & 0xff);
    if (u === 0n) continue;
    const next = (hash * u) & 0xffffffffn;
    if (next === 0n || next <= hash) break;
    hash = next;
  }

  function segmentSkip(segmentId) {
    const keyLen = BigInt(k.length);
    const seed = BigInt(k[Number(segmentId % keyLen)] & 0xff);
    if (seed === 0n) return 0;
    const denominator = (segmentId + 1n) * seed;
    const idx = BigInt(Math.floor((Number(hash) / Number(denominator)) * 100));
    return Number(idx % keyLen);
  }

  function applySegment(buffer, start, segLen, segOffset) {
    const state = new Uint8Array(box);
    let j = 0;
    let kIdx = 0;
    const skip =
      Number(segOffset % RC4_SEGMENT_SIZE) + segmentSkip(segOffset / RC4_SEGMENT_SIZE);

    for (let step = 0; step < skip + segLen; step++) {
      j = (j + 1) % state.length;
      kIdx = ((state[j] & 0xff) + kIdx) % state.length;
      const tmp = state[j];
      state[j] = state[kIdx];
      state[kIdx] = tmp;

      if (step >= skip) {
        const pos = start + step - skip;
        const stream = state[((state[j] & 0xff) + (state[kIdx] & 0xff)) % state.length];
        buffer[pos] = (buffer[pos] ^ stream) & 0xff;
      }
    }
  }

  return {
    apply(buffer, length, absoluteOffset) {
      if (length < 0 || length > buffer.length) throw new Error('QMC2 缓冲区长度非法');
      if (absoluteOffset < 0n) throw new Error('QMC2 偏移不能为负');

      let offset = absoluteOffset;
      let processed = 0;
      let remaining = length;

      // 前 128 字节：直接用密钥字节异或
      if (offset < RC4_FIRST_SEGMENT_SIZE) {
        const count = Math.min(remaining, Number(RC4_FIRST_SEGMENT_SIZE - offset));
        for (let i = 0; i < count; i++) {
          const keyIndex = segmentSkip(offset + BigInt(i));
          buffer[processed + i] = (buffer[processed + i] ^ k[keyIndex]) & 0xff;
        }
        offset += BigInt(count);
        processed += count;
        remaining -= count;
      }

      // 对齐到 5120 边界
      if (remaining > 0 && offset % RC4_SEGMENT_SIZE !== 0n) {
        const toBoundary = Number(RC4_SEGMENT_SIZE - (offset % RC4_SEGMENT_SIZE));
        const count = Math.min(remaining, toBoundary);
        applySegment(buffer, processed, count, offset);
        offset += BigInt(count);
        processed += count;
        remaining -= count;
      }

      // 完整的 5120 字节段
      while (remaining > Number(RC4_SEGMENT_SIZE)) {
        applySegment(buffer, processed, Number(RC4_SEGMENT_SIZE), offset);
        offset += RC4_SEGMENT_SIZE;
        processed += Number(RC4_SEGMENT_SIZE);
        remaining -= Number(RC4_SEGMENT_SIZE);
      }

      // 末尾不足一段
      if (remaining > 0) applySegment(buffer, processed, remaining, offset);
    },
  };
}

/** 按密钥长度选择实现。 */
function makeCipher(key) {
  if (!key || key.length === 0) throw new Error('QMC2 音频密钥为空');
  return key.length <= 300 ? makeMapCipher(key) : makeRc4Cipher(key);
}

module.exports = {
  makeCipher,
  makeMapCipher,
  makeRc4Cipher,
  MAP_OFFSET_BOUNDARY,
  MAP_INDEX_OFFSET,
  RC4_FIRST_SEGMENT_SIZE,
  RC4_SEGMENT_SIZE,
};
