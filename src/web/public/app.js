'use strict';

/* 酷狗 .kgg 转换工具的网页前端：原生 JS，无任何框架。 */

const $ = (id) => document.getElementById(id);
const selected = new Set();

let files = [];
let dirs = {};
let lastActiveTasks = 0;

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(route, body) {
  const options = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined;
  const res = await fetch(route, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}

function convertOptions() {
  return {
    mp3: $('opt-mp3').checked,
    bitrate: $('opt-bitrate').value,
    overwriteConverted: $('opt-overwrite').checked,
    deepCheck: $('opt-deep').checked,
  };
}

/* ---------------- 目录显示与修改 ---------------- */

function dirKeyOf(prefix) {
  return prefix === 'input' ? 'inputDir' : 'outputDir';
}

function dirValue(prefix) {
  return prefix === 'input' ? dirs.inputDir : dirs.outputDir;
}

function renderDirs() {
  $('input-dir').textContent = dirs.inputDir || '—';
  $('output-dir').textContent = dirs.outputDir || '—';
  $('input-dir-tag').textContent = dirs.inputIsDefault ? '默认' : '已修改';
  $('output-dir-tag').textContent = dirs.outputIsDefault ? '默认' : '已修改';
  $('input-dir-tag').className = `tag ${dirs.inputIsDefault ? 'default' : 'changed'}`;
  $('output-dir-tag').className = `tag ${dirs.outputIsDefault ? 'default' : 'changed'}`;

  // 设置文件本身的状态
  $('settings-path').textContent = dirs.settingsPath || '—';

  let tagText = '正常';
  let tagClass = 'default';
  if (dirs.settingsMissing) {
    tagText = '已被删除（在用默认路径）';
    tagClass = 'changed';
  } else if (dirs.settingsChanged) {
    tagText = '文件已被改动';
    tagClass = 'changed';
  } else if (dirs.invalid && dirs.invalid.length > 0) {
    tagText = '有设置项不可用';
    tagClass = 'changed';
  }
  $('settings-tag').textContent = tagText;
  $('settings-tag').className = `tag ${tagClass}`;

  const messages = [];
  for (const problem of dirs.problems || []) {
    messages.push(`设置文件第 ${problem.line} 行：${problem.message}`);
  }
  for (const item of dirs.invalid || []) {
    messages.push(
      `⚠ ${item.label}不可用：你写的是「${item.raw}」，程序理解为「${item.resolved}」，但${item.error}。` +
        '请检查拼写，或把这一行留空以使用默认路径。',
    );
  }
  for (const note of dirs.notes || []) {
    messages.push(`· ${note}`);
  }
  $('settings-hint').textContent = messages.join('\n');
}

function setHint(prefix, message) {
  $(`hint-${prefix}`).textContent = message || '';
}

function openDirEditor(prefix) {
  setHint(prefix, '');
  const box = $(`edit-${prefix}`);
  const input = $(`${prefix}-dir-input`);
  input.value = dirValue(prefix) || '';
  box.hidden = false;
  input.focus();
  input.select();
}

function closeDirEditor(prefix) {
  setHint(prefix, '');
  $(`edit-${prefix}`).hidden = true;
}

/**
 * 应用目录修改。
 *
 * 目录不存在时，先问用户要不要创建，确认后才带 create:true 重发。
 * 取消（无论是取消按钮、关闭选择框还是拒绝创建）都是**静默**的，不弹多余提示。
 */
async function applyDir(prefix) {
  const key = dirKeyOf(prefix);
  const input = $(`${prefix}-dir-input`);
  const value = input.value.trim();

  if (!value) {
    setHint(prefix, '请先粘贴或输入目录路径。');
    input.focus();
    return;
  }
  if (value === dirValue(prefix)) {
    closeDirEditor(prefix);
    return;
  }

  const label = prefix === 'input' ? '输入目录' : '输出目录';

  try {
    let result = await api('/api/dirs', { [key]: value });

    if (result.missing && result.missing.length > 0) {
      const ok = confirm(
        `${label}不存在：\n${result.missing.join('\n')}\n\n是否创建这个目录？\n（只会创建最后一级，父目录必须已经存在）`,
      );
      if (!ok) {
        setHint(prefix, '已取消，目录未改动。');
        return;
      }
      result = await api('/api/dirs', { [key]: value, create: true });
    }

    if (result.errors && result.errors.length > 0) {
      setHint(prefix, result.errors.join('；'));
      return;
    }

    closeDirEditor(prefix);
    await refresh();
  } catch (err) {
    setHint(prefix, `修改失败：${err.message}`);
  }
}

/**
 * 用原生选择框挑目录。
 * 用户取消是正常操作 → 什么都不做（不弹提示、不弹输入框）。
 * 只有选择框真的打不开时，才提示改用粘贴路径。
 */
async function browseDir(prefix) {
  try {
    const result = await api('/api/pick', { mode: 'folder' });

    if (!result.ok) {
      setHint(prefix, `打不开系统目录选择框：${result.error}。请直接把路径粘贴到上面的输入框。`);
      return;
    }
    if (result.cancelled || result.paths.length === 0) {
      // 用户点了取消 —— 静默保留编辑框，让他可以继续粘贴路径或点取消
      return;
    }

    $(`${prefix}-dir-input`).value = result.paths[0];
    await applyDir(prefix);
  } catch (err) {
    setHint(prefix, `打不开系统目录选择框：${err.message}。请直接把路径粘贴到上面的输入框。`);
  }
}

function wireDir(prefix) {
  $(`btn-edit-${prefix}`).addEventListener('click', () => openDirEditor(prefix));
  $(`btn-cancel-${prefix}`).addEventListener('click', () => closeDirEditor(prefix));
  $(`btn-ok-${prefix}`).addEventListener('click', () => applyDir(prefix));
  $(`btn-browse-${prefix}`).addEventListener('click', () => browseDir(prefix));
  $(`${prefix}-dir-input`).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applyDir(prefix);
    else if (event.key === 'Escape') closeDirEditor(prefix);
  });
  $(`btn-reset-${prefix}`).addEventListener('click', async () => {
    try {
      await api('/api/dirs', { reset: dirKeyOf(prefix) });
      closeDirEditor(prefix);
      await refresh();
    } catch (err) {
      setHint(prefix, err.message);
    }
  });
}

