'use strict';

/**
 * 建立「keyId(EnHash) → 音频密钥」的映射。
 *
 * 两种来源：
 *   1) 本机酷狗密钥库 KGMusicV3.db 的 DownloadItem 表（主路径）
 *   2) kgg.key 文本文件，每行 "keyId$EnKey"（备用，便于跨设备迁移与排错）
 *
 * 隐私约定：解密后的明文密钥库只写在系统临时目录，dispose() 时删除。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dbCipher = require('./db-cipher');

const DOWNLOAD_ITEM_QUERY = `
  SELECT EnHash, EnKey, MD5, FileSize, BitRate, Duration,
         SongName, Artist, Album, DestFileName, EncryptionType
  FROM DownloadItem
  WHERE EnKey IS NOT NULL AND TRIM(EnKey) <> ''
`;

function normalizeId(id) {
  return String(id).trim().toLowerCase();
}

const TEMP_DB_PATTERN = /^kugou-keys-(\d+)-[0-9a-f]+\.db$/;

// 小于这个年龄的临时库先不清理，避免误删别的进程正在写的文件
const STALE_MIN_AGE_MS = 2 * 60 * 1000;

/** 进程是否还活着（保留给排错用，清理逻辑已不再依赖它）。 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * 清理"孤儿"明文密钥库。
 *
 * 为什么需要：进程被硬杀（任务管理器结束进程、强杀信号）时 JS 的清理代码不会执行，
 * 49MB 的明文密钥库就留在临时目录里了。
 *
 * 判据不用"猜 PID 是否还活着"——那有 PID 复用的漏洞（进程死了、号被别的进程拿走，
 * 文件就永远清不掉）。这里用两个更可靠的信号：
 *   1. 太新的文件先放过（可能是别的进程刚开始解密、还没打开）；
 *   2. 之后**直接尝试删除**：Windows 上被打开的文件会拒绝删除，
 *      所以删失败 = 有活进程还在用（保留），删成功 = 确认是垃圾（清掉）。
 *
 * @returns {{removed:number, kept:number}}
 */
function sweepStaleTempDatabases() {
  const dir = os.tmpdir();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, kept: 0 };
  }

  let removed = 0;
  let kept = 0;

  for (const name of names) {
    const matched = TEMP_DB_PATTERN.exec(name);
    if (!matched) continue;
    if (Number(matched[1]) === process.pid) continue; // 自己的，不动

    const filePath = path.join(dir, name);

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    // 太新的可能是别的进程刚写好还没打开，先放过
    if (Date.now() - stat.mtimeMs < STALE_MIN_AGE_MS) {
      kept++;
      continue;
    }

    try {
      fs.rmSync(filePath, { force: true }); // force 只忽略"文件不存在"，被占用仍会抛错
      removed++;
    } catch {
      kept++; // 删不掉 = 还有活进程在用
    }
  }

  return { removed, kept };
}

/** 构建 provider：find(keyId) 返回密钥记录，count() 返回条目数。 */
function createProvider(map, source) {
  return {
    source,
    find(keyId) {
      return map.get(normalizeId(keyId)) || null;
    },
    count() {
      return map.size;
    },
  };
}

/** 从 kgg.key 文本构建 provider。 */
function loadFromKeyFile(keyPath) {
  const text = fs.readFileSync(keyPath, 'utf8');
  const map = new Map();

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;

    const sep = trimmed.indexOf('$');
    if (sep <= 0) {
      throw new Error(`kgg.key 第 ${index + 1} 行格式非法（应为 keyId$EnKey）`);
    }
    const id = trimmed.slice(0, sep);
    const enKey = trimmed.slice(sep + 1);
    if (!id || !enKey) {
      throw new Error(`kgg.key 第 ${index + 1} 行格式非法（keyId 或 EnKey 为空）`);
    }
    map.set(normalizeId(id), {
      enKey,
      md5: null,
      size: null,
      bitrate: null,
      duration: null,
      songName: null,
      artist: null,
      album: null,
    });
  });

  return {
    provider: createProvider(map, `密钥文件 ${keyPath}`),
    dispose() {},
  };
}

/**
 * 解密密钥库并加载全部可用密钥。
 * @param {string} dbPath KGMusicV3.db 路径
 * @returns {{provider:object, dispose:Function, tempPath:string}}
 */
