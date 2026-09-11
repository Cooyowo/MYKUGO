'use strict';

/**
 * 用 ffmpeg 把（已解密的）原始音频转成 MP3，并写入 ID3 标签。
 *
 * 两个刻意的设计：
 *  1. 不用管道读子进程输出，而是把 stdout/stderr/进度重定向到临时文件。
 *     这样既不会踩到「受限环境禁止管道」的坑，也不会因为输出量大而卡死在管道缓冲区。
 *  2. 先写 .part 临时文件，转码 + 校验都通过后才改名成正式产物，
 *     绝不在 output\ 里留下半成品或坏文件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');

const DEFAULT_BITRATE = '320k';
const DEFAULT_SAMPLE_RATE = 44100;
const DURATION_TOLERANCE_SEC = 1.5;
const BITRATE_TOLERANCE_RATIO = 0.08;

function tempFile(tag) {
  return path.join(
    os.tmpdir(),
    `kugou-${tag}-${process.pid}-${crypto.randomBytes(5).toString('hex')}`,
  );
}

/**
 * 同步执行命令并把 stdout/stderr 落盘后再读回（不使用管道）。
 * @returns {{status:?number, stdout:string, stderr:string, error:?Error}}
 */
function runCapture(cmd, args) {
  const outPath = tempFile('out');
  const errPath = tempFile('err');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');

  let result;
  try {
    result = spawnSync(cmd, args, {
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const stdout = fs.readFileSync(outPath, 'utf8');
  const stderr = fs.readFileSync(errPath, 'utf8');
  fs.rmSync(outPath, { force: true });
  fs.rmSync(errPath, { force: true });

  return { status: result.status, stdout, stderr, error: result.error };
}

/** 定位 ffmpeg / ffprobe，支持环境变量与显式指定。 */
function findTools(options = {}) {
  const ffmpeg = options.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = options.ffprobe || process.env.FFPROBE_PATH || 'ffprobe';

  const check = runCapture(ffmpeg, ['-hide_banner', '-version']);
  if (check.error || check.status !== 0) {
    throw new Error(
      `找不到可用的 ffmpeg（尝试执行：${ffmpeg}）。\n` +
        '  请安装 ffmpeg 并加入 PATH，或用 --ffmpeg <路径> / 环境变量 FFMPEG_PATH 指定。',
    );
  }

  const probeCheck = runCapture(ffprobe, ['-hide_banner', '-version']);
  if (probeCheck.error || probeCheck.status !== 0) {
    throw new Error(
      `找不到可用的 ffprobe（尝试执行：${ffprobe}）。\n` +
        '  它通常和 ffmpeg 一起安装，可用 --ffprobe <路径> / 环境变量 FFPROBE_PATH 指定。',
    );
  }

  return { ffmpeg, ffprobe };
}

/** 读取媒体信息（JSON）。 */
function probe(tool, filePath) {
  const res = runCapture(tool, [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    filePath,
  ]);

  if (res.error) {
    throw new Error(`执行 ffprobe 失败：${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`ffprobe 无法解析该文件：${res.stderr.trim() || '未知错误'}`);
  }

  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error('ffprobe 返回的内容不是合法 JSON');
  }
}

/** 从探测结果里取出音频流信息。 */
function audioInfo(info) {
  const stream = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!stream) throw new Error('该文件里没有音频流');
  return {
    codec: stream.codec_name,
    sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    channels: stream.channels ?? null,
    duration: info.format && info.format.duration ? Number(info.format.duration) : null,
    bitRate: info.format && info.format.bit_rate ? Number(info.format.bit_rate) : null,
  };
}

/**
 * 组装 ID3 标签：密钥库信息优先，其次从「歌手 - 歌名」文件名推断。
 */
function buildTags(inputPath, record) {
  const baseName = path.parse(inputPath).name;
  let artist = null;
  let title = null;

  const matched = baseName.match(/^(.+?)\s+-\s+(.+)$/);
  if (matched) {
    artist = matched[1].trim();
    title = matched[2].trim();
  } else {
    title = baseName;
  }

  if (record) {
    if (record.songName) title = record.songName;
    if (record.artist) artist = record.artist;
  }

  const tags = { title };
  if (artist) tags.artist = artist;
  if (record && record.album) tags.album = record.album;

  return tags;
}

/**
 * 转码成 MP3（CBR）。
 *
 * @param {string} inputPath 已解密的原始音频
 * @param {string} outputPath 目标 .mp3
 * @param {{record?:object, ffmpeg?:string, ffprobe?:string, bitrate?:string,
 *          sampleRate?:number, tags?:object, sourceDuration?:?number,
 *          onProgress?:Function, deepCheck?:boolean}} [options]
 */
async function transcodeToMp3(inputPath, outputPath, options = {}) {
  const tools = findTools(options);
  const bitrate = options.bitrate || DEFAULT_BITRATE;
  const sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
  const tags = options.tags || buildTags(inputPath, options.record);

  const sourceInfo = audioInfo(probe(tools.ffprobe, inputPath));
  const sourceDuration = options.sourceDuration || sourceInfo.duration;

  const tempPath = `${outputPath}.part`;
  const errPath = tempFile('fferr');
  const progressPath = tempFile('ffprog');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel', 'error',
    '-i', inputPath,
    '-map', '0:a:0',
    '-map_metadata', '-1', // 丢掉继承来的元数据，只写我们显式指定的
    '-c:a', 'libmp3lame',
    '-b:a', bitrate,
    '-ar', String(sampleRate),
    '-id3v2_version', '3', // 兼容性最好的 ID3v2.3
    '-progress', progressPath,
  ];

  for (const [key, value] of Object.entries(tags)) {
    if (value) args.push('-metadata', `${key}=${value}`);
  }

  args.push('-f', 'mp3', tempPath);

  const errFd = fs.openSync(errPath, 'w');
  let progressTimer = null;

  const cleanupTemp = () => {
    fs.rmSync(errPath, { force: true });
    fs.rmSync(progressPath, { force: true });
  };

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(tools.ffmpeg, args, {
        stdio: ['ignore', 'ignore', errFd],
        windowsHide: true,
      });

      if (typeof options.onProgress === 'function' && sourceDuration) {
        progressTimer = setInterval(() => {
          try {
            const text = fs.readFileSync(progressPath, 'utf8');
            const matches = text.match(/out_time_us=(\d+)/g);
            if (matches && matches.length > 0) {
              const last = matches[matches.length - 1];
              const micros = Number(last.split('=')[1]);
              options.onProgress(Math.min(micros / 1e6, sourceDuration), sourceDuration);
            }
          } catch {
            /* 进度文件还没生成，忽略 */
          }
        }, 200);
      }

      child.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)));
      child.on('close', (code) => resolve(code));
    });

    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
    fs.closeSync(errFd);

    const stderr = fs.readFileSync(errPath, 'utf8').trim();

    if (exitCode !== 0) {
      fs.rmSync(tempPath, { force: true });
      throw new Error(`ffmpeg 转码失败（退出码 ${exitCode}）：\n  ${stderr || '无错误输出'}`);
    }

    // 转码后校验：编解码器、时长、码率是否符合预期
    const outInfo = audioInfo(probe(tools.ffprobe, tempPath));
    const problems = [];

    if (outInfo.codec !== 'mp3') problems.push(`产物编码不是 mp3，而是 ${outInfo.codec}`);
    if (
      sourceDuration &&
      outInfo.duration &&
      Math.abs(outInfo.duration - sourceDuration) > DURATION_TOLERANCE_SEC
    ) {
      problems.push(
        `时长偏差过大（源 ${sourceDuration.toFixed(2)}s，产物 ${outInfo.duration.toFixed(2)}s）`,
      );
    }

    const targetBitRate = Number(String(bitrate).replace(/k$/i, '')) * 1000;
    if (
      outInfo.bitRate &&
      targetBitRate &&
      Math.abs(outInfo.bitRate - targetBitRate) / targetBitRate > BITRATE_TOLERANCE_RATIO
    ) {
      problems.push(`码率偏离预期（目标约 ${targetBitRate}，实际 ${outInfo.bitRate}）`);
    }

    if (options.deepCheck) {
      const decode = runCapture(tools.ffmpeg, [
        '-v', 'error',
        '-i', tempPath,
        '-f', 'null',
        '-',
      ]);
      if (decode.status !== 0 || decode.stderr.trim() !== '') {
        problems.push(`整片解码校验未通过：${decode.stderr.trim() || `退出码 ${decode.status}`}`);
      }
    }

    if (problems.length > 0) {
      fs.rmSync(tempPath, { force: true });
      throw new Error(`转码结果校验未通过，已删除产物：\n  - ${problems.join('\n  - ')}`);
    }

    fs.renameSync(tempPath, outputPath);

    const stat = fs.statSync(outputPath);
    return {
      outputPath,
      size: stat.size,
      duration: outInfo.duration,
      bitRate: outInfo.bitRate,
      sampleRate: outInfo.sampleRate,
      tags,
      source: sourceInfo,
    };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    try {
      fs.closeSync(errFd);
    } catch {
      /* 已经关过了 */
    }
    // 成功时 tempPath 已被改名，这里是空操作；失败时用来清理残留
    fs.rmSync(tempPath, { force: true });
    cleanupTemp();
  }
}

module.exports = {
  transcodeToMp3,
  buildTags,
  findTools,
  probe,
  audioInfo,
  runCapture,
  DEFAULT_BITRATE,
  DEFAULT_SAMPLE_RATE,
};
