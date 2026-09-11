'use strict';

/**
 * .kgg → 原始音频 的核心解密流程。
 *
 * 分块流式处理：不会把 7 MB 甚至几百 MB 的文件整个读进内存。
 * 每块解完就写盘，最后做结构校验（Ogg 逐页 CRC / 容器标识 / 明文长度），
 * 校验不通过就删除产物，杜绝悄悄产出坏文件。
 *
 * 注意：头部与密钥库里的 MD5 字段是「文件标识哈希」而非明文 MD5，
 * 所以不能拿来直接比对（详见 src/audio/verify.js 的说明）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const header = require('./header');
const ekey = require('./ekey');
const qmc2 = require('./qmc2');
const sniff = require('../audio/sniff');
const verifier = require('../audio/verify');

const DEFAULT_CHUNK_SIZE = 1024 * 1024;

/**
 * 组装「找不到密钥」时的可读报错。
 *
 * 注意：密钥是**下载时**随下载响应一起写进密钥库的，不需要先播放
 * （早期版本这里写着"要先播放一次"，实测是错的，已更正）。
 */
function missingKeyError(keyId) {
  return new Error(
    `密钥库里没有这首歌的密钥（keyId=${keyId}）。\n` +
      '  常见原因：\n' +
      '    1. 这个 .kgg 不是在这台设备 / 这个账号上下载的（例如从别的电脑拷过来）；\n' +
      '    2. 下载没有真正完成（中断、取消、或只下载了一部分）；\n' +
      '    3. 酷狗还没把这条下载记录落盘（刚下完的话等一会儿，再点「重新加载密钥库」）；\n' +
      '    4. 用的是别的版本/别的路径的酷狗（密钥库位置不同，可用 --db 指定）。\n' +
      '  密钥库位置：%APPDATA%\\KuGou8\\KGMusicV3.db（本机下载的加密歌曲都会记在这里）',
  );
}

/**
 * 只读地读取一个 .kgg 的元信息，不做解密（用于体检/预览）。
 */
function inspect(inputPath) {
  const stat = fs.statSync(inputPath);
  const prefix = header.readPrefix(inputPath, fs);
  const hdr = header.parse(prefix);

  return {
    path: inputPath,
    size: stat.size,
    header: hdr,
    audioLength: stat.size - hdr.headerLength,
  };
}

/**
 * 解密一个 .kgg 文件并写出原始音频。
 *
 * @param {string} inputPath .kgg 路径
 * @param {string} outputDir 输出目录
 * @param {{find:Function}} provider 密钥提供者
 * @param {{chunkSize?:number, force?:boolean, verify?:boolean, onProgress?:Function}} [options]
 * @returns {{outputPath:string, format:string, bytes:number, md5:string, header:object, record:object, skipped?:boolean}}
 */
function decryptToFile(inputPath, outputDir, provider, options = {}) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const doVerify = options.verify !== false;
  const force = options.force === true;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const stat = fs.statSync(inputPath);
  const prefix = header.readPrefix(inputPath, fs);
  const hdr = header.parse(prefix);

  const audioLength = stat.size - hdr.headerLength;
  if (audioLength <= 0) {
    throw new Error(`音频数据为空：文件只有 ${stat.size} 字节，头部就占了 ${hdr.headerLength} 字节`);
  }

  const record = provider.find(hdr.keyId);
  if (!record) throw missingKeyError(hdr.keyId);

  const audioKey = ekey.unwrap(record.enKey);
  const cipher = qmc2.makeCipher(audioKey);

  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = path.parse(inputPath).name;
  const tempPath = path.join(outputDir, `${baseName}.part`);

  const inFd = fs.openSync(inputPath, 'r');
  let outFd = null;
  let format = null;
  const hash = crypto.createHash('md5');
  let processed = 0;

  try {
    outFd = fs.openSync(tempPath, 'w');
    const buffer = Buffer.alloc(Math.max(1, Math.min(chunkSize, audioLength)));

    while (processed < audioLength) {
      const want = Math.min(buffer.length, audioLength - processed);
      const read = fs.readSync(inFd, buffer, 0, want, hdr.headerLength + processed);
      if (read <= 0) {
        throw new Error('音频数据提前结束：文件可能被截断或损坏');
      }

      cipher.apply(buffer, read, BigInt(processed));
      if (format === null) format = sniff.detect(buffer.subarray(0, Math.min(16, read)));
      hash.update(buffer.subarray(0, read));
      fs.writeSync(outFd, buffer, 0, read);

      processed += read;
      if (onProgress) onProgress(processed, audioLength);
    }

    fs.closeSync(outFd);
    outFd = null;
  } catch (err) {
    if (outFd !== null) {
      try {
        fs.closeSync(outFd);
      } catch {
        /* 忽略 */
      }
    }
    fs.rmSync(tempPath, { force: true });
    throw err;
  } finally {
    fs.closeSync(inFd);
  }

  const digest = hash.digest('hex');

  // 结构校验先在临时文件上做，通过后才改名；
  // 不通过就删除临时文件，绝不在 output\ 里留下坏文件。
  let verification = { ok: true, problems: [], notes: [] };
  if (doVerify) {
    verification = verifier.verifyFile(tempPath, {
      format,
      expectedSize: record.size || null,
    });
    if (!verification.ok) {
      fs.rmSync(tempPath, { force: true });
      throw new Error(
        `解密结果自检未通过，已删除产物（避免留下坏文件）：\n  - ${verification.problems.join('\n  - ')}`,
      );
    }
  }

  const outputPath = path.join(outputDir, `${baseName}.${format}`);

  if (fs.existsSync(outputPath) && !force) {
    fs.rmSync(tempPath, { force: true });
    return {
      outputPath,
      format,
      bytes: processed,
      md5: digest,
      identityMd5: hdr.md5,
      header: hdr,
      record,
      verification,
      skipped: true,
    };
  }

  fs.renameSync(tempPath, outputPath);

  return {
    outputPath,
    format,
    bytes: processed,
    md5: digest,
    identityMd5: hdr.md5,
    header: hdr,
    record,
    verification,
  };
}

module.exports = { decryptToFile, inspect, missingKeyError, DEFAULT_CHUNK_SIZE };
