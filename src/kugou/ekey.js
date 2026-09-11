'use strict';

/**
 * 酷狗 EnKey 解包（把密钥库里的 EnKey 还原成音频流密钥）。
 *
 * 两步：
 *   1) （可选）若 Base64 解出的内容以 "QQMusic EncV2,Key:" 开头，
 *      先剥掉前缀，再用两把固定密钥做两次 Tencent-TEA 解密，再 Base64 解一次。
 *   2) deriveV1：用固定 8 字节 simpleKey 与原始密钥前 8 字节交替组成 TEA 密钥，
 *      对第 8 字节之后的部分做 Tencent-TEA 解密，拼回前 8 字节得到音频密钥。
 *
 * Tencent-TEA = 标准 TEA 解密 + CBC 式链式异或 + 零填充校验，
 * 注意其 64 位中间量语义（不能简单按 32 位截断），故这里用 BigInt 精确复现。
 *
 * 规格出处：见 docs/format-notes.md。
 */

const V2_PREFIX = Buffer.from('QQMusic EncV2,Key:', 'ascii');
const SIMPLE_KEY = Buffer.from([0x69, 0x56, 0x46, 0x38, 0x2b, 0x20, 0x15, 0x0b]);
const V2_KEY1 = Buffer.from([
  0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40,
  0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28,
]);
const V2_KEY2 = Buffer.from([
  0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25,
  0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54,
]);

const MASK32 = 0xffffffffn;
const DELTA = 0x9e3779b9n;
const TEA_CYCLES = 16;

/** 标准 TEA 解密单个 8 字节块（大端）。 */
function teaDecryptBlock(block, key) {
  const k = [];
  for (let i = 0; i < 4; i++) k.push(BigInt(key.readUInt32BE(i * 4)));

  let v0 = BigInt(block.readUInt32BE(0));
  let v1 = BigInt(block.readUInt32BE(4));
  let sum = (DELTA * BigInt(TEA_CYCLES)) & MASK32;

  for (let i = 0; i < TEA_CYCLES; i++) {
    v1 = (v1 - (((v0 << 4n) + k[2]) ^ (v0 + sum) ^ ((v0 >> 5n) + k[3]))) & MASK32;
    v0 = (v0 - (((v1 << 4n) + k[0]) ^ (v1 + sum) ^ ((v1 >> 5n) + k[1]))) & MASK32;
    sum = (sum - DELTA) & MASK32;
  }

  const out = Buffer.alloc(8);
  out.writeUInt32BE(Number(v0), 0);
  out.writeUInt32BE(Number(v1), 4);
  return out;
}

/** Tencent-TEA 解密（链式异或 + 零填充校验）。 */
function decryptTencentTea(input, key) {
  if (input.length < 16) throw new Error('Tencent TEA 密文过短（至少 16 字节）');
  if (input.length % 8 !== 0) throw new Error('Tencent TEA 密文长度未按 8 字节对齐');
  if (key.length !== 16) throw new Error('Tencent TEA 密钥必须是 16 字节');

  let decrypted = teaDecryptBlock(input.subarray(0, 8), key);
  const padding = decrypted[0] & 7;
  const outputLength = input.length - 1 - padding - 2 - 7;
  if (outputLength < 0) throw new Error('Tencent TEA 填充长度非法');

  let previousCipher = Buffer.alloc(8);
  let currentCipher = input.subarray(0, 8);
  let inputOffset = 8;
  let decryptedOffset = 1 + padding;

  function nextBlock() {
    if (inputOffset + 8 > input.length) throw new Error('Tencent TEA 密文被截断');
    previousCipher = currentCipher;
    currentCipher = input.subarray(inputOffset, inputOffset + 8);
    const mixed = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) mixed[i] = decrypted[i] ^ currentCipher[i];
    decrypted = teaDecryptBlock(mixed, key);
    inputOffset += 8;
    decryptedOffset = 0;
  }

  for (let i = 0; i < 2; i++) {
    if (decryptedOffset === 8) nextBlock();
    decryptedOffset++;
  }

  const out = Buffer.alloc(outputLength);
  for (let i = 0; i < outputLength; i++) {
    if (decryptedOffset === 8) nextBlock();
    out[i] = decrypted[decryptedOffset] ^ previousCipher[decryptedOffset];
    decryptedOffset++;
  }

  for (let i = 0; i < 7; i++) {
    if (decryptedOffset === 8) nextBlock();
    const value = decrypted[decryptedOffset] ^ previousCipher[decryptedOffset];
    if (value !== 0) throw new Error('Tencent TEA 零填充校验失败（密钥或数据不对）');
    decryptedOffset++;
  }

  return out;
}

/** 由原始密钥派生最终音频密钥。 */
function deriveV1(raw) {
  if (raw.length < 16) throw new Error(`EnKey 内容过短（${raw.length} 字节，至少 16）`);

  const teaKey = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    teaKey[i * 2] = SIMPLE_KEY[i];
    teaKey[i * 2 + 1] = raw[i];
  }
  const suffix = decryptTencentTea(raw.subarray(8), teaKey);
  return Buffer.concat([raw.subarray(0, 8), suffix]);
}

/** Base64 解码（严格校验长度，避免静默产出错密钥）。 */
function decodeBase64(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) throw new Error('EnKey 为空');
  if (encoded.length % 4 !== 0) throw new Error(`EnKey Base64 长度非法：${encoded.length}`);
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length === 0) throw new Error('EnKey Base64 解码结果为空');
  return buf;
}

/**
 * 解包 EnKey。
 * @param {string} encoded 密钥库中的 EnKey 字符串
 * @returns {Buffer} 音频流密钥
 */
function unwrap(encoded) {
  let raw = decodeBase64(encoded);

  if (raw.length >= V2_PREFIX.length && raw.subarray(0, V2_PREFIX.length).equals(V2_PREFIX)) {
    raw = raw.subarray(V2_PREFIX.length);
    raw = decryptTencentTea(raw, V2_KEY1);
    raw = decryptTencentTea(raw, V2_KEY2);
    raw = decodeBase64(raw.toString('ascii'));
  }

  return deriveV1(raw);
}

module.exports = {
  unwrap,
  deriveV1,
  decryptTencentTea,
  teaDecryptBlock,
  decodeBase64,
  V2_PREFIX,
  SIMPLE_KEY,
};
