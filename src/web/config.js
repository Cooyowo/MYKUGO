'use strict';

/**
 * 目录设置文件：config\settings.ini
 *
 * ── 为什么用 ini 而不是 JSON ──
 * Windows 路径里全是反斜杠，而 JSON 里反斜杠是转义字符：
 *   写 "D:\KuGou"    → 解析直接失败（\K 不是合法转义）
 *   写 "D:\\KuGou"   → 这才是 1 个反斜杠，但"两个才等于一个"很容易记反
 *   写 "D:\\\\KuGou" → 静默变成 2 个反斜杠，路径悄悄出错且不报错
 * key=value 的 ini 完全不需要转义，所见即所得，还能写 # 注释。
 * 代价是要自己写解析器（约 40 行），对零依赖的本项目来说划算。
 *
 * ── 行为约定 ──
 *   1. 启动时文件不存在 → 自动生成一份（带注释和示例），值留空
 *   2. 值留空 / 该键不写 / 文件被删 → 三者行为一致，都用程序内置默认路径
 *   3. 路径写法容错：单双反斜杠、正斜杠、引号、%环境变量%、相对路径都认
 *   4. 配置了但不可用（不存在 / 不是目录 / 不可写）→ **不静默改正**，
 *      而是如实使用并明确报错，把"你写的"和"程序理解的"都显示出来
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.ini');
const LEGACY_JSON_PATH = path.join(PROJECT_ROOT, '.ui-config.json');

const DEFAULT_INPUT_DIR = path.join(PROJECT_ROOT, 'input');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

const KEY_INPUT = 'inputDir';
const KEY_OUTPUT = 'outputDir';
const KNOWN_KEYS = [KEY_INPUT, KEY_OUTPUT];
const KEY_LABELS = { [KEY_INPUT]: '输入目录', [KEY_OUTPUT]: '输出目录' };
const DEFAULT_VALUES = { [KEY_INPUT]: DEFAULT_INPUT_DIR, [KEY_OUTPUT]: DEFAULT_OUTPUT_DIR };

const TEMPLATE = `# ============================================================
#  酷狗 .kgg 转换工具 · 目录设置
# ============================================================
#  改完保存即可，回到网页界面点「重新读取配置」（或刷新页面）就生效。
#
#  留空 = 使用程序内置的默认路径，也就是：
#    输入目录  <项目目录>\\input
#    输出目录  <项目目录>\\output
#
#  ★ 想让整个项目文件夹搬到哪里都能用：留空即可，或者写相对路径：
#      inputDir=input
#      outputDir=output
#    相对路径是相对**项目目录**的，项目整体搬家/复制都不会失效。
#    只有写到项目外面的绝对路径（例如 D:\\KuGou\\KugouMusic）才依赖盘符位置。
#    界面上改目录时，如果选的是项目内的目录，会自动存成相对路径。
#
#  路径写法很宽松，下面这些都能认：
#    D:\\KuGou\\KugouMusic
#    D:/KuGou/KugouMusic
#    D:\\\\KuGou\\\\KugouMusic
#    "D:\\KuGou\\KugouMusic"
#    %USERPROFILE%\\Music\\kgg
#    input                       （相对项目目录）
#    ..\\素材\\kgg                 （相对项目目录，可以往上走）
#
#  目录必须真实存在，否则网页界面会提示，转换也会失败。
#  本文件可以放心删除：下次启动会自动重新生成，并回退到默认路径。
# ============================================================

${KEY_INPUT}=
${KEY_OUTPUT}=
`;

function short(text) {
  const value = String(text);
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

function fingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

/**
 * 决定一个绝对路径在设置文件里怎么存。
 *   - 在项目目录内 → 存**相对路径**（如 input、output），这样整个项目文件夹
 *     被复制/搬到别的位置也能正确读取
 *   - 在项目目录外 → 只能存绝对路径（例如 D:\KuGou\KugouMusic）
 */
function toStoredPath(absolute) {
  const target = path.resolve(absolute);
  const rootLower = PROJECT_ROOT.toLowerCase();
  const targetLower = target.toLowerCase();

  if (targetLower === rootLower) return '.';
  if (!targetLower.startsWith(rootLower + path.sep)) return target;

  return path.relative(PROJECT_ROOT, target) || '.';
}

