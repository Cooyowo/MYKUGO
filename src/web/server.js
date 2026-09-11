#!/usr/bin/env node
'use strict';

/**
 * 本地网页界面的服务端。
 *
 * 安全边界（一个本地小工具该有的三条）：
 *   1. 只监听 127.0.0.1，局域网和外网都访问不到；
 *   2. 校验 Host 头，挡掉 DNS rebinding；
 *   3. 服务端只接受「项目目录内的路径」，以及用户刚刚通过原生文件对话框亲手选中的文件，
 *      不做任意路径读取。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const locate = require('../kugou/locate');
const keymap = require('../kugou/keymap');
const { createRunner } = require('./tasks');
const { runCapture } = require('../audio/transcode');
const outputs = require('./outputs');
const { createDirConfig, buildRevealArgs } = require('./config');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const PORT_TRIES = 20;

// 页面全部关闭后，等这么久还没有页面连回来就自动退出。
// 60 秒足够覆盖"刷新页面"（刷新时的断连通常不到 2 秒），又不会让你等太久。
const DEFAULT_AUTO_EXIT_SECONDS = 60;

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 输入/输出目录可由界面修改（默认是项目内的 input\ 与 output\），存在 .ui-config.json
const dirConfig = createDirConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// 用户通过原生对话框亲手选中的文件，会被临时加入白名单
const pickedFiles = new Set();

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    open: true,
    autoExit: true,
    autoExitSeconds: DEFAULT_AUTO_EXIT_SECONDS,
    inputDir: null,
    outputDir: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '--stay-alive') opts.autoExit = false;
    else if (arg === '--auto-exit-seconds') opts.autoExitSeconds = Number(argv[++i]);
    else if (arg === '--input-dir') opts.inputDir = argv[++i];
    else if (arg === '--output-dir') opts.outputDir = argv[++i];
    else if (arg === '-h' || arg === '--help') opts.help = true;
  }

  if (!Number.isFinite(opts.autoExitSeconds) || opts.autoExitSeconds < 1) {
    opts.autoExitSeconds = DEFAULT_AUTO_EXIT_SECONDS;
  }

  return opts;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 路径是否允许访问：当前输入/输出目录内、项目目录内，或用户刚通过对话框选中的文件。 */
function isAllowedPath(target) {
  const lowered = path.resolve(target).toLowerCase();

  for (const root of [PROJECT_ROOT, dirConfig.inputDir(), dirConfig.outputDir()]) {
    const rootLower = root.toLowerCase();
    if (lowered === rootLower || lowered.startsWith(rootLower + path.sep)) return true;
  }

  return pickedFiles.has(lowered);
}

/**
 * 扫描当前输入目录下的 .kgg，并带上"是否已经转换过"的标记。
 *
 * 标记让用户可以优先转新歌，也可以选择重转（覆盖）带标记的那些。
 */
function scanKggFiles() {
  const inputDir = dirConfig.inputDir();
  const outputDir = dirConfig.outputDir();
  const found = [];

  let names = [];
  try {
    names = fs.readdirSync(inputDir);
  } catch {
    names = [];
  }

  for (const name of names) {
    if (!/\.kgg$/i.test(name)) continue;
    const full = path.join(inputDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;

      const baseName = path.parse(name).name;
      const existing = outputs.findOutputs(outputDir, baseName);

      found.push({
        path: full,
        name,
        dir: inputDir,
        size: stat.size,
        mtime: stat.mtimeMs,
        status: existing.status,
        statusText: outputs.describeStatus(existing.status),
        // 已经产出的东西（界面上显示"已有 .ogg + .mp3"）
        existing: {
          decrypted: existing.decrypted
            ? { path: existing.decrypted.path, ext: existing.decrypted.ext, size: existing.decrypted.size }
            : null,
          mp3: existing.mp3 ? { path: existing.mp3.path, size: existing.mp3.size } : null,
        },
      });
    } catch {
      /* 忽略读不了的文件 */
    }
  }

  // 新文件排前面，方便"优先转换新的音乐"
  const order = { new: 0, partial: 1, done: 2 };
  found.sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name, 'zh'));
  return found;
}