/* ---------------- 文件列表 ---------------- */

function describeExisting(file) {
  const parts = [];
  if (file.existing && file.existing.decrypted) parts.push(`.${file.existing.decrypted.ext}`);
  if (file.existing && file.existing.mp3) parts.push('.mp3');
  return parts.length ? `已有 ${parts.join(' + ')}` : '';
}

function renderFiles() {
  const list = $('file-list');
  list.textContent = '';

  const counts = { new: 0, partial: 0, done: 0 };
  files.forEach((file) => {
    counts[file.status] = (counts[file.status] || 0) + 1;
  });

  $('file-count').textContent = files.length
    ? `（共 ${files.length} 个：新文件 ${counts.new}，部分转换 ${counts.partial}，已转换 ${counts.done}）`
    : '';

  if (files.length === 0) {
    list.appendChild(
      el('li', 'empty', '当前输入目录里没有 .kgg 文件。可以点上面的"修改…"换目录，或用"选择单个文件…"挑文件。'),
    );
    return;
  }

  for (const file of files) {
    const item = el('li', 'file-row');
    const label = el('label');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = selected.has(file.path);
    box.addEventListener('change', () => {
      if (box.checked) selected.add(file.path);
      else selected.delete(file.path);
      updateConvertButton();
    });

    const name = el('span', 'name', file.name);

    const badge = el('span', `badge ${file.status}`, file.statusText || '');
    badge.title =
      file.status === 'done'
        ? '输出目录里已经有产物。勾选"覆盖已转换的"可以重新转换并覆盖。'
        : file.status === 'partial'
          ? '只有一部分产物（例如还缺 MP3），转换时会补齐。'
          : '输出目录里还没有这个文件的产物。';

    const meta = el('span', 'muted', formatBytes(file.size));
    const existing = el('span', 'muted existing', describeExisting(file));

    label.append(box, name, badge, meta, existing);
    item.appendChild(label);
    list.appendChild(item);
  }
}

