'use strict';
// Подключение проекта к синхронизации: одна процедура на обе версии редактора.
//
// Зачем отдельный модуль. Веб-версия дотянуться до ПК не может (сервер к домашней
// машине не ходит), поэтому она кладёт заявку, а исполняет её демон здесь, на ПК.
// Десктопный редактор запускает ту же процедуру напрямую — демон у него под рукой.
// Логика при этом должна быть ОДНА: иначе два пути подключения разойдутся в
// поведении, и «подключено из веба» станет означать не то же, что «подключено с ПК».
//
// Процедура из четырёх шагов, каждый отчитывается наружу через onStep:
//   связь      — сервер отвечает, часы сходятся;
//   проект     — есть ли каталог с той стороны; нет — создаётся; есть и файлы
//                различаются — процедура ОСТАНАВЛИВАЕТСЯ и спрашивает, чью версию брать;
//   перенос    — первая передача штатным lite-sync (с корзиной, как обычная сверка);
//   подключён  — проект дописывается в конфиг демона.
//
// Ничего не удаляется молча: перенос идёт тем же lite-sync, что и обычная сверка,
// а он складывает заменённое в корзину.
//
// Здесь же — первая настройка для мастера в редакторе: checkServer (пускает ли сервер
// по ключу, есть ли на нём нужное, сходятся ли часы) и setServer (адрес в конфиг).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const sync = require('./lite-sync.js');

const HERE = __dirname;
const SYNC_CLI = path.join(HERE, 'lite-sync.js');
const STATE_DIR = process.env.LITE_SYNC_DIR || path.join(os.homedir(), '.lite-sync');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

