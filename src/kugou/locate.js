'use strict';

/**
 * 定位本机酷狗客户端的密钥库 KGMusicV3.db。
 *
 * 正常位置：%APPDATA%\KuGou8\KGMusicV3.db
 * 但不同版本/安装方式目录名可能是 KuGou / Kugou8 / KuGou9 等，
 * 所以先按名字匹配，再做一次有深度上限的兜底扫描。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_FILENAME = 'KGMusicV3.db';
const KUGOU_DIR_PATTERN = /^ku?gou\d*$/i;

function unique(list) {
  return Array.from(new Set(list));
}

function appDataRoots() {
  const home = os.homedir();
  return unique(
    [
      process.env.APPDATA,
      process.env.LOCALAPPDATA,
      path.join(home, 'AppData', 'Roaming'),
      path.join(home, 'AppData', 'Local'),
    ].filter(Boolean),
  ).filter((p) => fs.existsSync(p));
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 列出所有可能存在的密钥库路径（存在与否都会列出，便于报错时展示）。 */
function candidates() {
  const out = [];

  for (const root of appDataRoots()) {
    // 1) 常见：%APPDATA%\<酷狗目录>\KGMusicV3.db
    for (const name of listDirs(root)) {
      if (KUGOU_DIR_PATTERN.test(name)) out.push(path.join(root, name, DB_FILENAME));
    }
    // 2) 兜底：酷狗目录被改名了，就找一层子目录里带密钥库的
    for (const name of listDirs(root)) {
      const probe = path.join(root, name, DB_FILENAME);
      if (fs.existsSync(probe)) out.push(probe);
    }
  }

  return unique(out);
}

/**
 * 找到可用的密钥库。
 * @param {string} [explicitPath] 用户显式指定的路径（优先级最高）
 * @returns {?string} 存在的路径，找不到返回 null
 */
function findDatabase(explicitPath) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(`指定的密钥库不存在：${explicitPath}`);
    }
    return explicitPath;
  }

  for (const candidate of candidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

module.exports = {
  DB_FILENAME,
  appDataRoots,
  candidates,
  findDatabase,
};