/* ---------------- 任务列表 ---------------- */

function renderTasks(tasks) {
  const list = $('task-list');
  list.textContent = '';

  if (!tasks || tasks.length === 0) {
    list.appendChild(el('li', 'empty', '还没有任务。勾选文件后点"开始转换"。'));
    return;
  }

  for (const task of tasks) {
    const item = el('li', `task ${task.status}`);

    const head = el('div', 'row space-between');
    head.append(el('span', 'name', task.name), el('span', `badge ${task.status}`, task.stage));
    item.appendChild(head);

    if (task.status === 'running') {
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      fill.style.width = `${Math.max(2, Math.min(100, task.progress || 0))}%`;
      bar.appendChild(fill);
      item.appendChild(bar);
    }

    if (task.decrypted) {
      const parts = [`原始音频：${task.decrypted.format}`];
      if (task.decrypted.skipped) parts.push('（原始音频已存在，跳过解密）');
      for (const note of task.decrypted.notes || []) parts.push(note);
      item.appendChild(el('div', 'detail', parts.join(' · ')));
    }

    if (task.mp3) {
      item.appendChild(
        el(
          'div',
          'detail',
          `MP3：${formatDuration(task.mp3.duration)} · ${Math.round(task.mp3.bitRate / 1000)}kbps · ${formatBytes(task.mp3.size)}` +
            ` · 标签 ${JSON.stringify(task.mp3.tags)}`,
        ),
      );
    }

    for (const output of task.outputs || []) {
      item.appendChild(el('div', 'detail path', output));
    }

    if (task.message) {
      item.appendChild(el('div', task.status === 'failed' ? 'error' : 'detail', task.message));
    }

    list.appendChild(item);
  }
}

/* ---------------- 数据加载 ---------------- */

async function refresh() {
  const state = await api('/api/state');

  if (!state.dbPath) {
    $('key-info').textContent = '没有找到酷狗密钥库：请确认本机装过酷狗，且该歌曲已播放过一次。';
  } else {
    const loaded = state.keysLoadedAt
      ? new Date(state.keysLoadedAt).toLocaleTimeString('zh-CN', { hour12: false })
      : '—';
    let info = `密钥库：${state.keyCount} 条可用密钥 · 内存中这份加载于 ${loaded}`;
    if (state.keysError) info += ` · ⚠ 上次重新加载失败：${state.keysError}`;
    if (state.dbChanged) info += ' · ⚠ 磁盘上的密钥库已更新，转换时会自动重新加载';
    $('key-info').textContent = info;
  }

  dirs = state.dirs || {};
  renderDirs();

  files = state.files;
  renderFiles();
  renderTasks(state.tasks);
  updateConvertButton();
}

function updateConvertButton() {
  const count = selected.size;
  $('btn-convert').textContent = count > 0 ? `开始转换（已选 ${count} 个）` : '开始转换';
}

/* ---------------- 操作 ---------------- */

async function startConvert(paths) {
  const list = paths && paths.length ? paths : Array.from(selected);
  if (list.length === 0) {
    alert('先勾选要转换的文件，或用"选择单个文件…"挑一个。');
    return;
  }

  try {
    const result = await api('/api/convert', { paths: list, ...convertOptions() });

    const notes = [];
    if (result.skippedConverted && result.skippedConverted.length) {
      notes.push(
        `已跳过 ${result.skippedConverted.length} 个已转换过的文件（勾选"覆盖已转换的"可以重新转换）：\n` +
          result.skippedConverted.map((p) => `  ${p}`).join('\n'),
      );
    }
    if (result.rejected && result.rejected.length) {
      notes.push(
        `以下路径被拒绝：\n${result.rejected.map((r) => `  ${r.path}\n    ${r.reason}`).join('\n')}`,
      );
    }
    if (notes.length) alert(notes.join('\n\n'));

    renderTasks(result.tasks);
  } catch (err) {
    alert(err.message);
  }
}

