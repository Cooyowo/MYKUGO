#!/usr/bin/env node
'use strict';

/**
 * 命令行入口。
 *
 * 用法：
 *   node src/cli.js [选项] [文件或目录...]
 *
 * 选项：
 *   --out <目录>    输出目录（默认 <项目根>/output）
 *   --db <路径>     指定 KGMusicV3.db（默认自动定位本机酷狗密钥库）
 *   --key <路径>    改用 kgg.key 文本（每行 keyId$EnKey），便于跨设备排错
 *   --probe         只体检：打印头部、密钥命中情况，不写任何文件
 *   --no-mp3        只解密出原始音频，不转 MP3
 *   --bitrate <k>   MP3 码率（默认 320k）
 *   --deep-check    转码后再整片解码校验一次（更慢，但更保险）
 *   --force         覆盖已存在的输出
 *   -h, --help      显示帮助
 *
 * 不带文件参数时，自动扫描项目根目录与 input\ 下的所有 *.kgg。
 */

const fs = require('node:fs');
const path = require('node:path');

const locate = require('./kugou/locate');
const keymap = require('./kugou/keymap');
const sniff = require('./audio/sniff');
const { decryptToFile, inspect } = require('./kugou/audio-decrypt');
const { transcodeToMp3, buildTags } = require('./audio/transcode');

// Node 内置的 node:sqlite 目前仍会打印实验性警告，这里静音以免干扰工具输出
const originalEmit = process.emit;
process.emit = function patchedEmit(name, data, ...rest) {
  if (
    name === 'warning' &&
    data &&
    data.name === 'ExperimentalWarning' &&
    /SQLite/i.test(String(data.message))
  ) {
    return false;
  }
  return originalEmit.call(this, name, data, ...rest);
};

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const DEFAULT_SCAN_DIRS = [PROJECT_ROOT, path.join(PROJECT_ROOT, 'input')];

const HELP_TEXT = `
酷狗 .kgg → 原始音频 / MP3 转换工具（本机个人使用）

用法：
  node src/cli.js [选项] [文件或目录...]

选项：
  --out <目录>    输出目录（默认 ${DEFAULT_OUTPUT_DIR}）
  --db <路径>     指定 KGMusicV3.db（默认自动定位本机酷狗密钥库）
  --key <路径>    改用 kgg.key 文本（每行 keyId$EnKey）
  --probe         只体检，不写文件
  --no-mp3        只解密出原始音频，不转 MP3
  --bitrate <k>   MP3 码率（默认 320k）
  --deep-check    转码后整片解码校验
  --force         覆盖已存在的输出
  -h, --help      显示本帮助

不带参数时，会自动扫描：
  ${DEFAULT_SCAN_DIRS.join('\n  ')}
`;

function parseArgs(argv) {
  const opts = {
    out: null,
    db: null,
    key: null,
    bitrate: null,
    probe: false,
    mp3: true,
    deepCheck: false,
    force: false,
    help: false,
    inputs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--probe') opts.probe = true;
    else if (arg === '--no-mp3') opts.mp3 = false;
    else if (arg === '--deep-check') opts.deepCheck = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--db') opts.db = argv[++i];
    else if (arg === '--key') opts.key = argv[++i];
    else if (arg === '--bitrate') opts.bitrate = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else opts.inputs.push(arg);
  }

  return opts;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '未知';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 收集待处理的 .kgg 文件。 */
function collectInputs(inputs) {
  const targets = inputs.length > 0 ? inputs : DEFAULT_SCAN_DIRS;
  const files = [];

  for (const target of targets) {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) {
      if (inputs.length > 0) throw new Error(`路径不存在：${abs}`);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      files.push(abs);
      continue;
    }
    for (const name of fs.readdirSync(abs)) {
      if (/\.kgg$/i.test(name)) files.push(path.join(abs, name));
    }
  }

  return Array.from(new Set(files));
}

/** 加载密钥来源。 */
function loadKeys(opts) {
  if (opts.key) return keymap.loadFromKeyFile(opts.key);

  const dbPath = locate.findDatabase(opts.db);
  if (!dbPath) {
    const tried = locate.candidates();
    throw new Error(
      '找不到酷狗密钥库 KGMusicV3.db。\n' +
        '  已尝试的位置：\n' +
        (tried.length > 0 ? tried.map((p) => `    ${p}`).join('\n') : '    （未发现任何酷狗数据目录）') +
        '\n  可用 --db <路径> 手动指定，或用 --key <kgg.key 路径> 改用密钥文件。',
    );
  }

  return keymap.createDatabaseKeyStore(dbPath);
}

