#!/usr/bin/env node
'use strict';

/**
 * 回归测试：产物状态判定（"已转换 / 部分转换 / 新文件"）。
 *
 * 这块逻辑容易错在细节上，比如：
 *   - 只解出了 .ogg、还没转 MP3，到底算不算转换过？（算"部分"，需要补齐）
 *   - 用户只要原始音频、不要 MP3 时，有 .ogg 就算完成
 *   - 解密出来的明文本身就是 MP3 时，一个文件就够，不该再等第二个
 *
 * 运行：node tests/outputs-status.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outputs = require('../src/web/outputs');

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — 期望 ${expected}，实际 ${actual}`}`);
  if (!ok) failures++;
}

function touch(dir, name, bytes = 16) {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));
}

function main() {
  console.log('产物状态判定测试\n');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kugou-status-'));

  try {
    // 1. 什么都没有
    check('空目录 → new', outputs.findOutputs(dir, 'A').status, 'new');
    check('空目录 → 未转换', outputs.isConverted(dir, 'A', true), false);

    // 2. 只有解密出的 .ogg（还没转 MP3）
    touch(dir, 'B.ogg');
    check('只有 .ogg → partial', outputs.findOutputs(dir, 'B').status, 'partial');
    check('只有 .ogg、用户要 MP3 → 仍需转换', outputs.isConverted(dir, 'B', true), false);
    check('只有 .ogg、用户不要 MP3 → 已完成', outputs.isConverted(dir, 'B', false), true);

    // 3. .ogg + .mp3 都在
    touch(dir, 'C.ogg');
    touch(dir, 'C.mp3');
    check('.ogg + .mp3 → done', outputs.findOutputs(dir, 'C').status, 'done');
    check('.ogg + .mp3 → 已完成', outputs.isConverted(dir, 'C', true), true);

    // 4. 明文本身就是 MP3（只有一个 .mp3 文件）
    touch(dir, 'D.mp3');
    const d = outputs.findOutputs(dir, 'D');
    check('只有 .mp3 → done', d.status, 'done');
    check('只有 .mp3 时，解密产物被识别为 mp3', d.decrypted && d.decrypted.ext, 'mp3');
    check('只有 .mp3、用户要 MP3 → 已完成', outputs.isConverted(dir, 'D', true), true);
    check('只有 .mp3、用户不要 MP3 → 已完成', outputs.isConverted(dir, 'D', false), true);

    // 5. 无损源：.flac + .mp3
    touch(dir, 'E.flac');
    touch(dir, 'E.mp3');
    check('.flac + .mp3 → done', outputs.findOutputs(dir, 'E').status, 'done');

    // 6. 无损源只解出 .flac
    touch(dir, 'F.flac');
    check('只有 .flac → partial', outputs.findOutputs(dir, 'F').status, 'partial');
    check('只有 .flac、不要 MP3 → 已完成', outputs.isConverted(dir, 'F', false), true);

    // 7. 只有 .mp3、没有解密原件（用户手删了 .ogg）
    touch(dir, 'G.mp3');
    check('只剩 .mp3 → done', outputs.findOutputs(dir, 'G').status, 'done');

    // 8. 同时有 .ogg / .flac / .mp3：解密原件应优先识别为非 mp3
    touch(dir, 'H.ogg');
    touch(dir, 'H.flac');
    touch(dir, 'H.mp3');
    check('多扩展名时优先取非 mp3 作为原件', outputs.findOutputs(dir, 'H').decrypted.ext, 'ogg');

    // 9. 名字相近但不能混淆（A 有产物不应影响 AB）
    touch(dir, 'AI.ogg');
    touch(dir, 'AI.mp3');
    check('前缀相近的文件互不影响', outputs.findOutputs(dir, 'A').status, 'new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