/**
 * 生成"在资源管理器里定位文件"的参数。
 *
 * ⚠ 不要自己再加一层引号：Node 在 Windows 上会给含空格或引号的参数**整体**加引号，
 * 如果参数内部再套一层引号，explorer 收到的是 /select,"D:\...ini"（引号是字面字符），
 * 它认不出这个路径，会默默打开"文档"文件夹。实测正确写法就是下面这一种。
 */
function buildRevealArgs(target) {
  return [`/select,${target}`];
}

/** 解析 ini 文本。
 * 容忍 BOM（记事本另存为 UTF-8 会加）、# 与 ; 注释、空行、行尾空格。
 * 不认识的行和键不会被丢掉，而是记进 problems 里带着行号报告出来。
 */
function parseSettings(text) {
  const values = new Map();
  const problems = [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) return;

    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      problems.push({ line: lineNo, message: `不是「键=值」的形式，已忽略：${short(trimmed)}` });
      return;
    }

    const rawKey = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(rawKey)) {
      problems.push({ line: lineNo, message: `键名不合法（只能用字母/数字/下划线），已忽略：${short(rawKey)}` });
      return;
    }

    const matched = KNOWN_KEYS.find((key) => key.toLowerCase() === rawKey.toLowerCase());
    if (!matched) {
      problems.push({
        line: lineNo,
        message: `未知的设置项「${rawKey}」，已忽略（可用：${KNOWN_KEYS.join('、')}）`,
      });
      return;
    }

    if (values.has(matched)) {
      problems.push({
        line: lineNo,
        message: `设置项「${matched}」重复出现了（第 ${lineNo} 行会覆盖前面的），请删掉多余的那行`,
      });
    }

    // 值里允许带引号，这里先不动，交给 normalizePath 处理
    values.set(matched, rawValue);
  });

  return { values, problems };
}

/**
 * 把用户写的路径归一化成可用的 Windows 路径。
 *
 * 认这些写法：D:\a\b、D:/a/b、D:\\a\\b、D://a//b、"D:\a\b"、%VAR%\x、相对路径
 * UNC（\\server\share）的双反斜杠前缀会被保留，不会被压成一个。
 *
 * @returns {?{input:string, text:string, resolved:string, relative:boolean, changed:boolean, expanded:boolean}}
 */
