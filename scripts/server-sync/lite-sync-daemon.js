#!/usr/bin/env node
'use strict';
// Демон синхронизации: работает на ПК, держит выбранные проекты в согласии с сервером.
//
// Почему только на ПК: сервер за пределы к нему достучаться не может, поэтому
// инициатором всегда выступает домашняя машина. Сервер ничего не запускает —
// он лишь отвечает на вопросы «что у тебя лежит».
//
// Что делает:
//   - следит за папками проектов; после 5 секунд тишины отправляет изменения;
//   - раз в 20 секунд спрашивает у сервера короткую сводку и, если она изменилась,
//     забирает свежее;
//   - раз в 10 минут делает полную сверку на случай пропущенных событий;
//   - кладёт на сервер файл состояния, чтобы веб-версия могла показать,
//     когда ПК последний раз выходил на связь.
//
// Настройки: ~/.lite-sync/config.json, журнал: ~/.lite-sync/log.jsonl
// Запускают его либо редактор (пока открыт; так его включает мастер подключения),
// либо systemd --user (lite-sync.service — тогда он работает и без редактора).
// Второй экземпляр не стартует: занятость держит ~/.lite-sync/daemon.pid.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HERE = __dirname;
const STATE_DIR = process.env.LITE_SYNC_DIR || path.join(os.homedir(), '.lite-sync');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const LOG_FILE = path.join(STATE_DIR, 'log.jsonl');
const HISTORY_FILE = path.join(STATE_DIR, 'history.json');
const HISTORY_KEEP = 20;      // сколько обменов держим на проект
const HISTORY_SHOW = 5;       // сколько уезжает в отчёт для веба
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const SYNC_CLI = path.join(HERE, 'lite-sync.js');
const sync = require('./lite-sync.js');
const linker = require('./lite-sync-link.js');   // подключение проекта к синхронизации
const addon = sync.addon;                        // необязательное дополнение (см. lite-sync.js)

