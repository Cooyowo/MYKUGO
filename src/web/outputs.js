'use strict';

/**
 * 判断一首 .kgg 在输出目录里是否已经有产物。
 *
 * 为什么需要：界面要能标出"这首歌已经转换过"，让用户优先转新歌，
 * 也让他可以选择重转（覆盖）已转换的。
 *
 * 状态定义：
 *   new     —— 输出目录里什么都没有
 *   partial —— 只有一半（例如解出了 .ogg 但还没有 .mp3）→ 仍然需要转换来补齐
 *   done    —— 该有的都有了
 *
 * 注意"该有的都有"取决于用户是否要 MP3：如果解密出来的明文本身就是 MP3，
 * 那它既是原始产物也是 MP3，一次即可算完成。
 */

const fs = require('node:fs');
const path = require('node:path');

// 解密产物的可能扩展名。把 mp3 放最后：如果同时存在 .ogg 和 .mp3，
// 说明 .ogg 才是解密出的原件，.mp3 是转码产物。
const DECRYPTED_EXTS = ['ogg', 'flac', 'wav', 'm4a', 'bin', 'mp3'];

function statOrNull(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { path: filePath, size: stat.size, mtime: stat.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * 查一首歌在输出目录里的产物。
 * @param {string} outputDir 输出目录
 * @param {string} baseName 不含扩展名的文件名
 */
function findOutputs(outputDir, baseName) {
  let decrypted = null;
  for (const ext of DECRYPTED_EXTS) {
    const hit = statOrNull(path.join(outputDir, `${baseName}.${ext}`));
    if (hit) {
      decrypted = { ...hit, ext };
      break;
    }
  }

  const mp3Hit = statOrNull(path.join(outputDir, `${baseName}.mp3`));
  const mp3 = mp3Hit || null;

  let status = 'new';
  if (decrypted && mp3) status = 'done';
  else if (decrypted || mp3) status = 'partial';

  return { decrypted, mp3, status, converted: status === 'done' };
}

/**
 * 这首歌是否已经"不需要再转了"。
 * @param {boolean} wantMp3 用户是否要求 MP3
 */
function isConverted(outputDir, baseName, wantMp3) {
  const found = findOutputs(outputDir, baseName);
  if (!found.decrypted) return false;
  if (found.decrypted.ext === 'mp3') return true; // 明文本身就是 MP3
  if (!wantMp3) return true; // 只要原始音频
  return Boolean(found.mp3);
}

/** 生成给界面用的状态标记。 */
function describeStatus(status) {
  if (status === 'done') return '已转换';
  if (status === 'partial') return '部分转换';
  return '新文件';
}

module.exports = { findOutputs, isConverted, describeStatus, DECRYPTED_EXTS };
