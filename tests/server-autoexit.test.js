#!/usr/bin/env node
'use strict';

/**
 * 回归测试：页面关闭后自动退出（以及两条关键保护）。
 *
 * 这件事最容易写错的地方：
 *   1. 用 beforeunload 通知服务端退出 → 一按 F5 服务就自杀了（所以必须靠 SSE 连接数）；
 *   2. 刷新页面时"断开→重连"的间隙不能算成"页面已关闭"；
 *   3. 还有任务在转换时**绝不能**退出。
 *
 * 本测试会真的起一个服务进程（端口用 87xx 里较冷门的），所以没放进默认的 npm test，
 * 单独用 npm run test:server 跑。
 *
 * 运行：node tests/server-autoexit.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const GRACE_SECONDS = 3;

let failures = 0;

function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(extraArgs = [], graceSeconds = GRACE_SECONDS) {
  const outPath = path.join(os.tmpdir(), `autoexit-${Date.now()}.log`);
  const outFd = fs.openSync(outPath, 'w');
  const child = spawn(
    process.execPath,
    [
      path.join(PROJECT_ROOT, 'src', 'web', 'server.js'),
      '--port',
      String(PORT),
      '--no-open',
      '--auto-exit-seconds',
      String(graceSeconds),
      ...extraArgs,
    ],
    { cwd: PROJECT_ROOT, stdio: ['ignore', outFd, outFd], windowsHide: true },
  );

  return {
    child,
    logPath: outPath,
    readLog: () => {
      try {
        return fs.readFileSync(outPath, 'utf8');
      } catch {
        return '';
      }
    },
  };
}

async function serverResponds() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${BASE}/api/state`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** 连上 SSE 并保持一段时间；返回一个可以主动断开的方法。 */
async function connectSse() {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read(); // 先收一条，确认连接建立

  return {
    close() {
      try {
        controller.abort();
      } catch {
        /* 忽略 */
      }
    },
  };
}

async function waitForExit(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await serverResponds())) return true;
    await sleep(300);
  }
  return false;
}

async function main() {
  console.log('页面关闭后自动退出 · 回归测试\n');

  // ── 1. 刷新页面不能把服务搞死 ──
  console.log('【1】刷新页面（断开→重连）不应该导致退出');
  {
    const server = startServer();
    try {
      // 等服务起来
      let up = false;
      for (let i = 0; i < 30 && !up; i++) {
        await sleep(300);
        up = await serverResponds();
      }
      check('服务已启动', up);
      if (!up) throw new Error('服务没起来，后面的测试没法做');

      const first = await connectSse();
      await sleep(500);
      first.close(); // 模拟刷新：断开
      await sleep(1200); // 小于 3 秒宽限期
      const second = await connectSse(); // 新页面连回来
      await sleep(GRACE_SECONDS * 1000 + 1500);

      check('刷新后服务仍在运行（没有误退）', await serverResponds());

      // ── 2. 真正关闭页面 → 宽限期后退出 ──
      console.log('\n【2】所有页面真的关掉之后，宽限期过了应该退出');
      second.close();
      const exited = await waitForExit(GRACE_SECONDS * 1000 + 6000);
      check('页面关闭后服务已退出', exited);

      const log = server.readLog();
      check('日志说明了退出原因', log.includes('自动退出'), log.trim().split('\n').pop());
    } finally {
      try {
        server.child.kill();
      } catch {
        /* 可能已经退出 */
      }
      fs.rmSync(server.logPath, { force: true });
    }
  }

  // ── 3. 退出按钮（/api/shutdown）──
  console.log('\n【3】页面上的「退出」按钮');
  {
    const server = startServer();
    try {
      let up = false;
      for (let i = 0; i < 30 && !up; i++) {
        await sleep(300);
        up = await serverResponds();
      }
      check('服务已启动', up);

      const res = await fetch(`${BASE}/api/shutdown`, { method: 'POST' });
      const body = await res.json();
      check('退出请求被接受', res.ok && body.ok === true, JSON.stringify(body));

      const exited = await waitForExit(6000);
      check('收到退出请求后服务已退出', exited);
    } finally {
      try {
        server.child.kill();
      } catch {
        /* 可能已经退出 */
      }
      fs.rmSync(server.logPath, { force: true });
    }
  }

  // ── 4. --stay-alive 时不应该自动退出 ──
  console.log('\n【4】--stay-alive：页面关掉也继续运行');
  {
    const server = startServer(['--stay-alive']);
    try {
      let up = false;
      for (let i = 0; i < 30 && !up; i++) {
        await sleep(300);
        up = await serverResponds();
      }
      check('服务已启动', up);

      const sse = await connectSse();
      await sleep(400);
      sse.close();
      await sleep(GRACE_SECONDS * 1000 + 3000);

      check('页面关闭后服务仍在运行', await serverResponds());
    } finally {
      try {
        server.child.kill();
      } catch {
        /* 忽略 */
      }
      fs.rmSync(server.logPath, { force: true });
    }
  }

  // ── 5. 还有任务在跑时不能退出 ──
  //
  // 注意：单首歌转码只要 2~3 秒（实测 4 分钟的歌转 320k 约 2.7 秒），
  // 所以必须让队列里有多首歌，才能保证宽限期到期时任务确实还在跑。
  //
  // ⚠ 不能去改 config\settings.ini 里的输出目录 —— 那是用户的持久配置，
  //   测试改完忘恢复就会把用户的设置改坏（这个坑踩过一次）。
  //   改用 --output-dir 命令行覆盖：只影响这次进程，不落盘。
  console.log('\n【5】还有任务在转换时，不能退出');
  {
    const tempOut = fs.mkdtempSync(path.join(os.tmpdir(), 'autoexit-out-'));
    const server = startServer(['--output-dir', tempOut], 1); // 宽限期压到 1 秒
    try {
      let up = false;
      for (let i = 0; i < 30 && !up; i++) {
        await sleep(300);
        up = await serverResponds();
      }
      check('服务已启动', up);

      const state = await (await fetch(`${BASE}/api/state`)).json();
      check('有可用的 .kgg 样本', state.files.length > 0, `${state.files.length} 个`);
      check(
        '输出目录用的是命令行覆盖，没动设置文件',
        state.dirs.outputDir === tempOut && state.dirs.outputOverridden === true,
        state.dirs.outputDir,
      );

      if (state.files.length > 0) {
        const sse = await connectSse();
        const conv = await fetch(`${BASE}/api/convert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: state.files.map((f) => f.path), mp3: true }),
        }).then((r) => r.json());
        check('转换已排队', conv.accepted.length > 0, `${conv.accepted.length} 个`);

        await sleep(600); // 让它开始跑
        sse.close(); // 关掉页面

        await sleep(4000); // 远超 1 秒宽限期

        check('任务还在跑时服务没有退出', await serverResponds());
        check(
          '日志说明了在等任务转完',
          server.readLog().includes('还有任务在跑'),
          '日志里应有"还有任务在跑"',
        );
      }
    } finally {
      try {
        server.child.kill();
      } catch {
        /* 忽略 */
      }
      // 等服务进程和被它拉起的 ffmpeg 释放文件句柄，再删临时输出目录；
      // 删不掉就重试几次——这里失败不该算测试失败。
      await sleep(1500);
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(tempOut, { recursive: true, force: true });
          break;
        } catch {
          await sleep(800);
        }
      }
      fs.rmSync(server.logPath, { force: true });
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

main().catch((err) => {
  console.error(`测试出错：${err.message}`);
  process.exitCode = 1;
});