// lite-sync.js запускаем тем же двоичным файлом, что и нас: у демона, которого поднял
// редактор, это сам Electron в режиме node — отдельного node на машине может не быть.
function runNode(args) {
  return spawn(process.execPath, [SYNC_CLI, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
}

const DEFAULTS = {
  projects: [],           // [{ path, claude }]
  debounceMs: 5000,       // столько тишины в папке до отправки
  pollMs: 20000,          // как часто спрашивать сервер
  fullSweepMs: 600000,    // полная сверка на всякий случай
  heartbeatMs: 30000,     // как часто отмечаться на сервере, что ПК на связи
  enabled: true,
};

function readConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function log(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* журнал не должен ронять демон */ }
}

// ------------------------------------------------------------------- сервер

// Адрес читаем на каждый вызов: мастер подключения может записать его, пока демон уже работает.
function target() {
  return sync.resolveTarget();
}

const SSH_OPTS = [
  '-C', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(os.tmpdir(), 'lite-sync-%r@%h:%p')}`,
  '-o', 'ControlPersist=120s',
];

// Таймаут обязателен: ConnectTimeout спасает только от «не дозвонились», а
// повисшее уже установленное соединение (уснул ноутбук, сеть сменилась) держит
// synchronous-вызов бесконечно — и вместе с ним встаёт весь демон.
const SSH_TIMEOUT_MS = 60_000;

function sshQuiet(command, input = null, timeout = SSH_TIMEOUT_MS) {
  let host;
  try { host = target(); } catch { return null; }   // адреса нет — для демона это «сервер недоступен»
  const res = spawnSync('ssh', [...SSH_OPTS, host, command], {
    input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout,
  });
  return res.status === 0 ? res.stdout : null;   // null = сервер недоступен
}

// Короткая сводка каталога на сервере: если не изменилась — тянуть список незачем.
function remoteFingerprint(projectPath) {
  const cmd = `cd ${linker.shq(projectPath)} 2>/dev/null && find . -mindepth 1 -printf '%y\\t%P\\t%s\\t%T@\\0' | md5sum | cut -c1-32 || echo нет`;
  const out = sshQuiet(cmd);
  return out === null ? null : out.trim();
}

// Заявки, оставленные веб-версией. Забираем и сразу удаляем: заявка одноразовая,
// а очередь из десяти «синхронизируй» никому не нужна.
function takeRequests() {
  const out = sshQuiet(
    'mkdir -p ~/.lite-sync/requests && cd ~/.lite-sync/requests && '
    + 'for f in *.json; do [ -e "$f" ] || continue; cat "$f"; echo; rm -f "$f"; done',
  );
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// --------------------------------------------------------------- история обменов
//
// Веб-версия показывает по метке «sync» последние обмены проекта: когда, в какую
// сторону, сколько файлов и сколько это весило. Отчёт для сервера рассказывает
// только про ПОСЛЕДНИЙ результат, поэтому историю ведём здесь — там, где она
// и получается.
//
// Записываем только те прогоны, где файлы действительно ездили или остались
// спорные: демон проверяет каталоги часто, и без этого условия история была бы
// лентой нулей, в которой не найти настоящий обмен. Тем же условием отбирает
// события журнал.

function readHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};   // файла ещё нет или он испорчен — начинаем заново, это не отказ
  }
}

function rememberSync(projectPath, entry) {
  const moved = entry.pushed + entry.pulled + entry.deletedRemote + entry.deletedLocal;
  if (!moved && !entry.conflicts) return;

  const history = readHistory();

  // Незакрытый спор всплывает при КАЖДОЙ проверке, а проверок бывает несколько
  // в минуту. Без этого условия пять последних записей — это пять раз один и тот
  // же спор, вытеснивший настоящие обмены. Такой повтор не добавляем: в истории
  // остаётся первое обнаружение, а «когда проверяли в последний раз» окно и так
  // показывает отдельной строкой. Пример из жизни: `.claude/.std-trace.jsonl`
  // пишут обе стороны, поэтому он спорный всегда.
  const previous = (history[projectPath] || [])[0];
  const previousMoved = previous
    ? previous.pushed + previous.pulled + previous.deletedRemote + previous.deletedLocal
    : 0;
  if (!moved && previous && !previousMoved && previous.conflicts === entry.conflicts) return;
  history[projectPath] = [entry, ...(history[projectPath] || [])].slice(0, HISTORY_KEEP);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Номер процесса в имени временного файла: рядом с демоном этот каталог
    // пишут и ручные запуски, а общее имя `.tmp` — это гонка, а не атомарность.
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 1));
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (e) {
    log({ event: 'история обменов не записалась', detail: e.message });
  }
}

// ------------------------------------------------------------------ синхронизация

const state = new Map();   // путь -> { busy, again, timer, lastFingerprint, lastSync }

function ensure(projectPath) {
  if (!state.has(projectPath)) {
    state.set(projectPath, { busy: false, again: false, timer: null, lastFingerprint: null, lastSync: 0, lastResult: null });
  }
  return state.get(projectPath);
}

function runSync(projectPath, reason, opts = [], command = 'auto') {
  const st = ensure(projectPath);
  if (st.busy) { st.again = true; return; }      // придём ещё раз, когда освободимся
  st.busy = true;

  const child = runNode([command, projectPath, '--go', ...opts]);
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });

  child.on('close', (code) => {
    st.busy = false;
    st.lastSync = Date.now();

    // Итог берём из машинной сводки, которую печатает lite-sync.js последней
    // строкой: там же и вес перенесённого. Разбор человеческих строк оставлен
    // запасным путём — на случай, если демон окажется новее самого CLI.
    const summary = /### сводка (\{.*\})/.exec(out);
    const numbers = /отправлено (\d+), получено (\d+), удалено там (\d+), здесь (\d+)/.exec(out);
    const conflicts = /спорных осталось: (\d+)/.exec(out);
    let result = {
      ok: code === 0,
      pushed: numbers ? Number(numbers[1]) : 0,
      pulled: numbers ? Number(numbers[2]) : 0,
      deletedRemote: numbers ? Number(numbers[3]) : 0,
      deletedLocal: numbers ? Number(numbers[4]) : 0,
      conflicts: conflicts ? Number(conflicts[1]) : 0,
      pushedBytes: 0,
      pulledBytes: 0,
    };
    if (summary) {
      try {
        // Код выхода главнее сводки: она печатается до того, как процесс
        // закончится, и «ok» в ней — это «дошли до конца», а не «вышли нулём».
        result = { ...result, ...JSON.parse(summary[1]), ok: code === 0 };
      } catch { /* сводка не разобралась — остаёмся при числах из строк выше */ }
    }
    st.lastResult = result;
    rememberSync(projectPath, { at: new Date().toISOString(), reason, ...result });

    const moved = result.pushed + result.pulled + result.deletedRemote + result.deletedLocal;
    if (!result.ok) {
      log({ event: 'ошибка', project: projectPath, reason, detail: out.trim().split('\n').slice(-2).join(' ') });
    } else if (moved || result.conflicts) {
      log({ event: 'синхронизация', project: projectPath, reason, ...result });
    }

    st.lastFingerprint = null;   // после обмена сводка заведомо другая
    reportStatus();

    // дополнение (если есть) возит вслед за проектом свои данные — например, память агента
    if (addon && addon.afterSync) {
      const project = readConfig().projects.find((p) => p.path === projectPath);
      try { addon.afterSync(projectPath, { project, st, SYNC_CLI, log, runNode }); } catch (e) { log({ event: 'ошибка дополнения', detail: e.message }); }
    }

    if (st.again) { st.again = false; setTimeout(() => runSync(projectPath, 'догоняю'), 500); }
  });
}

// ------------------------------------------------- подключение проекта из веба
//
// Веб не может дотянуться до ПК, поэтому кнопка «подключить» там кладёт заявку,
// а работу делаем мы. Ход работы возвращаем тем же способом, каким веб узнаёт всё
// остальное, — файлом на сервере: он его опрашивает и рисует чеклист.

let linkBusy = false;

function publishLink(state) {
  sshQuiet('mkdir -p ~/.lite-sync && cat > ~/.lite-sync/link-status.json', JSON.stringify(state, null, 1));
}

function startLink(req) {
  // Заявка пришла с сервера, то есть снаружи. Путь из неё разойдётся по ssh-командам
  // и попадёт в конфиг, поэтому проверяем той же меркой, что и сама процедура.
  let project;
  try { project = linker.safePath(req.project); } catch (e) {
    log({ event: 'заявка на подключение отклонена', project: String(req.project || '').slice(0, 120), reason: e.message });
    publishLink({ project: '', done: true, ok: false, reason: `негодный путь: ${e.message}`, steps: [] });
    return;
  }
  if (linkBusy) {
    // Две заявки разом — вторую отклоняем внятно: процедура правит конфиг и
    // переносит файлы, параллельно этого делать нельзя.
    publishLink({ project, done: true, ok: false, reason: 'подключение уже идёт, дождитесь конца', steps: [] });
    return;
  }
  linkBusy = true;

  const state = {
    project,
    id: String(req.id || ''),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    done: false, ok: null, need: null, reason: null, steps: [],
  };
  const push = () => { state.updatedAt = new Date().toISOString(); publishLink(state); };
  push();

  log({ event: 'заявка на подключение', project, prefer: req.prefer || null });

  linker.link(project, {
    prefer: req.prefer === 'local' || req.prefer === 'remote' ? req.prefer : null,
    onStep: (s) => {
      const at = state.steps.findIndex((x) => x.key === s.key);
      if (at >= 0) state.steps[at] = s; else state.steps.push(s);
      if (s.need) { state.need = s.need; state.differ = s.differ; state.examples = s.examples || []; }
      push();
    },
  }).then((res) => {
    state.done = true;
    state.ok = Boolean(res.ok);
    state.need = res.need || null;
    state.reason = res.reason || null;
    if (res.report) state.report = { local: res.report.local, remote: res.report.remote, direction: res.report.direction, differ: res.report.differ };
    push();
    log({ event: 'подключение завершено', project, ok: state.ok, need: state.need, reason: state.reason });

    // Слежение и первую сверку новичку доставит главный цикл — он сверяет
    // конфиг со списком отслеживаемых. Здесь только обновляем отчёт, чтобы
    // веб сразу увидел проект в списке синхронизируемых.
    if (state.ok && !state.need) reportStatus();
  }).catch((e) => {
    state.done = true; state.ok = false; state.reason = String(e && e.message ? e.message : e);
    push();
    log({ event: 'подключение сорвалось', project, reason: state.reason });
  }).finally(() => { linkBusy = false; });
}

// Кладём на сервер короткий отчёт: веб-версия по нему покажет, на связи ли ПК.
//
// Отчёт — это ещё и пульс. Раньше он отправлялся только после обмена файлами,
// и в спокойный час (никто ничего не правит) метка старела: веб честно объявлял
// «ПК не на связи», хотя компьютер работал и демон был жив. Поэтому теперь тот же
// отчёт уходит и по таймеру, независимо от того, было ли что синхронизировать.
function reportStatus() {
  const config = readConfig();
  const history = readHistory();
  const payload = {
    updatedAt: new Date().toISOString(),
    host: os.hostname(),
    projects: config.projects.map((p) => {
      const st = state.get(p.path);
      return {
        path: p.path,
        lastSync: st?.lastSync ? new Date(st.lastSync).toISOString() : null,
        last: st?.lastResult || null,
        // Последние обмены — их показывает веб по метке «sync». Пять штук:
        // отчёт уезжает на сервер целиком при каждом опросе, и раздувать его
        // всей историей незачем.
        history: (history[p.path] || []).slice(0, HISTORY_SHOW),
      };
    }),
  };
  sshQuiet('mkdir -p ~/.lite-sync && cat > ~/.lite-sync/pc-status.json', JSON.stringify(payload, null, 1));
}

// ------------------------------------------------------------------ слежение

// Слежение опросом, а не через inotify.
//
// Рекурсивный watch на 8,5 тысяч каталогов упирается в системный лимит наблюдателей
// (ENOSPC) — тем более что десктопный редактор тоже следит за файлами. Поднимать
// лимит через sudo ради этого не нужно: полный обход дерева занимает 0,11 с,
// поэтому опрос раз в несколько секунд дешевле и надёжнее.
function localFingerprint(projectPath) {
  const res = spawnSync('bash', ['-c',
    `cd ${linker.shq(projectPath)} && find . -mindepth 1 -printf '%y\\t%P\\t%s\\t%T@\\0' | md5sum | cut -c1-32`,
  ], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function watchProject(projectPath) {
  const st = ensure(projectPath);
  if (st.watching) return;      // проект могли подключить и отследить раньше
  st.watching = true;
  st.localFingerprint = localFingerprint(projectPath);
  st.quietSince = Date.now();

  const tick = () => {
    const config = readConfig();
    const now = localFingerprint(projectPath);
    if (now === null) return;

    if (now !== st.localFingerprint) {
      st.localFingerprint = now;
      st.quietSince = Date.now();      // в папке шевеление — отсчёт тишины заново
      st.dirty = true;
      return;
    }
    // ждём тишины: иначе уедет полуфабрикат посреди сборки или git-операции
    if (st.dirty && Date.now() - st.quietSince >= config.debounceMs && !st.busy) {
      st.dirty = false;
      runSync(projectPath, 'правки здесь');
    }
  };

  setInterval(tick, 2000);
  log({ event: 'слежу опросом', project: projectPath, каталог: projectPath });
}

// ---------------------------------------------------------------------- цикл

// Один демон на машину. Файл с номером процесса, а не блокировка: её нет в node без
// сторонних модулей. Номер сверяем с живыми процессами, иначе после падения файл
// навсегда запер бы запуск; на Linux ещё и по командной строке — номер могли переиспользовать.
function otherDaemonAlive() {
  let pid;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { return false; }
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('lite-sync-daemon'); } catch { return true; }
}

function claimPidFile() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
  process.on('exit', () => {
    try { if (Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PID_FILE); } catch { /* уже нет */ }
  });
}

function main() {
  const config = readConfig();
  if (!config.enabled) { console.log('синхронизация выключена в настройках'); process.exit(0); }
  if (otherDaemonAlive()) { console.log(`демон уже работает (${PID_FILE})`); process.exit(0); }
  claimPidFile();

  let server = '';
  try { server = target(); } catch (e) { log({ event: 'адрес сервера не задан', detail: e.message }); }
  // Пустой список — не повод выходить: мастер подключения запускает демон до того, как
  // подключит первый проект, а новичков из конфига главный цикл подхватывает сам.
  log({ event: 'старт', projects: config.projects.map((p) => p.path), сервер: server, дополнение: addon ? addon.name || 'есть' : null });

  for (const project of config.projects) {
    watchProject(project.path);
    runSync(project.path, 'старт');   // догоняем всё, что накопилось, пока ПК был выключен
  }

  // опрос сервера: сводка изменилась — значит там работали
  setInterval(() => {
    if (addon && addon.onPoll) {
      try { addon.onPoll({ sshQuiet, target, log, SSH_OPTS, STATE_DIR }); } catch (e) { log({ event: 'ошибка дополнения', detail: e.message }); }
    }

    // сначала заявки из веб-версии: она не может дотянуться до ПК сама,
    // поэтому оставляет просьбу файлом, а мы её забираем и исполняем
    for (const req of takeRequests()) {
      // Заявка на ПОДКЛЮЧЕНИЕ приходит как раз для проекта, которого в конфиге ещё
      // нет, — её нельзя мерить той же меркой, что заявку на сверку.
      if (req.command === 'link') { startLink(req); continue; }

      const known = readConfig().projects.some((p) => p.path === req.project);
      if (!known) { log({ event: 'заявка на чужой проект отклонена', project: req.project }); continue; }
      log({ event: 'заявка из веба', project: req.project, command: req.command });
      runSync(req.project, 'заявка из веба', [], req.command === 'auto' ? 'auto' : req.command);
    }

    // Проект мог появиться в конфиге только что: его подключили из веба, из
    // десктопного редактора или руками. Слежение за папкой ставится один раз при
    // старте, поэтому новичкам доставляем его здесь — иначе правки на ПК будут
    // уезжать только по плановой сверке, раз в десять минут.
    for (const project of readConfig().projects) {
      if (!ensure(project.path).watching) {
        log({ event: 'новый проект в синхронизации', project: project.path });
        watchProject(project.path);
        runSync(project.path, 'первая сверка после подключения');
      }
    }

    for (const project of readConfig().projects) {
      const st = ensure(project.path);
      if (st.busy) continue;
      const fingerprint = remoteFingerprint(project.path);
      if (fingerprint === null) return;                     // сервер недоступен — молчим
      if (st.lastFingerprint && fingerprint !== st.lastFingerprint) {
        runSync(project.path, 'правки на сервере');
      }
      st.lastFingerprint = fingerprint;
    }
  }, config.pollMs);

  // полная сверка — страховка от пропущенных событий
  setInterval(() => {
    for (const project of readConfig().projects) runSync(project.path, 'плановая сверка');
  }, config.fullSweepMs);

  // Пульс: пока ПК включён и демон жив, веб-версия должна это видеть — даже
  // когда файлы не меняются часами. Веб считает ПК офлайн после трёх минут
  // тишины, поэтому бьём чаще, с запасом на пропущенный удар.
  reportStatus();
  setInterval(reportStatus, config.heartbeatMs || 30_000);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { log({ event: 'остановка', signal }); process.exit(0); });
  }
}

if (require.main === module) main();

// Части, которые проверке нужно спрашивать поодиночке (`check-history.js`).
// Сам демон при `require` не запускается: цикл живёт в main(), а она зовётся
// только при прямом запуске.
module.exports = { readHistory, rememberSync, HISTORY_KEEP, HISTORY_SHOW };
