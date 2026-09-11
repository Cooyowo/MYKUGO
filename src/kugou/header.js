'use strict';

/**
 * 酷狗 .kgg 文件头解析（1024 字节前缀，字段全部小端序）。
 *
 * 布局（本项目在真实文件上逐字节实测，与公开算法说明一致）：
 *   0x00  16B  固定 magic
 *   0x10  u32  头部长度        （实测 0x400 = 1024）
 *   0x14  u32  加密版本        （5 = 当前版本；3 = 旧版，本工具不处理）
 *   0x18  4B   保留
 *   0x44  u32  keyId 长度
 *   0x48  N    keyId（UTF-8），用于在酷狗密钥库中查 EnKey
 *   0x68  u32  码率字符串长度
 *   0x6C  M    码率字符串，如 "320"
 *   后面  16B  明文音频的 MD5（解密后用于校验完整性）
 *
 * 算法规格出处与许可说明见 docs/format-notes.md。
 */

const MAGIC = Buffer.from([
  0x7c, 0xd5, 0x32, 0xeb, 0x86, 0x02, 0x7f, 0x4b,
  0xa8, 0xaf, 0xa6, 0x8e, 0x0f, 0xff, 0x99, 0x14,
]);

const MAGIC_SIZE = 16;
const PREFIX_SIZE = 1024;

const OFF_HEADER_LENGTH = 0x10;
const OFF_VERSION = 0x14;
const OFF_ID_LENGTH = 0x44;
const OFF_ID = 0x48;
const OFF_BITRATE_LENGTH = 0x68;
const OFF_BITRATE = 0x6c;

const MAX_HEADER_LENGTH = 0x10000; // 128 KiB，防御性上限
const MAX_ID_LENGTH = 256;
const SUPPORTED_VERSIONS = new Set([5]);

/** 判断一段数据是否是 .kgg（只看 magic）。 */
function hasMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= MAGIC_SIZE && buf.subarray(0, MAGIC_SIZE).equals(MAGIC);
}

/** 从文件读取前 1024 字节头部。 */
function readPrefix(filePath, fs) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(PREFIX_SIZE);
    const read = fs.readSync(fd, buf, 0, PREFIX_SIZE, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** 尽力解析码率字符串（位于保留区，解析失败不报错）。 */
function readBitrate(prefix) {
  if (prefix.length < OFF_BITRATE + 4) return null;
  const len = prefix.readUInt32LE(OFF_BITRATE_LENGTH);
  if (len < 1 || len > 16) return null;
  if (OFF_BITRATE + len > prefix.length) return null;
  const text = prefix.subarray(OFF_BITRATE, OFF_BITRATE + len).toString('ascii');
  return /^\d+$/.test(text) ? text : null;
}

/** 尽力解析明文音频 MD5（位于码率字符串之后，解析失败返回 null）。 */
function readMd5(prefix, bitrate) {
  if (bitrate === null) return null;
  const off = OFF_BITRATE + bitrate.length;
  if (off + 16 > prefix.length) return null;
  return prefix.subarray(off, off + 16).toString('hex');
}

/**
 * 解析 .kgg 头部。
 * @param {Buffer} prefix 文件前 1024 字节（不足也可以，会按实际情况校验）
 * @returns {{headerLength:number, cryptoVersion:number, keyId:string, bitrate:?string, md5:?string, magicOk:boolean}}
 */
function parse(prefix) {
  if (!Buffer.isBuffer(prefix)) throw new TypeError('header.parse 需要 Buffer');
  if (!hasMagic(prefix)) {
    throw new Error('.kgg magic 不匹配：该文件不是酷狗 .kgg 格式（或头部已损坏）');
  }
  if (prefix.length < OFF_ID) {
    throw new Error(`.kgg 头部被截断：只有 ${prefix.length} 字节，至少需要 ${OFF_ID}`);
  }

  const headerLength = prefix.readUInt32LE(OFF_HEADER_LENGTH);
  if (headerLength < OFF_ID || headerLength > MAX_HEADER_LENGTH) {
    throw new Error(`.kgg 头部长度非法：${headerLength}`);
  }
  if (headerLength > prefix.length) {
    throw new Error(`.kgg 头部长度 ${headerLength} 超出实际可读字节数 ${prefix.length}`);
  }

  const cryptoVersion = prefix.readUInt32LE(OFF_VERSION);
  if (!SUPPORTED_VERSIONS.has(cryptoVersion)) {
    throw new Error(
      `不支持的 .kgg 加密版本 ${cryptoVersion}（本工具目前只实现版本 5）`,
    );
  }

  const idLength = prefix.readUInt32LE(OFF_ID_LENGTH);
  if (idLength < 1 || idLength > MAX_ID_LENGTH) {
    throw new Error(`.kgg keyId 长度非法：${idLength}`);
  }
  if (OFF_ID + idLength > headerLength || OFF_ID + idLength > prefix.length) {
    throw new Error('.kgg keyId 超出头部范围');
  }

  const keyId = prefix.subarray(OFF_ID, OFF_ID + idLength).toString('utf8');
  if (keyId.includes('\uFFFD')) throw new Error('.kgg keyId 不是合法 UTF-8');
  if (keyId.trim().length === 0) throw new Error('.kgg keyId 为空');

  const bitrate = readBitrate(prefix);
  const md5 = readMd5(prefix, bitrate);

  return { headerLength, cryptoVersion, keyId, bitrate, md5, magicOk: true };
}

module.exports = {
  MAGIC,
  MAGIC_SIZE,
  PREFIX_SIZE,
  OFF_HEADER_LENGTH,
  OFF_VERSION,
  OFF_ID_LENGTH,
  OFF_ID,
  hasMagic,
  readPrefix,
  readBitrate,
  readMd5,
  parse,
};