function normalizePath(raw) {
  let text = String(raw).trim();
  if (text === '') return null;

  const input = text;

  // 去掉两端成对的引号（从资源管理器"复制路径"粘出来常带引号）
  const quoted = /^(["'])([\s\S]*)\1$/.exec(text);
  if (quoted) text = quoted[2].trim();

  // 展开 %VAR%
  const expandedText = text.replace(/%([^%]+)%/g, (whole, name) => {
    const value = process.env[name] ?? process.env[name.toUpperCase()];
    return value === undefined ? whole : value;
  });
  const expanded = expandedText !== text;

  // 统一分隔符：任意个 / 或 \ 都压成单个 \，但 UNC 前缀要保住
  const isUnc = /^[\\/]{2}[^\\/]/.test(expandedText);
  const body = (isUnc ? expandedText.slice(2) : expandedText).replace(/[\\/]+/g, '\\');
  let result = (isUnc ? '\\\\' : '') + body;

  // 去掉末尾多余的分隔符（但保留 "D:\" 这样的根）
  if (result.length > 3) result = result.replace(/\\+$/, '');

  const relative = !path.isAbsolute(result);

  return {
    input,
    text: result,
    resolved: path.resolve(PROJECT_ROOT, result),
    relative,
    changed: result !== input,
    expanded,
  };
}

/** 读取磁盘上的设置，算出每个键的最终取值与可用性问题。 */
function resolveFromDisk() {
  let text = '';
  let exists = false;

  try {
    text = fs.readFileSync(SETTINGS_PATH, 'utf8');
    exists = true;
  } catch {
    text = '';
    exists = false;
  }

  const parsed = parseSettings(text);
  const notes = [];
  const invalid = [];
  const resolvedValues = {};

  for (const key of KNOWN_KEYS) {
    const raw = parsed.values.get(key);
    const fallback = DEFAULT_VALUES[key];

    // 没配置 / 留空 → 用内置默认（这是文档化的正常行为，不算错误）
    if (raw === undefined || raw.trim() === '') {
      resolvedValues[key] = { value: fallback, configured: false, usedDefault: true };
      continue;
    }

    const norm = normalizePath(raw);
    const keyNotes = [];

    if (norm.changed) keyNotes.push(`路径写法已归一化：「${norm.input}」→「${norm.text}」`);
    if (norm.expanded) keyNotes.push(`已展开环境变量：「${norm.input}」→「${norm.text}」`);
    if (norm.relative) {
      keyNotes.push(
        `${KEY_LABELS[key]}在设置文件里写的是相对路径「${norm.input}」，` +
          `按项目目录解析为「${norm.resolved}」（项目整体搬家也能用）`,
      );
    }

    let error = null;
    try {
      const stat = fs.statSync(norm.resolved);
      if (!stat.isDirectory()) error = '这个路径不是目录（可能是个文件）';
      else if (key === KEY_OUTPUT) fs.accessSync(norm.resolved, fs.constants.W_OK);
    } catch (err) {
      error = err.code === 'ENOENT'
        ? '这个目录不存在'
        : err.code === 'EACCES' || err.code === 'EPERM'
          ? '没有访问权限'
          : err.message;
    }

    if (error) {
      // 不静默改正：如实使用配置值，同时把它标成不可用，让界面明确提示
      invalid.push({
        key,
        label: KEY_LABELS[key],
        raw: norm.input,
        resolved: norm.resolved,
        error,
      });
    }

    resolvedValues[key] = {
      value: norm.resolved,
      configured: true,
      usedDefault: false,
      norm,
      keyNotes,
    };

    notes.push(...keyNotes);
  }

  return {
    exists,
    values: parsed.values,
    problems: parsed.problems,
    notes,
    invalid,
    resolvedValues,
  };
}

/** 生成设置文件内容：注释模板 + 当前各键的值。 */
function buildFileContent(values) {
  const body = KNOWN_KEYS.map((key) => {
    const value = values.get(key);
    return `${key}=${value === undefined ? '' : value}`;
  }).join('\n');

  const header = TEMPLATE.slice(0, TEMPLATE.lastIndexOf(`${KEY_INPUT}=`));
  return `${header}${body}\n`;
}

/** 原子写入（先写临时文件再改名），避免写一半被读到。 */
function writeFile(values) {
  const content = buildFileContent(values);
  const tempPath = `${SETTINGS_PATH}.tmp`;

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 带 BOM：记事本等编辑器能正确识别 UTF-8 中文注释；读取时会自动剥掉
  fs.writeFileSync(tempPath, `\uFEFF${content}`, 'utf8');
  fs.renameSync(tempPath, SETTINGS_PATH);
}

/** 从旧的 .ui-config.json 迁移一次（如果存在且有内容）。返回迁移的键数；没动手则返回 null。 */
function migrateLegacy(state) {
  if (state.exists) return null;

  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf8'));
  } catch {
    return null;
  }
  if (!legacy || typeof legacy !== 'object') return null;

  const migrated = new Map();
  let count = 0;
  for (const key of KNOWN_KEYS) {
    if (typeof legacy[key] === 'string' && legacy[key].trim() !== '') {
      migrated.set(key, legacy[key]);
      count++;
    }
  }

  try {
    writeFile(migrated);
    fs.rmSync(LEGACY_JSON_PATH, { force: true });
  } catch {
    return null;
  }

  return count;
}

function createDirConfig() {
  let state = resolveFromDisk();
  let loadedFingerprint = fingerprint(SETTINGS_PATH);

  const api = {
    settingsPath: SETTINGS_PATH,
    configDir: CONFIG_DIR,

    /** 启动时调用：文件不存在就生成一份，并尝试迁移旧配置。 */
    ensureFile() {
      // 注意顺序：迁移本身会写出文件，所以必须先迁移、再判断是否还需要生成空白模板，
      // 否则会把刚迁移过来的值又覆盖成空的。
      const migrated = migrateLegacy(state);
      if (migrated !== null) {
        api.reload();
        return { created: true, migrated };
      }

      if (!state.exists) {
        writeFile(state.values);
        api.reload();
        return { created: true, migrated: 0 };
      }

      return { created: false, migrated: 0 };
    },

    inputDir() {
      return state.resolvedValues[KEY_INPUT].value;
    },
    outputDir() {
      return state.resolvedValues[KEY_OUTPUT].value;
    },

    /** 磁盘上的文件是否已被改动（只做一次 stat，很便宜）。 */
    changedOnDisk() {
      return fingerprint(SETTINGS_PATH) !== loadedFingerprint;
    },

    /** 磁盘文件被改过（或删了）就重新读取。 */
    reloadIfChanged() {
      if (!api.changedOnDisk()) return false;
      return api.reload();
    },

    reload() {
      state = resolveFromDisk();
      loadedFingerprint = fingerprint(SETTINGS_PATH);
      return true;
    },

    describe() {
      const input = state.resolvedValues[KEY_INPUT];
      const output = state.resolvedValues[KEY_OUTPUT];
      return {
        inputDir: input.value,
        outputDir: output.value,
        defaultInputDir: DEFAULT_INPUT_DIR,
        defaultOutputDir: DEFAULT_OUTPUT_DIR,
        inputIsDefault: input.usedDefault,
        outputIsDefault: output.usedDefault,
        settingsPath: SETTINGS_PATH,
        settingsDir: CONFIG_DIR,
        settingsExists: state.exists,
        settingsMissing: !state.exists,
        settingsChanged: api.changedOnDisk(),
        problems: state.problems,
        notes: state.notes,
        invalid: state.invalid,
      };
    },

    /**
     * 界面里改目录：写进设置文件。
     * @returns {{changed:object, errors:string[], created:string[], missing:string[]}}
     */
    update({ inputDir, outputDir } = {}, options = {}) {
      const allowCreate = options.create === true;
      const changed = {};
      const created = [];
      const missing = [];
      const errors = [];

      for (const [key, raw] of [
        [KEY_INPUT, inputDir],
        [KEY_OUTPUT, outputDir],
      ]) {
        if (typeof raw !== 'string' || raw.trim() === '') continue;

        const norm = normalizePath(raw);
        if (!norm) continue;

        try {
          if (!fs.existsSync(norm.resolved)) {
            if (!allowCreate) {
              missing.push(norm.resolved);
              errors.push(`${KEY_LABELS[key]}不存在：${norm.resolved}（需要先创建，或确认创建）`);
              continue;
            }
            // 非递归：父目录必须已存在，避免手滑创建出一整条目录树
            fs.mkdirSync(norm.resolved);
            created.push(norm.resolved);
          }

          if (!fs.statSync(norm.resolved).isDirectory()) throw new Error('这个路径不是目录');
          if (key === KEY_OUTPUT) fs.accessSync(norm.resolved, fs.constants.W_OK);

          // 项目内的目录存相对路径（搬家也能用）；正好等于默认值就存空（= 默认）
          const stored =
            norm.resolved === DEFAULT_VALUES[key] ? '' : toStoredPath(norm.resolved);
          state.values.set(key, stored);
          changed[key] = norm.resolved;
        } catch (err) {
          errors.push(
            `${KEY_LABELS[key]}设置失败：你写的是「${norm.input}」，程序理解为「${norm.resolved}」，但${err.message}`,
          );
        }
      }

      if (Object.keys(changed).length > 0) {
        try {
          writeFile(state.values);
          api.reload();
        } catch (err) {
          errors.push(`写入设置文件失败：${err.message}`);
        }
      }

      return { changed, errors, created, missing };
    },

    /** 恢复默认：把对应键的值清空（留空即默认），保留文件里的注释。 */
    reset(which) {
      const changed = {};
      const keys = [];

      if (which === 'both' || which === KEY_INPUT) keys.push(KEY_INPUT);
      if (which === 'both' || which === KEY_OUTPUT) keys.push(KEY_OUTPUT);
      if (keys.length === 0) return { changed, errors: [], created: [], missing: [] };

      for (const key of keys) {
        state.values.set(key, '');
        changed[key] = DEFAULT_VALUES[key];
      }

      try {
        writeFile(state.values);
        api.reload();
      } catch (err) {
        return { changed: {}, errors: [`写入设置文件失败：${err.message}`], created: [], missing: [] };
      }

      return { changed, errors: [], created: [], missing: [] };
    },
  };

  return api;
}

module.exports = {
  createDirConfig,
  parseSettings,
  normalizePath,
  toStoredPath,
  buildRevealArgs,
  buildFileContent,
  SETTINGS_PATH,
  CONFIG_DIR,
  LEGACY_JSON_PATH,
  DEFAULT_INPUT_DIR,
  DEFAULT_OUTPUT_DIR,
  KNOWN_KEYS,
  TEMPLATE,
};
