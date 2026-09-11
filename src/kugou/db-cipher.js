'use strict';

/**
 * 酷狗密钥库 KGMusicV3.db 的解密。
 *
 * 该库本身是「按 1024 字节分页加密」的 SQLite：
 *   pageKey(n) = MD5(masterKey ‖ n 的小端 u32 ‖ 0x546c4173 的小端 u32)
 *   pageIv(n)  = MD5( 由 LCG 生成的 4 个小端 u32 )
 * 第 1 页比较特殊：密文头部 16..24 字节是 8..16 字节的拷贝，
 * 解密前先做这次搬运，解密后再比对，用来确认主密钥是否正确。
 *
 * 解密结果仅在系统临时目录落地，用完即删（见 keymap.js）。
 * 规格出处见 docs/format-notes.md。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

const PAGE_SIZE = 1024;
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'ascii');

// KGMusicV3.db 的主密钥（公开算法说明中的固定值）
const MASTER_KEY = Buffer.from([
  0x1d, 0x61, 0x31, 0x45, 0xb2, 0x47, 0xbf, 0x7f,
  0x3d, 0x18, 0x96, 0x72, 0x14, 0x4f, 0xe4, 0xbf,
]);

const PAGE_KEY_SALT = 0x546c4173;
const PRNG_MUL = 0x9ef4n;
const PRNG_DEC = 0xce26n;
const PRNG_MOD = 0x7fffff07n;
const MASK32 = 0xffffffffn;

/** 分页密钥：MD5(masterKey ‖ 页号 ‖ 盐)，16 字节。 */
function pageKey(masterKey, pageNumber) {
  const material = Buffer.alloc(24);
  masterKey.copy(material, 0);
  material.writeUInt32LE(pageNumber >>> 0, 16);
  material.writeUInt32LE(PAGE_KEY_SALT >>> 0, 20);
  return crypto.createHash('md5').update(material).digest();
}

/** 分页 IV：由 LCG 生成的 4 个小端 u32 再做 MD5。 */
function pageIv(pageNumber) {
  let seed = BigInt(pageNumber) + 1n;
  const material = Buffer.alloc(16);

  for (let i = 0; i < 4; i++) {
    const value = (seed * PRNG_MUL - (seed / PRNG_DEC) * PRNG_MOD) & MASK32;
    const next = (value & 0x80000000n) === 0n ? value : (value + PRNG_MOD) & MASK32;
    seed = next;
    material.writeUInt32LE(Number(next), i * 4);
  }

  return crypto.createHash('md5').update(material).digest();
}

function isPlaintextHeader(page) {
  return page.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER);
}

function isEncryptedHeader(page) {
  if (page.length < 24) return false;
  if (page.readUInt32LE(20) !== 0x20204000) return false;
  const pageSize = ((page[16] & 0xff) << 8) | ((page[17] & 0xff) << 16);
  const diff = pageSize - 0x200;
  if (diff < 0 || diff > 0xfe00) return false;
  return ((pageSize - 1) & pageSize) === 0;
}

function decryptBlocks(ciphertext, pageNumber, masterKey) {
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    pageKey(masterKey, pageNumber),
    pageIv(pageNumber),
  );
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptPage(page, pageNumber, masterKey) {
  decryptBlocks(page, pageNumber, masterKey).copy(page);
}

/** 解密第 1 页（含头部搬运与主密钥校验）。 */
function decryptFirstPage(page, masterKey) {
  if (!isEncryptedHeader(page)) {
    throw new Error('不是有效的加密酷狗密钥库（头部特征不匹配）');
  }

  const expectedHeader = Buffer.from(page.subarray(16, 24));
  page.copy(page, 16, 8, 16);
  decryptBlocks(page.subarray(16, PAGE_SIZE), 1, masterKey).copy(page, 16);

  if (!page.subarray(16, 24).equals(expectedHeader)) {
    throw new Error('密钥库第 1 页完整性校验失败：主密钥不匹配（酷狗可能更换了密钥库格式）');
  }

  SQLITE_HEADER.copy(page, 0);
}

/**
 * 逐页解密整个密钥库并写入目标文件（流式，不整库读入内存）。
 * @returns {{pages:number, encrypted:boolean}}
 */
function decryptDatabaseToFile(srcPath, destPath, masterKey = MASTER_KEY) {
  const inFd = fs.openSync(srcPath, 'r');
  let outFd = null;

  try {
    outFd = fs.openSync(destPath, 'w');
    const page = Buffer.alloc(PAGE_SIZE);
    let pageNumber = 1;
    let encrypted = false;

    for (;;) {
      const read = fs.readSync(inFd, page, 0, PAGE_SIZE, null);
      if (read === 0) break;
      if (read < PAGE_SIZE) {
        throw new Error(`密钥库在页中间被截断（第 ${pageNumber} 页仅读到 ${read} 字节）`);
      }

      if (pageNumber === 1) {
        if (isPlaintextHeader(page)) {
          encrypted = false;
        } else {
          decryptFirstPage(page, masterKey);
          encrypted = true;
        }
      } else if (encrypted) {
        decryptPage(page, pageNumber, masterKey);
      }

      fs.writeSync(outFd, page, 0, PAGE_SIZE);
      pageNumber++;
    }

    return { pages: pageNumber - 1, encrypted };
  } finally {
    fs.closeSync(inFd);
    if (outFd !== null) fs.closeSync(outFd);
  }
}

module.exports = {
  PAGE_SIZE,
  MASTER_KEY,
  SQLITE_HEADER,
  pageKey,
  pageIv,
  isPlaintextHeader,
  isEncryptedHeader,
  decryptBlocks,
  decryptPage,
  decryptFirstPage,
  decryptDatabaseToFile,
};
