#!/usr/bin/env node
'use strict';

/**
 * 回归测试：常驻进程（网页界面）能否识别"启动之后才下载的新歌密钥"。
 *
 * 复现思路：
 *   1. 把本机真实的 KGMusicV3.db 解密成明文；
 *   2. 复制一份，清空其中所有 EnKey —— 模拟"这首歌还没下载/还没播放"的密钥库；
 *   3. 把这份"没有密钥"的库重新加密回 .db 格式（顺便反向验证我们的解密实现）；
 *   4. 让密钥仓库指向它 → 查 keyId 应该查不到；
 *   5. 把文件**就地替换**成有密钥的真实库（等价于用户此刻下载了新歌）；
 *   6. 再查一次 → 必须自动重新加载并命中。
 *
 * 第 5 步是核心：没有自动刷新时，这里会一直返回 null，也就是用户看到的
 * "密钥库里没有这首歌的密钥，重启界面才行"。
 *
 * 运行：node tests/key-store-reload.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const locate = require('../src/kugou/locate');
const dbCipher = require('../src/kugou/db-cipher');
const keymap = require('../src/kugou/keymap');
const header = require('../src/kugou/header');

const PAGE = dbCipher.PAGE_SIZE;
let failures = 0;

function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** 加密单个页面（解密流程的逆操作）。 */
function encryptPage(plain, pageNumber, masterKey) {
  const cipher = crypto.createCipheriv(
    'aes-128-cbc',
    dbCipher.pageKey(masterKey, pageNumber),
    dbCipher.pageIv(pageNumber),
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/**
 * 把明文 SQLite 缓冲加密成酷狗密钥库格式。
 *
 * 第 1 页有讲究：解密时会先把 [8..16] 搬回 [16..24] 再解密，所以这里反过来写 ——
 *   [0..8]   = 任意字节
 *   [8..16]  = 密文的前 8 字节
 *   [16..24] = 明文 [16..24]（同时充当识别特征与完整性校验基准）
 *   [24..]   = 密文剩余部分
 */
function encryptDatabase(plainBuf, masterKey) {
  if (plainBuf.length % PAGE !== 0) throw new Error('明文长度未按页对齐');
  const pages = plainBuf.length / PAGE;
  const out = Buffer.alloc(plainBuf.length);

  for (let n = 1; n <= pages; n++) {
    const start = (n - 1) * PAGE;
    const pagePlain = Buffer.from(plainBuf.subarray(start, start + PAGE));

    if (n === 1) {
      const ciphertext = encryptPage(pagePlain.subarray(16, PAGE), 1, masterKey);
      const page = Buffer.alloc(PAGE);
      page.fill(0, 0, 8);
      ciphertext.copy(page, 8, 0, 8);
      pagePlain.copy(page, 16, 16, 24);
      ciphertext.copy(page, 24, 8);
      page.copy(out, start);
    } else {
      encryptPage(pagePlain, n, masterKey).copy(out, start);
    }
  }

  return out;
}

function main() {
  console.log('回归测试：常驻进程下的密钥库自动刷新\n');

  const dbPath = locate.findDatabase(null);
  if (!dbPath) {
    console.log('  跳过：本机没有找到 KGMusicV3.db');
    return;
  }
  console.log(`  密钥库：${dbPath}`);

  // 找一个真实样本文件来取 keyId。要求：它的密钥确实存在于本机密钥库里，
  // 否则测不出"重新加载后命中"。
  const projectRoot = path.resolve(__dirname, '..');
  const candidates = [projectRoot, path.join(projectRoot, 'input')]
    .flatMap((dir) => {
      try {
        return fs.readdirSync(dir).map((name) => path.join(dir, name));
      } catch {
        return [];
      }
    })
    .filter((full) => /\.kgg$/i.test(full));

  if (candidates.length === 0) {
    console.log('  跳过：项目目录和 input\\ 下都没有 .kgg 样本，无法取得 keyId');
    return;
  }

  const reference = keymap.loadFromDatabase(dbPath);
  let sample = null;
  let hdr = null;

  try {
    for (const candidate of candidates) {
      let parsed;
      try {
        parsed = header.parse(header.readPrefix(candidate, fs));
      } catch {
        continue; // 不是有效的 .kgg，跳过
      }
      if (reference.provider.find(parsed.keyId)) {
        sample = candidate;
        hdr = parsed;
        break;
      }
    }
  } finally {
    reference.dispose();
  }

  if (!sample) {
    console.log('  跳过：找不到"密钥库里有密钥"的 .kgg 样本（可能不是在当前设备下载的）');
    return;
  }

  console.log(`  样本：${path.basename(sample)}  keyId=${hdr.keyId}\n`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kugou-test-'));
  let store = null;

  try {
    // 1. 解密真实库
    const plainA = path.join(workDir, 'plainA.db');
    dbCipher.decryptDatabaseToFile(dbPath, plainA);
    check('把真实密钥库解密成明文', fs.statSync(plainA).size > 0);

    // 2. 复制一份并清空所有 EnKey
    const plainB = path.join(workDir, 'plainB.db');
    fs.copyFileSync(plainA, plainB);

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(plainB);
    // 两张表都要清空：工具现在会同时读 DownloadItem 和 ShareFileItems，
    // 只清前者的话"没有密钥"的前提就不成立，后面几项断言会假通过/假失败。
    db.exec("UPDATE DownloadItem SET EnKey = '' WHERE EnKey IS NOT NULL AND TRIM(EnKey) <> ''");
    db.exec(
      "UPDATE ShareFileItems SET EncryptionKey = '' WHERE EncryptionKey IS NOT NULL AND TRIM(EncryptionKey) <> ''",
    );
    db.close();

    // 3. 重新加密（加密 → 解密的往返必须完全一致，否则说明我们对格式的理解有偏差）
    const encryptedB = path.join(workDir, 'encryptedB.db');
    fs.writeFileSync(encryptedB, encryptDatabase(fs.readFileSync(plainB), dbCipher.MASTER_KEY));

    const roundTrip = path.join(workDir, 'roundtrip.db');
    dbCipher.decryptDatabaseToFile(encryptedB, roundTrip);
    const same = Buffer.compare(fs.readFileSync(plainB), fs.readFileSync(roundTrip)) === 0;
    check('加密→解密往返字节完全一致（反向验证格式理解）', same);

    // 4. 让密钥仓库指向"没有密钥"的库
    const target = path.join(workDir, 'target.db');
    fs.copyFileSync(encryptedB, target);
    store = keymap.createDatabaseKeyStore(target);

    check(
      '初始状态：查不到该 keyId（模拟新歌尚未下载）',
      store.provider.find(hdr.keyId) === null,
      `当前 ${store.provider.count()} 条可用密钥`,
    );
    const countBefore = store.reloadCount;

    // 5. 关键一步：把文件就地替换成"有密钥"的真实库（等价于用户刚下载完新歌）
    //    显式设置一个不同的 mtime，避免同一毫秒内拷贝导致指纹判定不稳定
    fs.copyFileSync(dbPath, target);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(target, future, future);

    // 6. 再查一次 —— 必须自动重新加载并命中
    const hit = store.provider.find(hdr.keyId);
    check('密钥库更新后自动重新加载并命中', hit !== null && typeof hit.enKey === 'string');
    check('确实发生了重新加载', store.reloadCount > countBefore, `reloadCount ${countBefore} → ${store.reloadCount}`);

    // 7. 未变化时不应重复加载（避免每次查询都解密 38MB）
    const countAfter = store.reloadCount;
    store.provider.find(hdr.keyId);
    store.provider.find('00000000000000000000000000000000');
    check('密钥库没变时不做多余的重新加载', store.reloadCount === countAfter);

    // 8. 手动重新加载接口
    const manual = store.reload();
    check('手动重新加载可用', manual.reloaded === true && manual.count > 0, `${manual.count} 条`);
  } finally {
    if (store) store.dispose();
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  // ── 临时文件清理 ──
  console.log('\n【临时文件清理（硬杀后残留的孤儿）】');
  {
    const { DatabaseSync } = require('node:sqlite');
    const tempDir = os.tmpdir();
    const oldFile = path.join(tempDir, `kugou-keys-999901-${'a'.repeat(12)}.db`);
    const freshFile = path.join(tempDir, `kugou-keys-999902-${'b'.repeat(12)}.db`);
    const heldFile = path.join(tempDir, `kugou-keys-999903-${'c'.repeat(12)}.db`);
    // 除了密钥库，ffmpeg 暂存和启动器日志也会在硬杀时残留，同样要清理
    const ffmpegTemp = path.join(tempDir, `kugou-ffprog-999904-${'d'.repeat(10)}`);
    const uiLog = path.join(tempDir, 'kugou-ui-out-999905.log');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    fs.writeFileSync(oldFile, 'x');
    fs.utimesSync(oldFile, tenMinutesAgo, tenMinutesAgo);

    fs.writeFileSync(freshFile, 'x'); // mtime 就是现在

    fs.writeFileSync(ffmpegTemp, 'x');
    fs.utimesSync(ffmpegTemp, tenMinutesAgo, tenMinutesAgo);

    fs.writeFileSync(uiLog, 'x');
    fs.utimesSync(uiLog, tenMinutesAgo, tenMinutesAgo);

    // 模拟"还有活进程在用"：必须用 sqlite 打开，不能只用 fs.openSync。
    // Node 的 fs.openSync 是允许共享删除的（照样删得掉），而 sqlite 打开数据库时
    // 不允许删除 —— 这也正是应用持有的方式。
    let holder = null;
    try {
      const maker = new DatabaseSync(heldFile);
      maker.exec('CREATE TABLE t (x INTEGER)');
      maker.close();
      fs.utimesSync(heldFile, tenMinutesAgo, tenMinutesAgo);
      holder = new DatabaseSync(heldFile, { readOnly: true });

      const result = keymap.sweepStaleTempFiles();
      check('旧的孤儿被清掉', fs.existsSync(oldFile) === false, `removed=${result.removed}`);
      check('刚创建的不动（避免误删正在写的）', fs.existsSync(freshFile) === true, `kept=${result.kept}`);
      check('被 sqlite 占用的不会被误删', fs.existsSync(heldFile) === true);
      check('ffmpeg 暂存也会被清理', fs.existsSync(ffmpegTemp) === false);
      check('启动器日志也会被清理', fs.existsSync(uiLog) === false);
    } finally {
      if (holder) {
        try {
          holder.close();
        } catch {
          /* 忽略 */
        }
      }
      for (const f of [oldFile, freshFile, heldFile, ffmpegTemp, uiLog]) fs.rmSync(f, { force: true });
    }
  }

  // ── 密钥的两个来源都要读到 ──
  //
  // 酷狗的加密歌曲密钥记在两个地方：DownloadItem.EnKey（常规下载）和
  // ShareFileItems.EncryptionKey（另一条下载通道）。只读前者会漏掉一部分歌，
  // 表现就是"密钥库里没有这首歌的密钥"（真实案例：华晨宇、G.E.M. 邓紫棋 - 光年之外 (Live)）。
  console.log('\n【密钥来源覆盖（DownloadItem + ShareFileItems）】');
  {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kugou-keysrc-'));
    const plainPath = path.join(srcDir, 'plain.db');
    let store = null;

    try {
      dbCipher.decryptDatabaseToFile(dbPath, plainPath);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(plainPath, { readOnly: true });

      const inDownload = new Set(
        db
          .prepare(`SELECT lower(EnHash) AS k FROM DownloadItem WHERE EnKey IS NOT NULL AND TRIM(EnKey) <> ''`)
          .all()
          .map((r) => r.k),
      );
      const inShare = new Set(
        db
          .prepare(
            `SELECT lower(EncryptionKeyId) AS k FROM ShareFileItems
             WHERE EncryptionKey IS NOT NULL AND TRIM(EncryptionKey) <> ''
               AND EncryptionKeyId IS NOT NULL AND TRIM(EncryptionKeyId) <> ''`,
          )
          .all()
          .map((r) => r.k),
      );
      const union = new Set([...inDownload, ...inShare]);
      db.close();

      console.log(
        `  · DownloadItem ${inDownload.size} 条，ShareFileItems ${inShare.size} 条，去重后 ${union.size} 条`,
      );

      store = keymap.loadFromDatabase(dbPath);

      const missing = [...union].filter((k) => !store.provider.find(k));
      check(
        '两张表里的每个 keyId 都能查到',
        missing.length === 0,
        missing.length > 0 ? `缺 ${missing.length} 个` : `共 ${union.size} 个`,
      );

      const shareOnly = [...inShare].filter((k) => !inDownload.has(k));
      if (shareOnly.length > 0) {
        const hit = store.provider.find(shareOnly[0]);
        check(
          '只记在 ShareFileItems 里的密钥也能命中',
          hit !== null && typeof hit.enKey === 'string',
          `keyId=${shareOnly[0].slice(0, 12)} 来源=${hit ? hit.keySource : '无'}`,
        );
        check('并且标注了密钥来源', Boolean(hit && hit.keySource), hit ? hit.keySource : '');
      } else {
        console.log('  · 本机没有"只记在 ShareFileItems"的密钥，跳过该项');
      }
    } finally {
      if (store) store.dispose();
      // Windows 上句柄释放有一点延迟，删不掉就重试几次（不该算测试失败）
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(srcDir, { recursive: true, force: true });
          break;
        } catch {
          // 同步阻塞等待（这个测试是同步流程）
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        }
      }
    }
  }

  console.log('');
  if (failures === 0) {
    console.log('全部通过。');
  } else {
    console.log(`有 ${failures} 项未通过。`);
    process.exitCode = 1;
  }
}
main();