/* ---------------- 事件绑定 ---------------- */

wireDir('input');
wireDir('output');

$('btn-scan').addEventListener('click', refresh);

$('btn-reload-keys').addEventListener('click', async () => {
  try {
    const result = await api('/api/reload-keys', {});
    if (result.reloaded) {
      alert(`已重新加载密钥库：${result.keyCount} 条可用密钥。`);
    } else {
      alert(`重新加载失败：${result.error || '未知原因'}`);
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('btn-open-config').addEventListener('click', async () => {
  try {
    const result = await api('/api/open-config', {});
    if (!result.ok) {
      alert(`打不开资源管理器：${result.error}\n文件位置：${dirs.settingsPath}`);
      return;
    }
    if (result.recreated) {
      alert('设置文件之前被删掉了，已重新生成一份并帮你定位到它。');
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('btn-reload-config').addEventListener('click', async () => {
  try {
    await api('/api/reload-config', {});
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('btn-pick').addEventListener('click', async () => {
  try {
    const result = await api('/api/pick', { mode: 'files' });

    if (!result.ok) {
      alert(`打不开系统文件选择框：${result.error}\n可以把 .kgg 放进输入目录，或者把路径粘贴到最下面的输入框。`);
      return;
    }
    if (result.cancelled || result.paths.length === 0) {
      return; // 用户取消，静默
    }

    const known = new Set(files.map((f) => f.path));
    for (const p of result.paths) {
      if (!known.has(p)) {
        // 临时加入列表；状态未知，按"新文件"显示，服务端会自行判断真正的状态
        files.push({
          path: p,
          name: p.replace(/^.*[\\/]/, ''),
          size: 0,
          status: 'new',
          statusText: '未检查',
          existing: {},
        });
      }
      selected.add(p);
    }
    renderFiles();
    updateConvertButton();
  } catch (err) {
    alert(err.message);
  }
});

$('btn-select-new').addEventListener('click', () => {
  selected.clear();
  files.filter((f) => f.status !== 'done').forEach((f) => selected.add(f.path));
  renderFiles();
  updateConvertButton();
});

$('btn-all').addEventListener('click', () => {
  files.forEach((f) => selected.add(f.path));
  renderFiles();
  updateConvertButton();
});

$('btn-none').addEventListener('click', () => {
  selected.clear();
  renderFiles();
  updateConvertButton();
});

$('btn-convert').addEventListener('click', () => startConvert());

$('btn-clear').addEventListener('click', async () => {
  await api('/api/clear', {});
});

$('manual-path').addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const value = event.target.value.trim();
  if (!value) return;
  event.target.value = '';
  await startConvert([value]);
});

/* ---------------- 实时进度 ---------------- */

const events = new EventSource('/api/events');

events.addEventListener('tasks', (event) => {
  const tasks = JSON.parse(event.data).tasks;
  renderTasks(tasks);

  // 任务从"有在跑"变成"全部结束"时，刷新文件列表，
  // 这样"已转换"标记会立刻跟着更新。
  const active = tasks.filter((t) => t.status === 'pending' || t.status === 'running').length;
  if (lastActiveTasks > 0 && active === 0) {
    refresh().catch(() => {});
  }
  lastActiveTasks = active;
});

events.onerror = () => {
  $('key-info').textContent = '与本地服务的连接已中断（服务窗口是不是被关掉了？）';
};

refresh().catch((err) => {
  $('key-info').textContent = `加载失败：${err.message}`;
});