function printInspection(info, record, provider) {
  const h = info.header;
  console.log(`  源文件      : ${path.basename(info.path)}  (${formatBytes(info.size)})`);
  console.log(`  keyId       : ${h.keyId}`);
  console.log(`  加密版本    : ${h.cryptoVersion}   头部长度: ${h.headerLength}   标称码率: ${h.bitrate ?? '未知'}`);
  console.log(`  标识哈希    : ${h.md5 ?? '（头部未记录）'}`);
  console.log(`  音频载荷    : ${formatBytes(info.audioLength)}`);

  if (record) {
    console.log(`  密钥命中    : 是${record.songName ? `（${record.songName}）` : ''}`);
    if (record.keySource) console.log(`  密钥来源    : ${record.keySource}`);
    if (record.size) console.log(`  预期明文长  : ${record.size} 字节`);
  } else {
    console.log(
      `  密钥命中    : 否 —— ${provider.count() > 0 ? '密钥库里没有这条 keyId' : '密钥库里没有任何可用密钥'}`,
    );
  }
}

/** 带进度显示的转码。 */
async function transcodeWithProgress(inputPath, outputPath, record, opts) {
  let lastPrint = 0;

  const onProgress = (done, total) => {
    const pct = Math.floor((done / total) * 100);
    const now = Date.now();
    if (now - lastPrint > 250 || pct >= 100) {
      lastPrint = now;
      process.stdout.write(
        `\r  转码中      : ${String(pct).padStart(3)}%  (${formatDuration(done)} / ${formatDuration(total)})`,
      );
    }
  };

  const result = await transcodeToMp3(inputPath, outputPath, {
    record,
    bitrate: opts.bitrate || undefined,
    onProgress,
    deepCheck: opts.deepCheck,
  });

  process.stdout.write('\n');
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP_TEXT.trim());
    return 0;
  }

  const files = collectInputs(opts.inputs);
  if (files.length === 0) {
    console.log('没有找到任何 .kgg 文件。把文件放进 input\\ 或直接作为参数传入。');
    return 0;
  }

  const outputDir = opts.out ? path.resolve(opts.out) : DEFAULT_OUTPUT_DIR;
  const keys = loadKeys(opts);
  const provider = keys.provider;

  console.log(`密钥来源    : ${provider.source}`);
  console.log(`可用密钥    : ${provider.count()} 条`);
  console.log(`输出目录    : ${outputDir}`);
  console.log(`待处理文件  : ${files.length} 个`);
  console.log(`转 MP3      : ${opts.mp3 ? `是（${opts.bitrate || '320k'} CBR）` : '否（只解密）'}`);
  console.log('');

  let ok = 0;
  let skipped = 0;
  const failures = [];

  try {
    for (const file of files) {
      console.log(`[${path.basename(file)}]`);

      try {
        const info = inspect(file);
        const record = provider.find(info.header.keyId);
        printInspection(info, record, provider);

        if (opts.probe) {
          console.log('  （--probe 模式，未写文件）');
          console.log('');
          ok++;
          continue;
        }

        // ---- 第一步：解密出原始音频 ----
        const decrypted = decryptToFile(file, outputDir, provider, { force: opts.force });

        if (decrypted.skipped) {
          console.log(`  解密        : 已存在，跳过`);
        } else {
          console.log(
            `  解密        : ${decrypted.bytes} 字节 → ${decrypted.format}` +
              `${sniff.isLossless(decrypted.format) ? '（无损）' : '（有损）'}`,
          );
          for (const note of decrypted.verification.notes) {
            console.log(`  校验        : ${note}`);
          }
          console.log(`  原始产物    : ${decrypted.outputPath}`);
        }

        // ---- 第二步：需要的话转成 MP3 ----
        if (opts.mp3 && decrypted.format !== 'mp3') {
          const mp3Path = path.join(outputDir, `${path.parse(file).name}.mp3`);

          if (fs.existsSync(mp3Path) && !opts.force) {
            console.log(`  MP3         : 已存在，跳过（加 --force 可覆盖）`);
          } else {
            console.log(
              `  MP3 标签    : ${JSON.stringify(buildTags(file, record))}`,
            );
            const mp3 = await transcodeWithProgress(
              decrypted.outputPath,
              mp3Path,
              record,
              opts,
            );
            console.log(
              `  MP3 完成    : ${formatDuration(mp3.duration)} / ${Math.round(mp3.bitRate / 1000)}kbps` +
                ` / ${formatBytes(mp3.size)}`,
            );
            console.log(`  MP3 产物    : ${mp3.outputPath}`);
          }
        } else if (opts.mp3 && decrypted.format === 'mp3') {
          console.log('  MP3         : 明文本身就是 MP3，无需转码');
        }

        ok++;
      } catch (err) {
        console.log(`  失败        : ${err.message}`);
        failures.push({ file, message: err.message });
      }

      console.log('');
    }
  } finally {
    keys.dispose();
  }

  console.log(`完成：成功 ${ok} 个，跳过 ${skipped} 个，失败 ${failures.length} 个。`);
  return failures.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`错误：${err.message}`);
    process.exitCode = 2;
  });
