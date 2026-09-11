#!/usr/bin/env node
'use strict';

/**
 * 回归测试：设置文件（config\settings.ini）的解析与路径容错。
 *
 * 这里覆盖的都是"用户手写配置"最容易出问题的点：
 *   - 单反斜杠 / 正斜杠 / 双反斜杠 / 混合，都应该能认
 *   - 资源管理器复制出来的路径常带引号
 *   - 记事本另存为 UTF-8 会加 BOM
 *   - 相对路径、%环境变量%
 *   - 写错的行、未知的设置项，要带行号报出来而不是被吞掉
 *
 * 运行：node tests/config-ini.test.js
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { runCapture } = require('../src/audio/transcode');

const {
  parseSettings,
  normalizePath,
  toStoredPath,
  buildRevealArgs,
  buildFileContent,
  KNOWN_KEYS,
  TEMPLATE,
} = require('../src/web/config');

const PROJECT_ROOT = path.resolve(__dirname, '..');

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

function checkOk(name, condition, detail) {
  console.log(`  ${condition ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

function main() {
  console.log('设置文件解析与路径容错测试\n');

  // ── 1. ini 解析 ──
  console.log('【解析 ini】');
  {
    // BOM：记事本另存为 UTF-8 会加上，必须能正确处理
    const bomOnly = parseSettings('\uFEFFinputDir=D:\\bom');
    check('带 BOM 也能解析出 inputDir', bomOnly.values.get('inputDir'), 'D:\\bom');

    const text = [
      '\uFEFF# 这是注释',
      '; 分号也是注释',
      '',
      'inputDir=D:\\KuGou\\KugouMusic',
      '  outputDir  =  E:/Music/out  ',
      'unknownKey=whatever',
      '这一行没有等号',
      'INPUTDIR=D:\\大小写不敏感',
    ].join('\r\n');

    const { values, problems } = parseSettings(text);

    check('键名/值两侧空格被裁掉', values.get('outputDir'), 'E:/Music/out');
    check('键名大小写不敏感，且后者覆盖前者', values.get('inputDir'), 'D:\\大小写不敏感');
    check('重复键 / 未知项 / 无等号 都被报告', problems.length, 3);
    checkOk('未知项报错带行号', problems[0].line === 6, `第 ${problems[0].line} 行`);
    checkOk('无等号的行被报告', problems[1].line === 7, `第 ${problems[1].line} 行`);
    checkOk('重复键被报告', problems[2].line === 8, `第 ${problems[2].line} 行`);
    checkOk('未知项的提示里列出了可用键', problems[0].message.includes('inputDir'), problems[0].message);
    checkOk('重复键的提示说明了谁覆盖谁', problems[2].message.includes('覆盖'), problems[2].message);
  }

  // ── 2. 路径容错 ──
  console.log('\n【路径容错】');
  const cases = [
    ['单反斜杠原样', 'D:\\KuGou\\KugouMusic', 'D:\\KuGou\\KugouMusic'],
    ['正斜杠', 'D:/KuGou/KugouMusic', 'D:\\KuGou\\KugouMusic'],
    ['双反斜杠', 'D:\\\\KuGou\\\\KugouMusic', 'D:\\KuGou\\KugouMusic'],
    ['双正斜杠', 'D://KuGou//KugouMusic', 'D:\\KuGou\\KugouMusic'],
    ['斜杠混用', 'D:/KuGou\\\\KugouMusic', 'D:\\KuGou\\KugouMusic'],
    ['双引号包裹', '"D:\\KuGou\\KugouMusic"', 'D:\\KuGou\\KugouMusic'],
    ['单引号包裹', "'D:/KuGou/KugouMusic'", 'D:\\KuGou\\KugouMusic'],
    ['末尾多一个斜杠', 'D:\\KuGou\\KugouMusic\\', 'D:\\KuGou\\KugouMusic'],
    ['盘符根保留', 'D:\\', 'D:\\'],
  ];

  for (const [name, input, expected] of cases) {
    const result = normalizePath(input);
    check(name, result ? result.text : null, expected);
  }

  {
    const unc = normalizePath('\\\\server\\share\\music');
    check('UNC 前缀不被压成一个反斜杠', unc.text, '\\\\server\\share\\music');
  }

  {
    const expanded = normalizePath('%TEMP%\\kgg');
    checkOk('展开 %环境变量%', expanded.text === path.join(process.env.TEMP, 'kgg'), expanded.text);
    checkOk('标记出"展开过环境变量"', expanded.expanded === true);
  }

  {
    const relative = normalizePath('music\\out');
    checkOk('相对路径被标记', relative.relative === true);
    checkOk('相对路径按项目目录解析', relative.resolved.endsWith(path.join('KugoToMP3', 'music', 'out')), relative.resolved);
  }

  {
    const unchanged = normalizePath('D:\\a\\b');
    checkOk('本来就规范的路径不会标记为"已转换"', unchanged.changed === false);
    const changed = normalizePath('D:/a/b');
    checkOk('做过归一化的路径会被标记', changed.changed === true);
  }

  checkOk('空字符串返回 null', normalizePath('   ') === null);

  // ── 3. 文件模板 ──
  console.log('\n【设置文件模板】');
  {
    const content = buildFileContent(new Map());
    checkOk('模板里包含两个键且值留空', /inputDir=\r?\noutputDir=\r?\n?$/.test(content.trimEnd() + '\n'), '键已生成');

    const { values, problems } = parseSettings(content);
    check('模板本身能被解析（无报错行）', problems.length, 0);
    checkOk('模板解析后两个键都是空值', values.get('inputDir') === '' && values.get('outputDir') === '');
    checkOk('模板里说明了"留空 = 默认"', content.includes('留空'), '');
    checkOk('模板里给了反斜杠写法示例', content.includes('D:\\KuGou\\KugouMusic'), '');
    checkOk('模板里没有未替换的占位符', !content.includes('${'), '');

    // 写入值后再读回
    const withValues = buildFileContent(new Map([['inputDir', 'D:\\a'], ['outputDir', 'E:\\b']]));
    const reparsed = parseSettings(withValues);
    check('写入的值能被读回（inputDir）', reparsed.values.get('inputDir'), 'D:\\a');
    check('写入的值能被读回（outputDir）', reparsed.values.get('outputDir'), 'E:\\b');
    check('保留注释行', reparsed.problems.length, 0);
  }

  // ── 4. 项目内路径存成相对路径（项目搬家也能用）──
  console.log('\n【相对路径存储】');
  {
    const inside = path.join(PROJECT_ROOT, 'input');
    const nested = path.join(PROJECT_ROOT, '素材', 'kgg');

    check('项目内的目录存成相对路径', toStoredPath(inside), 'input');
    check('项目内的子目录也相对', toStoredPath(nested), path.join('素材', 'kgg'));
    check('项目根目录本身存成 .', toStoredPath(PROJECT_ROOT), '.');
    check('项目外的目录只能存绝对路径', toStoredPath('D:\\KuGou\\KugouMusic'), 'D:\\KuGou\\KugouMusic');

    // 关键性质：存成相对路径后，解析回来必须还是同一个绝对路径
    const roundTrip = normalizePath(toStoredPath(inside));
    check('相对路径能解析回原路径', roundTrip.resolved, inside);
    checkOk('解析时会标记这是相对路径', roundTrip.relative === true);
  }

  // ── 5. 资源管理器定位参数 ──
  console.log('\n【资源管理器定位参数】');
  {
    // 让子进程把自己的 argv 写进文件，确认 Node 在 Windows 上到底传了什么过去。
    // （受限环境不能用管道捕获子进程输出，所以走文件。）
    function deliveredArgv(arg) {
      const outFile = path.join(os.tmpdir(), `reveal-argv-${process.pid}.json`);
      fs.rmSync(outFile, { force: true });
      const echo = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))';
      runCapture(process.execPath, ['-e', echo, outFile, arg]);
      const text = fs.readFileSync(outFile, 'utf8');
      fs.rmSync(outFile, { force: true });
      return JSON.parse(text);
    }

    const args = buildRevealArgs('D:\\a\\b.ini');
    check('只生成一个参数', args.length, 1);
    check('参数内容正确', args[0], '/select,D:\\a\\b.ini');
    checkOk('参数里没有字面双引号', !args[0].includes('"'), args[0]);

    const delivered = deliveredArgv(args[0]);
    check('传过去仍是同一个参数（没有被拆开或破坏）', JSON.stringify(delivered), JSON.stringify(['/select,D:\\a\\b.ini']));

    // 反例：旧写法「手动加内层引号」会把引号当字面字符传过去，
    // explorer 认不出路径 → 默默打开"文档"文件夹。这个测试防止回退。
    const badDelivered = deliveredArgv('/select,"D:\\a\\b.ini"');
    checkOk('反例：旧的加引号写法确实会把引号传进去', badDelivered[0].includes('"'), badDelivered[0]);
  }

  // ── 6. 键名一致性 ──
  console.log('\n【接口一致性】');
  checkOk('KNOWN_KEYS 就是两个目录键', KNOWN_KEYS.join(',') === 'inputDir,outputDir', KNOWN_KEYS.join(','));
  checkOk('TEMPLATE 是纯文本且非空', typeof TEMPLATE === 'string' && TEMPLATE.length > 100);

  console.log('');
  if (failures === 0) {
    console.log('全部通过。');
  } else {
    console.log(`有 ${failures} 项未通过。`);
    process.exitCode = 1;
  }
}

main();
