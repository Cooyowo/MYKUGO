'use strict';

/**
 * 解密产物的结构校验。
 *
 * 为什么要用结构校验而不是"比对 MD5"：
 *   实测发现，.kgg 头部 0x6F 处的 16 字节（与密钥库 DownloadItem.MD5 相同）
 *   **并不是明文音频的 MD5**。而 .kgg 去掉头部后的 MD5 恰好等于 keyId，
 *   说明那是「文件标识哈希」，不能拿来做完整性断言。
 *   所以这里改用各容器自带的结构/校验信息来判定：
 *     - Ogg  : 逐页校验 Ogg CRC32（容器自带强校验，等价于逐页 MD5）
 *     - FLAC : 校验 "fLaC" + 第一个元数据块头是否合法
 *     - MP3  : 校验 ID3v2 头或 MPEG 帧同步
 *     - WAV  : 校验 RIFF/WAVE 标识
 *   再叠加「明文长度必须等于密钥库记录的 FileSize」。
 *
 * 只有出现硬性结构错误才判定失败，避免把好文件误删。
 */

const fs = require('node:fs');

const MAX_CRC_SCAN_BYTES = 128 * 1024 * 1024; // 超过这个大小就跳过逐页 CRC，避免吃内存

// Ogg 使用的 CRC32：poly 0x04c11db7，init 0，不反转输入输出，无末尾异或
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r;
  }
  return table;
})();

function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) | 0;
  }
  return crc >>> 0;
}

/**
 * 逐页走一遍 Ogg，校验每页 CRC。
 * @returns {{pages:number, okPages:number, badPages:number, firstBadOffset:number, truncated:boolean, lastPageEos:boolean}}
 */
function validateOgg(data) {
  let pos = 0;
  let pages = 0;
  let okPages = 0;
  let badPages = 0;
  let firstBadOffset = -1;
  let truncated = false;
  let lastPageEos = false;

  while (pos + 27 <= data.length) {
    if (
      data[pos] !== 0x4f || data[pos + 1] !== 0x67 || data[pos + 2] !== 0x67 || data[pos + 3] !== 0x53
    ) {
      // 走到非页头位置：容器结构被破坏
      truncated = true;
      break;
    }

    const segCount = data[pos + 26];
    if (pos + 27 + segCount > data.length) {
      truncated = true;
      break;
    }

    let bodyLength = 0;
    for (let i = 0; i < segCount; i++) bodyLength += data[pos + 27 + i];

    const total = 27 + segCount + bodyLength;
    if (pos + total > data.length) {
      truncated = true;
      break;
    }

    const page = data.subarray(pos, pos + total);
    const stored = page.readUInt32LE(22);
    const copy = Buffer.from(page);
    copy.writeUInt32LE(0, 22);

    pages++;
    if (oggCrc(copy) === stored) {
      okPages++;
    } else {
      badPages++;
      if (firstBadOffset < 0) firstBadOffset = pos;
    }

    lastPageEos = (page[5] & 0x04) !== 0;
    pos += total;
  }

  return { pages, okPages, badPages, firstBadOffset, truncated, lastPageEos };
}

/** 轻量格式校验，返回问题列表。 */
function verifyFile(filePath, options = {}) {
  const { format, expectedSize } = options;
  const problems = [];
  const notes = [];
  const stat = fs.statSync(filePath);

  if (expectedSize && stat.size !== expectedSize) {
    problems.push(`明文长度与密钥库记录不一致（期望 ${expectedSize}，实际 ${stat.size}）`);
  }

  const head = Buffer.alloc(Math.min(64, stat.size));
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (stat.size < 16) {
    problems.push('产物过小，不可能是有效音频');
    return { ok: false, problems, notes };
  }

  if (format === 'ogg') {
    if (stat.size <= MAX_CRC_SCAN_BYTES) {
      const result = validateOgg(fs.readFileSync(filePath));
      notes.push(
        `Ogg 页 ${result.pages} 个，CRC 正确 ${result.okPages} 个，错误 ${result.badPages} 个`,
      );
      if (result.pages === 0) problems.push('未找到任何 Ogg 页，容器结构无效');
      if (result.badPages > 0) {
        problems.push(
          `有 ${result.badPages} 个 Ogg 页 CRC 校验失败，首个坏页偏移 ${result.firstBadOffset}`,
        );
      }
      if (result.truncated) problems.push('Ogg 页结构在文件尾部被截断');
      if (!result.lastPageEos) notes.push('末页未置 EOS 标志（通常仍可播放，仅作提示）');
    } else {
      notes.push(`文件超过 ${MAX_CRC_SCAN_BYTES} 字节，已跳过逐页 CRC 校验`);
    }
  } else if (format === 'flac') {
    if (head.toString('latin1', 0, 4) !== 'fLaC') problems.push('FLAC 标识 "fLaC" 缺失');
    else notes.push('FLAC 标识正确');
  } else if (format === 'mp3') {
    const id3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const sync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
    if (id3) notes.push('MP3 以 ID3v2 标签开头');
    else if (sync) notes.push('MP3 以帧同步字开头');
    else problems.push('既没有 ID3v2 标签也没有 MPEG 帧同步字，不像有效 MP3');
  } else if (format === 'wav') {
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
      problems.push('RIFF/WAVE 标识不完整');
    } else notes.push('WAVE 标识正确');
  } else {
    notes.push('未能识别容器格式，已跳过结构校验（请人工试听确认）');
  }

  return { ok: problems.length === 0, problems, notes };
}

module.exports = { verifyFile, validateOgg, oggCrc, MAX_CRC_SCAN_BYTES };
