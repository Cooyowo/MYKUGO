'use strict';

/**
 * 网页界面用的任务队列。
 *
 * 因为界面和解密逻辑跑在**同一个 Node 进程**里，所以进度不需要任何进程间通信，
 * 直接用事件把状态推给 SSE 即可（这正是"本地网页比桌面壳简单"的关键原因）。
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');

const { decryptToFile, inspect } = require('../kugou/audio-decrypt');
const { transcodeToMp3 } = require('../audio/transcode');
const outputs = require('./outputs');

const PROGRESS_THROTTLE_MS = 200;

function createRunner({ provider, getOutputDir }) {
  const emitter = new EventEmitter();
  const tasks = new Map();
  const order = [];
  let seq = 0;
  let running = false;
  let lastEmit = 0;

  function snapshot() {
    return order.map((id) => ({ ...tasks.get(id) }));
  }

  function emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    emitter.emit('update', snapshot());
  }

  function add(inputPath, options = {}) {
    // 同一个文件不重复排队
    const existing = order
      .map((id) => tasks.get(id))
      .find((t) => t.input === inputPath && (t.status === 'pending' || t.status === 'running'));
    if (existing) return existing;

    const id = `t${++seq}`;
    const task = {
      id,
      input: inputPath,
      name: path.basename(inputPath),
      status: 'pending',
      stage: '排队中',
      progress: 0,
      message: '',
      outputs: [],
      decrypted: null,
      mp3: null,
      options: {
        mp3: options.mp3 !== false,
        force: options.force === true,
        bitrate: options.bitrate || null,
        deepCheck: options.deepCheck === true,
      },
    };

    tasks.set(id, task);
    order.push(id);
    emitUpdate(true);
    return task;
  }

  async function runTask(task) {
    task.status = 'running';
    task.stage = '解密';
    task.progress = 0;
    task.message = '';
    emitUpdate(true);

    const outputDir = getOutputDir();

    // 已经转换过、且用户没有要求覆盖 → 直接跳过（不必解密，也不必查密钥）
    if (!task.options.force) {
      const baseName = path.parse(task.input).name;
      if (outputs.isConverted(outputDir, baseName, task.options.mp3)) {
        task.status = 'skipped';
        task.stage = '已转换，已跳过';
        task.message = '输出目录里已经有这首歌的产物。要重新转换就勾选"覆盖已转换的"。';
        emitUpdate(true);
        return;
      }
    }

    const info = inspect(task.input);
    const record = provider.find(info.header.keyId);
    if (!record) {
      const extra = provider.lastError
        ? `\n  另外，重新加载密钥库时也失败了：${provider.lastError}\n  如果酷狗正在运行，可以退出酷狗后点"重新加载密钥库"再试。`
        : '';
      throw new Error(
        `密钥库里没有这首歌的密钥（keyId=${info.header.keyId}）。\n` +
          '  请先在酷狗里播放一次该歌曲，并确认是在本机下载的。' +
          extra,
      );
    }

    const decrypted = decryptToFile(task.input, outputDir, provider, {
      force: task.options.force,
      onProgress: (done, total) => {
        task.progress = (done / total) * 100;
        emitUpdate();
      },
    });

    task.decrypted = {
      path: decrypted.outputPath,
      format: decrypted.format,
      bytes: decrypted.bytes,
      skipped: !!decrypted.skipped,
      notes: decrypted.verification.notes,
    };
    task.outputs = [decrypted.outputPath];
    task.progress = 100;
    emitUpdate(true);

    if (task.options.mp3 && decrypted.format !== 'mp3') {
      const mp3Path = path.join(outputDir, `${path.parse(task.input).name}.mp3`);

      task.stage = '转 MP3';
      task.progress = 0;
      emitUpdate(true);

      const mp3 = await transcodeToMp3(decrypted.outputPath, mp3Path, {
        record,
        bitrate: task.options.bitrate || undefined,
        deepCheck: task.options.deepCheck,
        onProgress: (done, total) => {
          task.progress = (done / total) * 100;
          emitUpdate();
        },
      });

      task.mp3 = {
        path: mp3.outputPath,
        duration: mp3.duration,
        bitRate: mp3.bitRate,
        size: mp3.size,
        tags: mp3.tags,
      };
      task.outputs.push(mp3.outputPath);
    }

    task.status = 'done';
    task.stage = '完成';
    task.progress = 100;
    emitUpdate(true);
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const next = order.map((id) => tasks.get(id)).find((t) => t.status === 'pending');
        if (!next) break;

        try {
          await runTask(next);
        } catch (err) {
          next.status = 'failed';
          next.stage = '失败';
          next.message = err.message;
          emitUpdate(true);
        }
      }
    } finally {
      running = false;
      emitUpdate(true);
    }
  }

  function clearFinished() {
    for (const id of [...order]) {
      const task = tasks.get(id);
      if (task.status === 'done' || task.status === 'failed' || task.status === 'skipped') {
        tasks.delete(id);
        order.splice(order.indexOf(id), 1);
      }
    }
    emitUpdate(true);
  }

  return {
    on: (event, handler) => emitter.on(event, handler),
    add,
    pump,
    snapshot,
    clearFinished,
    isRunning: () => running,
  };
}

module.exports = { createRunner };