const SSH_OPTS = [
  '-C', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(os.tmpdir(), 'lite-sync-%r@%h:%p')}`,
  '-o', 'ControlPersist=120s',
];

// Экранирование пути для удалённой оболочки — то же, что у самой утилиты (см. shq в lite-sync.js):
// путь в двойных кавычках оболочка всё равно развернула бы через $(...).
const { shq } = sync;

// Путь приходит из заявки веб-версии, то есть снаружи. Дальше он идёт и в
// аргументы процессов, и в ssh, и в конфиг демона — значит проверяем строго.
function safePath(projectPath) {
  const value = String(projectPath || '');
  if (!value.startsWith('/')) throw new Error('нужен абсолютный путь проекта');
  if (/[\0\n\r]/.test(value)) throw new Error('в пути недопустимые символы');
  if (path.normalize(value) !== value || value.includes('/../')) throw new Error('путь должен быть нормализованным');
  return value;
}

function sshRun(target, command, timeout = 60_000) {
  const res = spawnSync('ssh', [...SSH_OPTS, target, command], { encoding: 'utf8', timeout });
  return { ok: res.status === 0, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return { projects: [] }; }
}

function writeConfig(cfg) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // через .tmp + rename: конфиг читает работающий демон, обрывок ему смертелен
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// Задан ли адрес сервера — без него подключать проекты некуда.
function configured() {
  return Boolean(process.env.LITE_SERVER || readConfig().server);
}

// ------------------------------------------------------- первая настройка

// ssh и rsync на этой машине: без них синхронизации нет, и сказать об этом надо до
// того, как человек начнёт вводить адрес сервера.
function localTools() {
  const has = (cmd, args) => !spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }).error;
  return { ssh: has('ssh', ['-V']), rsync: has('rsync', ['--version']) };
}

// Отказ ssh — в код причины: текст для человека подбирает редактор на его языке.
function sshReason(err) {
  if (/Permission denied/i.test(err)) return 'auth';
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(err)) return 'resolve';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(err)) return 'hostkey';
  if (/Connection refused|timed out|No route to host|Network is unreachable/i.test(err)) return 'unreachable';
  return 'ssh';
}

// Проверка сервера для мастера. Ничего не меняет ни здесь, ни там — кроме known_hosts:
// ключ НОВОГО сервера принимается сам (accept-new, как «yes» на вопрос ssh), а
// сменившийся ключ по-прежнему останавливает соединение.
function checkServer(server) {
  const res = {
    ok: false, server: String(server || '').trim(), reason: null, detail: '',
    tools: localTools(), drift: 0, home: '', missing: [],
  };
  if (!res.tools.ssh || !res.tools.rsync) { res.reason = 'local-tools'; return res; }
  if (!sync.validServer(res.server)) { res.reason = 'address'; return res; }
  const probe = 'date +%s; echo "$HOME"; for c in rsync find md5sum du; do command -v "$c" >/dev/null 2>&1 || echo "missing:$c"; done';
  const r = spawnSync('ssh', [...SSH_OPTS, '-o', 'StrictHostKeyChecking=accept-new', res.server, probe], { encoding: 'utf8', timeout: 40_000 });
  if (r.status !== 0) {
    const err = (r.stderr || '').trim() || (r.error ? r.error.message : '');
    res.reason = r.error && /ETIMEDOUT/.test(r.error.message) ? 'unreachable' : sshReason(err);
    res.detail = err.split('\n').filter(Boolean).pop() || '';
    return res;
  }
  const lines = (r.stdout || '').trim().split('\n');
  const remoteNow = Number(lines[0]);
  res.home = lines[1] || '';
  res.missing = lines.slice(2).filter((l) => l.startsWith('missing:')).map((l) => l.slice(8));
  if (res.missing.length) { res.reason = 'remote-tools'; return res; }
  res.drift = remoteNow ? Math.abs(Math.floor(Date.now() / 1000) - remoteNow) : 0;
  if (res.drift > sync.CLOCK_TOLERANCE_S) { res.reason = 'clock'; return res; }
  res.ok = true;
  return res;
}

// Адрес сервера — в конфиг демона. runner: 'editor' означает «демон запускает редактор,
// пока открыт»; у того, кто держит демон в systemd, поля нет, и редактор его не трогает.
function setServer(server, { runner = 'editor' } = {}) {
  const value = String(server || '').trim();
  if (!sync.validServer(value)) throw new Error('негодный адрес сервера');
  const cfg = readConfig();
  cfg.server = value;
  cfg.projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  if (runner && !cfg.runner) cfg.runner = runner;
  writeConfig(cfg);
  return cfg;
}

function isLinked(projectPath) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const mine = real(projectPath);
  return (readConfig().projects || []).some((p) => real(typeof p === 'string' ? p : p && p.path) === mine);
}

// Размер каталога человеку в модалку: он решает, ждать ли первую заливку.
// du считает быстро, но на огромном дереве не мгновенно — потому и таймаут.
function measureLocal(dir) {
  // без оболочки и через `--`: путь остаётся одним аргументом, чем бы он ни был
  const res = spawnSync('du', ['-sb', '--exclude=.git/objects/pack', '--', dir], { encoding: 'utf8', timeout: 30_000 });
  const bytes = Number((res.stdout || '').split('\t')[0]) || 0;
  const count = spawnSync('find', [dir, '-type', 'f'], { encoding: 'utf8', timeout: 30_000 });
  return { exists: true, bytes, files: (count.stdout || '').split('\n').filter(Boolean).length };
}

function measureRemote(target, dir) {
  const q = shq(dir);
  const r = sshRun(target, `if [ -d ${q} ]; then du -sb ${q} | cut -f1; find ${q} -type f | wc -l; else echo ABSENT; fi`, 60_000);
  if (!r.ok) return null;
  if (r.out.startsWith('ABSENT')) return { exists: false, bytes: 0, files: 0 };
  const [bytes, files] = r.out.split('\n');
  return { exists: true, bytes: Number(bytes) || 0, files: Number(files) || 0 };
}

/**
 * @typedef {{exists: boolean, bytes: number, files: number}} Side
 * @typedef {{project: string, linked: boolean, ok: boolean, reason: string|null,
 *            target: string, online: boolean, drift: number, local: Side, remote: Side,
 *            direction: 'push'|'pull'|'both'|null, differ: number, differExamples: string[],
 *            onlyLocal: number, onlyRemote: number}} Report
 */

const EMPTY_SIDE = () => ({ exists: false, bytes: 0, files: 0 });

/** @returns {Report} */
function blankReport(projectPath) {
  return {
    project: String(projectPath || ''), linked: false, ok: false, reason: null,
    target: '', online: false, drift: 0, local: EMPTY_SIDE(), remote: EMPTY_SIDE(),
    direction: null, differ: 0, differExamples: [], onlyLocal: 0, onlyRemote: 0,
  };
}

// Что произойдёт при подключении — считается ДО того, как человек согласился.
// Отсюда берутся и размер для модалки, и предупреждение о расхождении.
// Форма ответа всегда одна: так вызывающему не приходится гадать, какие поля
// на месте, а какие пропали вместе с неудачной веткой.
/** @returns {Report} */
function inspect(projectPath) {
  const report = blankReport(projectPath);
  try { projectPath = safePath(projectPath); } catch (e) { report.reason = e.message; return report; }
  report.project = projectPath;
  report.linked = isLinked(projectPath);

  let target;
  try { target = sync.resolveTarget(); } catch (e) { report.reason = `не найден адрес сервера: ${e.message}`; return report; }
  report.target = target;

  const alive = sshRun(target, 'date +%s', 20_000);
  if (!alive.ok) { report.reason = `сервер не отвечает: ${alive.err || 'нет соединения'}`; return report; }
  report.online = true;
  report.drift = Math.abs(Math.floor(Date.now() / 1000) - Number(alive.out));

  report.local = fs.existsSync(projectPath) ? measureLocal(projectPath) : EMPTY_SIDE();
  report.remote = measureRemote(target, projectPath) || EMPTY_SIDE();

  if (!report.local.exists && !report.remote.exists) {
    report.reason = 'каталога нет ни на ПК, ни на сервере';
    return report;
  }

  if (report.local.exists && report.remote.exists) {
    report.direction = 'both';
    // Считаем расхождение тем же кодом, что и обычная сверка, — чтобы «различается»
    // в модалке означало ровно то же, что потом покажет синхронизация.
    try {
      const local = sync.listLocal(projectPath);
      const remote = sync.listRemote(target, projectPath);
      const differ = [...local.keys()].filter((k) => remote.has(k) && !sync.same(local.get(k), remote.get(k)));
      report.differ = differ.length;
      report.differExamples = differ.slice(0, 8);
      report.onlyLocal = [...local.keys()].filter((k) => !remote.has(k)).length;
      report.onlyRemote = [...remote.keys()].filter((k) => !local.has(k)).length;
    } catch (e) {
      report.reason = `не удалось сверить содержимое: ${e.message}`;
      return report;
    }
  } else {
    report.direction = report.local.exists ? 'push' : 'pull';
  }

  report.ok = true;
  return report;
}

function runCli(args, onLine) {
  return new Promise((resolve) => {
    // тот же двоичный файл, что и у нас: в редакторе это Electron в режиме node —
    // отдельного node у пользователя может и не быть
    const child = spawn(process.execPath, [SYNC_CLI, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let out = '';
    const take = (d) => { out += d; if (onLine) onLine(String(d)); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('close', (code) => resolve({ ok: code === 0, out }));
    child.on('error', (e) => resolve({ ok: false, out: `${out}\n${e.message}` }));
  });
}

function addToConfig(projectPath) {
  const cfg = readConfig();
  cfg.projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  if (!cfg.projects.some((p) => (typeof p === 'string' ? p : p && p.path) === projectPath)) {
    // поля по умолчанию может добавить дополнение (например, возить память агента)
    cfg.projects.push({ path: projectPath, ...((sync.addon && sync.addon.projectDefaults) || {}) });
  }
  writeConfig(cfg);
}

// Сама процедура. prefer — чью сторону брать, если файлы различаются
// ('local' | 'remote'); без него процедура на этом месте останавливается
// и возвращает need: 'prefer', чтобы спросить человека.
/**
 * @param {string} projectPath
 * @param {{prefer?: 'local'|'remote'|null, onStep?: (step: {key: string, state: string, text: string, need?: string, differ?: number, examples?: string[]}) => void}} [options]
 */
async function link(projectPath, { prefer = null, onStep = () => {} } = {}) {
  const step = (key, state, text, extra = {}) => { onStep({ key, state, text, ...extra }); };

  try { projectPath = safePath(projectPath); } catch (e) {
    step('link', 'bad', e.message);
    return { ok: false, reason: e.message };
  }

  step('link', 'run', 'проверяю связь с сервером');
  const report = inspect(projectPath);
  if (!report.ok) {
    step('link', 'bad', report.reason);
    return { ok: false, reason: report.reason, report };
  }
  if (report.drift > sync.CLOCK_TOLERANCE_S) {
    // Тот же порог, что и у обычной сверки: пока часы врозь, «кто свежее» бессмысленно.
    const reason = `часы разошлись на ${report.drift} с — сначала поправьте время`;
    step('link', 'bad', reason);
    return { ok: false, reason, report };
  }
  step('link', 'ok', `сервер отвечает, часы сходятся (${report.drift} с)`);

  if (report.linked) {
    step('project', 'ok', 'проект уже подключён');
    step('transfer', 'ok', 'переносить нечего');
    step('done', 'ok', 'уже в синхронизации');
    return { ok: true, already: true, report };
  }

  step('project', 'run', 'смотрю, есть ли проект на той стороне');
  if (report.direction === 'push' && !report.remote.exists) {
    const made = sshRun(report.target, `mkdir -p -- ${shq(projectPath)}`, 30_000);
    if (!made.ok) {
      const reason = `не удалось создать папку на сервере: ${made.err || 'отказано'}`;
      step('project', 'bad', reason);
      return { ok: false, reason, report };
    }
    step('project', 'ok', 'на сервере папки не было — создал');
  } else if (report.direction === 'pull' && !report.local.exists) {
    try { fs.mkdirSync(projectPath, { recursive: true }); } catch (e) {
      const reason = `не удалось создать папку на ПК: ${e.message}`;
      step('project', 'bad', reason);
      return { ok: false, reason, report };
    }
    step('project', 'ok', 'на ПК папки не было — создал');
  } else if (report.differ > 0 && !prefer) {
    // Останавливаемся и спрашиваем: молча затирать чужую работу нельзя.
    step('project', 'ask', `файлы различаются: ${report.differ}`, {
      need: 'prefer', differ: report.differ, examples: report.differExamples,
    });
    return { ok: false, need: 'prefer', report };
  } else {
    // фразы целиком, а не со вставкой «ПК»/«сервера»: так их переводит окно облачка
    step('project', 'ok', !report.differ ? 'есть с обеих сторон, содержимое совпадает'
      : prefer === 'local' ? `есть с обеих сторон, различий ${report.differ} — берём версию ПК`
        : `есть с обеих сторон, различий ${report.differ} — берём версию сервера`);
  }

  step('transfer', 'run', 'первая передача файлов');
  const args = ['auto', projectPath, '--go', '--merge-memory'];   // --merge-memory без дополнения ничего не делает
  if (prefer) args.push('--prefer', prefer);
  const run = await runCli(args);
  if (!run.ok) {
    const tail = run.out.trim().split('\n').slice(-2).join(' ');
    const reason = `перенос не удался: ${tail || 'без объяснения'}`;
    step('transfer', 'bad', reason);
    return { ok: false, reason, report, log: run.out };
  }
  const moved = /отправлено (\d+), получено (\d+)/.exec(run.out);
  step('transfer', 'ok', moved ? `отправлено ${moved[1]}, получено ${moved[2]}` : 'файлы перенесены');

  step('done', 'run', 'записываю в настройки синхронизации');
  try { addToConfig(projectPath); } catch (e) {
    const reason = `не удалось записать настройки: ${e.message}`;
    step('done', 'bad', reason);
    return { ok: false, reason, report, log: run.out };
  }
  step('done', 'ok', 'проект синхронизируется');
  return { ok: true, report, log: run.out };
}

module.exports = { inspect, link, isLinked, addToConfig, readConfig, configured, localTools, checkServer, setServer, safePath, shq, CONFIG_FILE, STATE_DIR };