const PICK_DIALOG_SCRIPT = path.join(__dirname, 'pick-dialog.ps1');
const REVEAL_SCRIPT = path.join(__dirname, 'reveal-file.ps1');

/**
 * 弹出 Windows 原生选择框（脚本见 pick-dialog.ps1）。
 *
 * 关键点：必须把「用户主动取消」和「对话框打不开」区分开。
 * 取消是正常操作，不该弹任何提示；只有真的打不开才需要告诉用户改用粘贴路径。
 * 走文件重定向而不是管道，避免受限环境下无法创建管道的问题。
 *
 * @returns {{ok:boolean, paths:string[], error:?string, cancelled:boolean}}
 */
function pickWithDialog(mode) {
  const result = runCapture('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PICK_DIALOG_SCRIPT,
    '-Mode',
    mode === 'folder' ? 'folder' : 'files',
    '-Title',
    mode === 'folder' ? 'Select folder' : 'Select .kgg files',
  ]);

  if (result.error) {
    return { ok: false, paths: [], cancelled: false, error: `无法启动选择框：${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim();
    return {
      ok: false,
      paths: [],
      cancelled: false,
      error: detail || `选择框脚本退出码 ${result.status}`,
    };
  }

  const paths = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const p of paths) pickedFiles.add(path.resolve(p).toLowerCase());

  // 脚本正常退出但没有任何输出 = 用户点了取消
  return { ok: true, paths, cancelled: paths.length === 0 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log('用法：node src/web/server.js [--port 8787] [--no-open]');
    return;
  }

  const dbPath = locate.findDatabase(null);
  let keys;
  try {
    keys = dbPath
      ? keymap.createDatabaseKeyStore(dbPath)
      : { provider: keymap.createProvider(new Map(), '未找到密钥库'), dispose() {}, reload: () => ({ reloaded: false }) };
  } catch (err) {
    console.error(`加载密钥库失败：${err.message}`);
    process.exitCode = 2;
    return;
  }

  // 设置文件（config\settings.ini）：不存在就生成一份，值留空 = 用内置默认路径
  const ensuredSettings = dirConfig.ensureFile();

  // 临时覆盖（只影响本次运行，不写进设置文件）
  if (opts.inputDir || opts.outputDir) {
    dirConfig.setOverride({ inputDir: opts.inputDir, outputDir: opts.outputDir });
  }

  // 输出目录可能在运行中被用户改掉，所以传一个取值函数而不是固定路径
  const runner = createRunner({
    provider: keys.provider,
    getOutputDir: () => dirConfig.outputDir(),
  });
  const sseClients = new Set();

  // ---- 页面全部关闭后自动退出 ----
  //
  // 判据是"还有没有页面连着 SSE"，而不是去监听网页的关闭事件：
  // 刷新页面也会触发 beforeunload，靠它会导致一按 F5 服务就自杀。
  // SSE 连接在后台标签页里也保持不断（不受浏览器定时器节流影响），所以判定很稳。
  let autoExitTimer = null;
  let sawAnyClient = false;

  function cancelAutoExit() {
    if (autoExitTimer) {
      clearTimeout(autoExitTimer);
      autoExitTimer = null;
    }
  }

  function scheduleAutoExit() {
    if (!opts.autoExit || autoExitTimer) return;
    if (sseClients.size > 0) return;

    autoExitTimer = setTimeout(() => {
      autoExitTimer = null;
      if (sseClients.size > 0) return; // 期间有页面连回来了

      // 正在转换就先不退：转一半被杀掉是最糟的情况
      const busy = runner
        .snapshot()
        .some((task) => task.status === 'pending' || task.status === 'running');
      if (busy) {
        console.log('  页面已关闭，但还有任务在跑，等它转完再退出…');
        scheduleAutoExit();
        return;
      }

      console.log(
        `  页面已全部关闭且 ${Math.round(opts.autoExitSeconds)} 秒内没有连回来，服务自动退出。`,
      );
      shutdown('auto-exit');
    }, opts.autoExitSeconds * 1000);
    autoExitTimer.unref?.();
  }

  runner.on('update', (tasks) => {
    const payload = `event: tasks\ndata: ${JSON.stringify({ tasks })}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    if (!ALLOWED_HOSTS.has(host)) {
      sendJson(res, 403, { error: '只允许通过 127.0.0.1 访问' });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname;

    try {
      // ---- 静态资源 ----
      if (req.method === 'GET' && !route.startsWith('/api/')) {
        const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
        const filePath = path.join(PUBLIC_DIR, rel);
        if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('404');
          return;
        }
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(body);
        return;
      }

      // ---- 状态 ----
      if (req.method === 'GET' && route === '/api/state') {
        // 用户可能在记事本里手改了设置文件：这里只做一次 stat，变了就重新读取
        dirConfig.reloadIfChanged();

        sendJson(res, 200, {
          keySource: keys.provider.source,
          keyCount: keys.provider.count(),
          keysLoadedAt: keys.loadedAt ? keys.loadedAt.toISOString() : null,
          keysReloadCount: keys.reloadCount ?? 0,
          keysError: keys.lastError ?? null,
          // 只做一次 stat：酷狗可能刚写入了新下载歌曲的密钥
          dbChanged: typeof keys.dbChanged === 'boolean' ? keys.dbChanged : false,
          dbPath,
          dirs: dirConfig.describe(),
          projectRoot: PROJECT_ROOT,
          files: scanKggFiles(),
          tasks: runner.snapshot(),
        });
        return;
      }

      // ---- 手动重新加载密钥库 ----
      if (req.method === 'POST' && route === '/api/reload-keys') {
        if (typeof keys.reload !== 'function') {
          sendJson(res, 200, { reloaded: false, error: '当前密钥来源不支持重新加载' });
          return;
        }
        const result = keys.reload();
        sendJson(res, 200, {
          ...result,
          keyCount: keys.provider.count(),
          keysLoadedAt: keys.loadedAt ? keys.loadedAt.toISOString() : null,
          keysReloadCount: keys.reloadCount ?? 0,
          keysError: keys.lastError ?? null,
          dbChanged: keys.dbChanged ?? false,
        });
        return;
      }

      // ---- 重新扫描 ----
      if (req.method === 'POST' && route === '/api/scan') {
        sendJson(res, 200, { files: scanKggFiles() });
        return;
      }

      // ---- 原生文件选择框 ----
      if (req.method === 'POST' && route === '/api/pick') {
        const body = await readBody(req);
        const picked = pickWithDialog(body.mode === 'folder' ? 'folder' : 'files');
        sendJson(res, 200, { ...picked, files: scanKggFiles() });
        return;
      }

      // ---- 重新读取设置文件（手改之后用）----
      if (req.method === 'POST' && route === '/api/reload-config') {
        dirConfig.reload();
        sendJson(res, 200, { ok: true, dirs: dirConfig.describe(), files: scanKggFiles() });
        return;
      }

      // ---- 在资源管理器里定位设置文件 ----
      if (req.method === 'POST' && route === '/api/open-config') {
        const body = await readBody(req);

        // 文件被删了就先补一份，保证打开时一定看得到
        const ensured = dirConfig.ensureFile();

        // 参数拼法见 config.buildRevealArgs 的说明（自己加内层引号会让它打开"文档"）。
        const args = buildRevealArgs(dirConfig.settingsPath);

        if (body.dryRun === true) {
          sendJson(res, 200, {
            ok: true,
            dryRun: true,
            command: 'explorer.exe',
            args,
            settingsPath: dirConfig.settingsPath,
            recreated: ensured.created,
          });
          return;
        }

        // 不能只 spawn explorer：Windows 有前台风锁，后台进程开的窗口只会闪在任务栏里
        // （用户点了按钮却看不到任何反应）。交给脚本打开后再显式把窗口激活到前台。
        const revealed = runCapture('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          REVEAL_SCRIPT,
          '-Path',
          dirConfig.settingsPath,
        ]);

        if (revealed.error) {
          sendJson(res, 200, {
            ok: false,
            error: `无法启动资源管理器：${revealed.error.message}`,
            settingsPath: dirConfig.settingsPath,
          });
          return;
        }

        const matched = /RESULT ok=(\d) hwnd=(\d+) foreground=(\d+)/.exec(revealed.stdout || '');
        if (!matched || matched[1] !== '1') {
          sendJson(res, 200, {
            ok: false,
            error: (revealed.stderr || '').trim() || '没找到打开的资源管理器窗口',
            settingsPath: dirConfig.settingsPath,
            recreated: ensured.created,
          });
          return;
        }

        sendJson(res, 200, {
          ok: true,
          settingsPath: dirConfig.settingsPath,
          recreated: ensured.created,
          foreground: matched[3] === '1',
        });
        return;
      }

      // ---- 修改 / 恢复 输入输出目录 ----
      if (req.method === 'POST' && route === '/api/dirs') {
        const body = await readBody(req);

        let result;
        if (body.reset) {
          result = dirConfig.reset(body.reset);
        } else {
          result = dirConfig.update(
            { inputDir: body.inputDir, outputDir: body.outputDir },
            { create: body.create === true },
          );
        }

        sendJson(res, 200, {
          ...result,
          dirs: dirConfig.describe(),
          files: scanKggFiles(),
        });
        return;
      }

      // ---- 开始转换 ----
      if (req.method === 'POST' && route === '/api/convert') {
        const body = await readBody(req);
        const requested = Array.isArray(body.paths) ? body.paths : [];
        const accepted = [];
        const rejected = [];
        const skippedConverted = [];

        // 用户是否允许覆盖"已经转换过"的产物
        const overwriteConverted = body.overwriteConverted === true;
        const outputDir = dirConfig.outputDir();
        const wantMp3 = body.mp3 !== false;

        const enqueue = (full) => {
          const baseName = path.parse(full).name;
          const already = outputs.isConverted(outputDir, baseName, wantMp3);

          if (already && !overwriteConverted) {
            skippedConverted.push(full);
            return;
          }

          runner.add(full, {
            ...body,
            // 已转换过的就强制覆盖，否则单文件会被当成"已存在，跳过"
            force: body.force === true || already,
          });
          accepted.push(full);
        };

        for (const item of requested) {
          if (typeof item !== 'string' || item.trim() === '') continue;
          const resolved = path.resolve(item);

          if (!isAllowedPath(resolved)) {
            rejected.push({
              path: resolved,
              reason: '只允许当前输入/输出目录、项目目录内的文件，或通过"选择文件"按钮选中的文件',
            });
            continue;
          }
          if (!fs.existsSync(resolved)) {
            rejected.push({ path: resolved, reason: '文件不存在' });
            continue;
          }

          const stat = fs.statSync(resolved);
          if (stat.isDirectory()) {
            for (const name of fs.readdirSync(resolved)) {
              if (!/\.kgg$/i.test(name)) continue;
              const full = path.join(resolved, name);
              if (fs.statSync(full).isFile()) enqueue(full);
            }
          } else {
            enqueue(resolved);
          }
        }

        runner.pump();
        sendJson(res, 200, {
          accepted,
          rejected,
          skippedConverted,
          tasks: runner.snapshot(),
        });
        return;
      }

      // ---- 清空已完成 ----
      if (req.method === 'POST' && route === '/api/clear') {
        runner.clearFinished();
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- 进度推送 ----
      if (req.method === 'GET' && route === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`event: tasks\ndata: ${JSON.stringify({ tasks: runner.snapshot() })}\n\n`);
        sseClients.add(res);
        sawAnyClient = true;
        cancelAutoExit(); // 有页面连回来了

        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(heartbeat);
          }
        }, 25000);

        req.on('close', () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
          // 最后一个页面断开 → 开始倒计时；刷新时会在宽限期内重连上，所以不会误退
          if (sseClients.size === 0 && sawAnyClient) scheduleAutoExit();
        });
        return;
      }

      // ---- 页面里的「退出」按钮 ----
      if (req.method === 'POST' && route === '/api/shutdown') {
        const busy = runner
          .snapshot()
          .some((task) => task.status === 'pending' || task.status === 'running');
        if (busy) {
          sendJson(res, 409, {
            ok: false,
            error: '还有任务在转换中，等它转完再退出（或直接关掉服务窗口强制结束）',
          });
          return;
        }

        sendJson(res, 200, { ok: true });
        setTimeout(() => shutdown('user-request'), 150);
        return;
      }

      sendJson(res, 404, { error: `未知接口：${route}` });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  // 端口被占用就往后顺延，直到找到空闲端口
  let port = opts.port;
  let bound = false;
  for (let i = 0; i < PORT_TRIES; i++) {
    const attempt = port + i;
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((resolve) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE') resolve(false);
        else {
          console.error(`监听失败：${err.message}`);
          resolve(false);
        }
      };
      server.once('error', onError);
      server.listen(attempt, HOST, () => {
        server.removeListener('error', onError);
        resolve(true);
      });
    });

    if (ok) {
      port = attempt;
      bound = true;
      break;
    }
  }

  if (!bound) {
    console.error(`无法在 ${opts.port}~${opts.port + PORT_TRIES} 之间找到可用端口。`);
    keys.dispose();
    process.exitCode = 2;
    return;
  }

  const url = `http://${HOST}:${port}`;

  if (port !== opts.port) {
    console.log('');
    console.log(`  ⚠ 端口 ${opts.port} 已被占用，本次改用 ${port}。`);
    console.log('    这通常说明**上一个界面窗口还没关掉**，而那个窗口跑的是旧代码。');
    console.log('    请关掉旧窗口后重新双击 bin\\ui.cmd，否则你会对着旧界面以为改动没生效。');
    console.log(`    本次地址：${url}`);
  }

  console.log('');
  console.log('  酷狗 .kgg 转换工具 · 本地界面已启动');
  console.log(`  地址：${url}`);
  console.log(`  密钥库：${keys.provider.source}（${keys.provider.count()} 条可用密钥）`);
  console.log(
    `  设置文件：${dirConfig.settingsPath}` +
      `${ensuredSettings.created ? (ensuredSettings.migrated ? '（已从旧配置迁移）' : '（已生成）') : ''}`,
  );
  console.log(`  输入目录：${dirConfig.inputDir()}${dirConfig.describe().inputIsDefault ? '（默认）' : ''}`);
  console.log(`  输出目录：${dirConfig.outputDir()}${dirConfig.describe().outputIsDefault ? '（默认）' : ''}`);
  console.log('');
  console.log('  只监听本机回环地址，局域网/外网访问不到。');
  if (opts.autoExit) {
    console.log(
      `  关掉所有页面 ${Math.round(opts.autoExitSeconds)} 秒后会自动退出（转换中的任务会先跑完）。`,
    );
    console.log('  想让它一直开着，用 --stay-alive 启动。');
  } else {
    console.log('  已启用 --stay-alive：页面关掉后服务继续运行，按 Ctrl+C 或关闭本窗口才停止。');
  }
  console.log('');

  if (opts.open) {
    try {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    } catch {
      /* 打不开浏览器就让用户手动点 */
    }
  }

  function shutdown(reason) {
    if (reason === 'user-request') console.log('  收到页面上的退出请求，正在退出…');
    keys.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }

  process.on('SIGINT', () => shutdown('sigint'));
  process.on('SIGTERM', () => shutdown('sigterm'));
}

main().catch((err) => {
  console.error(`启动失败：${err.message}`);
  process.exitCode = 2;
});