function loadFromDatabase(dbPath) {
  // node:sqlite 是 Node 内置模块，无需任何第三方依赖。
  // 老版本 Node 没有它，这里给一句人话提示，而不是抛"Cannot find module"。
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(
      `当前 Node.js 版本（${process.version}）没有内置的 node:sqlite 模块。\n` +
        '  请升级到 Node.js 22.5 或更高版本：https://nodejs.org/',
    );
  }

  // 先清掉上次被硬杀（进程被强杀，JS 清理代码没机会执行）留下的明文密钥库
  sweepStaleTempDatabases();

  const tempPath = path.join(
    os.tmpdir(),
    `kugou-keys-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`,
  );

  const state = { db: null, disposed: false };

  // 用函数声明（会提升），避免 dispose / onExit 互相引用时的初始化顺序问题
  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    process.removeListener('exit', onExit);
    try {
      if (state.db) state.db.close();
    } catch {
      /* 关闭失败不影响主流程 */
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      /* 删除失败不影响主流程 */
    }
  }

  // 进程正常退出时兜底清理（被硬杀时不会执行，那时靠下次启动的 sweep）
  function onExit() {
    dispose();
  }

  process.once('exit', onExit);

  try {
    dbCipher.decryptDatabaseToFile(dbPath, tempPath);
  } catch (err) {
    dispose();
    throw err;
  }

  const map = new Map();

  try {
    // readOnly 选项在较老的 Node 上可能不支持，退化为只读以外的方式打开也可以，
    // 反正这是我们自己刚生成的临时副本，用完就删。
    try {
      state.db = new DatabaseSync(tempPath, { readOnly: true });
    } catch {
      state.db = new DatabaseSync(tempPath);
    }

    const rows = state.db.prepare(DOWNLOAD_ITEM_QUERY).all();

    for (const row of rows) {
      const id = normalizeId(row.EnHash);
      if (!id) continue;
      map.set(id, {
        enKey: String(row.EnKey),
        md5: row.MD5 ? String(row.MD5).toLowerCase() : null,
        size: typeof row.FileSize === 'number' ? row.FileSize : null,
        bitrate: typeof row.BitRate === 'number' ? row.BitRate : null,
        duration: typeof row.Duration === 'number' ? row.Duration : null,
        songName: row.SongName ? String(row.SongName) : null,
        artist: row.Artist ? String(row.Artist) : null,
        album: row.Album ? String(row.Album) : null,
        destFileName: row.DestFileName ? String(row.DestFileName) : null,
        encryptionType: row.EncryptionType,
      });
    }
  } catch (err) {
    dispose();
    throw new Error(`读取解密后的密钥库失败：${err.message}`);
  }

  return {
    provider: createProvider(map, `密钥库 ${dbPath}`),
    dispose,
    tempPath,
  };
}

/** 密钥库指纹：大小 + mtime。用它判断"库有没有被酷狗改过"，比每次都重新解密便宜得多。 */
function dbFingerprint(dbPath) {
  const stat = fs.statSync(dbPath);
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

/**
 * 可自动刷新的密钥库。
 *
 * 为什么需要：网页界面是常驻进程，启动时把密钥快照进了内存。
 * 如果用户之后才下载新歌，磁盘上的密钥库多了新行，而内存里还是旧的，
 * 就会一直报"密钥库里没有这首歌的密钥"。所以在**查不到密钥时**顺手看一眼
 * 密钥库指纹，变了就重新解密再查一次；没变就直接返回，不做无谓的解密。
 *
 * 重新加载失败（例如酷狗正占着文件、或库写了一半）不会破坏已有状态：
 * 旧密钥继续可用，错误记在 lastError 里供界面展示。
 */
function createDatabaseKeyStore(dbPath) {
  let current = null;
  let loadedStamp = null;
  let loadedAt = null;
  let lastError = null;
  let reloadCount = 0;

  function replace() {
    const next = loadFromDatabase(dbPath);
    const previous = current;
    current = next;
    loadedStamp = dbFingerprint(dbPath);
    loadedAt = new Date();
    lastError = null;
    reloadCount++;
    if (previous) previous.dispose();
    return next.provider.count();
  }

  // 首次加载：失败就把异常抛给调用方（这是致命错误）
  replace();

  function reload() {
    try {
      return { reloaded: true, count: replace(), loadedAt };
    } catch (err) {
      lastError = err.message;
      return { reloaded: false, error: err.message };
    }
  }

  const provider = {
    get source() {
      return current.provider.source;
    },
    count() {
      return current.provider.count();
    },
    find(keyId) {
      const hit = current.provider.find(keyId);
      if (hit) return hit;

      // 未命中：先确认密钥库是不是更新过，只有变了才值得重新解密
      let stamp;
      try {
        stamp = dbFingerprint(dbPath);
      } catch {
        return null;
      }
      if (stamp === loadedStamp) return null;

      try {
        replace();
      } catch (err) {
        lastError = err.message;
        return null;
      }

      return current.provider.find(keyId);
    },
    get lastError() {
      return lastError;
    },
  };

  return {
    provider,
    reload,
    dispose() {
      if (current) current.dispose();
      current = null;
    },
    get dbPath() {
      return dbPath;
    },
    get loadedAt() {
      return loadedAt;
    },
    get reloadCount() {
      return reloadCount;
    },
    get lastError() {
      return lastError;
    },
    /** 磁盘上的库是否已经和内存里的不一致（只做 stat，很便宜）。 */
    get dbChanged() {
      try {
        return dbFingerprint(dbPath) !== loadedStamp;
      } catch {
        return false;
      }
    },
  };
}

module.exports = {
  createProvider,
  loadFromKeyFile,
  loadFromDatabase,
  createDatabaseKeyStore,
  dbFingerprint,
  normalizeId,
  sweepStaleTempDatabases,
  isPidAlive,
  DOWNLOAD_ITEM_QUERY,
};
