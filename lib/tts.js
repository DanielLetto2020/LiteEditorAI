// LiteEditorAI — движок озвучки для модуля «Озвучка».
//
// Держит python-сайдкар `tts/tts_server.py` (Silero ru: в ONNX русского нет, только PyTorch —
// внутрь Electron такой движок не встроить, см. docs/TTS_VOICE.md) и кэш синтезированных фраз.
// Процесс поднимается по требованию и гасится по таймауту простоя: torch держит сотни мегабайт,
// висеть всегда ему незачем.
//
// Движок НЕ входит в поставку редактора (модель ~145 МБ + torch ≈ 700 МБ на диск, лицензия моделей
// CC BY-NC-SA). Интерпретатор ищем так: явная настройка → свой каталог `~/.LiteEditorAI/tts/venv` →
// `LITE_TTS_PYTHON` → `python3` из PATH → интерпретаторы pyenv → системный `/usr/bin/python3`;
// подходит только тот, у которого реально импортируется torch. Модель: настройка → свежая из
// известных в `~/.LiteEditorAI/tts/` → `LITE_TTS_MODEL`, качается по кнопке (downloadModel).
//
// ⚠️ PATH запущенного из меню приложения НЕ содержит того, что профиль оболочки добавляет от
// pyenv/conda: там `python3` — системный, без torch. Поэтому абсолютные пути в списке кандидатов
// обязательны (та же грабля, что с nvm и node).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { normalizeForSpeech, hasSpeakable } = require('./ttsnorm');   // числа словами, латиница, защита от ValueError

// Сайдкар запускает ВНЕШНИЙ процесс (python), а он не умеет читать из архива `app.asar` — файл
// в упакованной сборке надо брать из распакованной копии (`asarUnpack` в package.json её кладёт).
// В обычном запуске из репозитория `app.asar` в пути нет и замена ничего не меняет.
const SCRIPT = path.join(__dirname, '..', 'tts', 'tts_server.py').replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
// Адрес модели можно переопределить (зеркало в закрытом контуре, локальная копия, тест загрузчика).
// v5 против v4 на том же тексте и голосе (i5-10400F, 4 потока): RTF 0.035 против 0.137 при вдвое
// большей частоте (48 кГц против 24 кГц), плюс ударения в омографах ставятся сами. Формат тот же
// torch.package, голоса те же пять — сайдкар различает поколения по сигнатуре apply_tts.
const MODEL_FILE = 'v5_5_ru.pt';
const MODEL_URL = process.env.LITE_TTS_MODEL_URL || ('https://models.silero.ai/models/tts/ru/' + MODEL_FILE);
// Модели, которые считаем «своими», свежая первой: detect() берёт первую найденную. v4 остаётся
// в списке ради тех, у кого она уже скачана — переезд не должен ломать рабочую установку.
const KNOWN_MODELS = [MODEL_FILE, 'v5_4_ru.pt', 'v5_3_ru.pt', 'v5_2_ru.pt', 'v5_1_ru.pt', 'v5_ru.pt', 'v4_ru.pt'];
const IDLE_MS = 10 * 60 * 1000;          // простой, после которого сайдкар гасится
const CACHE_MAX_BYTES = 300 * 1024 * 1024;
const REQ_TIMEOUT_MS = 120 * 1000;       // синтез одной фразы; на CPU RTF ~0.1, запас огромный
const DEFAULT_VOICES = ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'];

let baseDir = path.join(os.homedir(), '.LiteEditorAI', 'tts');
/** @type {(level: string, src: string, msg: string) => void} */
let log = () => {};

let proc = null;          // живой сайдкар
let procKey = '';         // python+model, на которых он поднят (смена настроек → перезапуск)
let ready = false;        // пришёл hello
let lastVoices = DEFAULT_VOICES.slice();
let lastSampleRate = 0;      // что реально отдаёт поднятая модель (v5 — 48 кГц, v4 — 24 кГц)
let lastOmographs = false;   // ставит ли модель ударения в омографах сама
let lastError = '';
let seq = 0;
const waiting = new Map();  // id → {resolve, timer}
let idleTimer = null;
const probeCache = new Map(); // python → {ok, error, version}

function configure(opts = {}) {
  if (opts.dir) baseDir = opts.dir;
  if (typeof opts.log === 'function') log = opts.log;
  try { fs.mkdirSync(cacheDir(), { recursive: true }); } catch (_) {}
}
function cacheDir() { return path.join(baseDir, 'cache'); }
// Куда КЛАДЁМ скачанное — всегда свежая версия.
function modelDefault() { return path.join(baseDir, MODEL_FILE); }
// Что БЕРЁМ из своего каталога: первую найденную из известных, свежие раньше старых. Так у того,
// кто уже скачал v4, ничего не ломается, а после загрузки v5 она подхватывается сама.
function modelInstalled() {
  for (const name of KNOWN_MODELS) {
    const p = path.join(baseDir, name);
    if (exists(p)) return p;
  }
  return '';
}
function exists(p) { try { return !!p && fs.existsSync(p); } catch (_) { return false; } }

// ── обнаружение движка ────────────────────────────────────────────────────────────────────────
// Проверяем, что интерпретатор действительно умеет torch: путь без torch выглядит рабочим, а
// падает только на первом синтезе — человек в этот момент уже нажал «Озвучить» и ждёт голос.
function probePython(py) {
  if (!py) return { ok: false, error: 'путь не задан' };
  if (probeCache.has(py)) return probeCache.get(py);
  let res;
  try {
    const r = spawnSync(py, ['-c', 'import torch;print(torch.__version__)'], { timeout: 30000, encoding: 'utf8' });
    if (r.error) res = { ok: false, error: r.error.message };
    else if (r.status !== 0) res = { ok: false, error: (r.stderr || '').trim().split('\n').pop() || 'нет модуля torch' };
    else res = { ok: true, version: (r.stdout || '').trim() };
  } catch (e) { res = { ok: false, error: e.message }; }
  probeCache.set(py, res);
  return res;
}

// settings — снимок настроек редактора (ttsPython/ttsModel задаёт пользователь в модуле).
function detect(settings = {}) {
  const out = { python: '', model: '', pythonSource: '', modelSource: '', torch: '', error: '' };

  // Путь, записанный кнопкой «Скачать модель», лежит в НАШЕМ каталоге и назван одним из известных
  // имён — это не осознанный выбор человека, а версия по умолчанию на момент загрузки. Такую
  // настройку перекрываем свежей установленной моделью, иначе переезд на v5 не доедет ни до кого,
  // кто уже качал модель кнопкой. Свой файл в чужом каталоге по-прежнему уважаем как есть.
  const pinned = settings.ttsModel || '';
  const ourDefault = pinned && path.dirname(pinned) === baseDir && KNOWN_MODELS.includes(path.basename(pinned));
  const modelCandidates = [
    [ourDefault ? '' : pinned, 'настройка'],
    [modelInstalled(), 'свой каталог'],
    [process.env.LITE_TTS_MODEL, 'LITE_TTS_MODEL'],
  ];
  for (const [p, src] of modelCandidates) {
    if (exists(p)) { out.model = p; out.modelSource = src; break; }
  }

  const pyCandidates = [
    [settings.ttsPython, 'настройка'],
    [path.join(baseDir, 'venv', 'bin', 'python'), 'свой каталог'],
    [path.join(baseDir, 'venv', 'Scripts', 'python.exe'), 'свой каталог'],
    [process.env.LITE_TTS_PYTHON, 'LITE_TTS_PYTHON'],
    ['python3', 'PATH'],
    ...pyenvCandidates(),
    ['/usr/local/bin/python3', 'система'],
    ['/usr/bin/python3', 'система'],
  ];
  for (const [p, src] of pyCandidates) {
    if (!p) continue;
    if (src !== 'PATH' && !exists(p)) continue;
    const pr = probePython(p);
    if (pr.ok) { out.python = p; out.pythonSource = src; out.torch = pr.version || ''; break; }
    if (src === 'настройка') out.error = `указанный python не умеет torch: ${pr.error || ''}`;
  }
  if (!out.python && !out.error) out.error = 'не найден python с torch — укажите путь в настройках модуля';
  return out;
}

// Менеджеры версий Python (pyenv и подобные) кладут интерпретатор в свой каталог, а в PATH
// добавляются из профиля оболочки. Приложение, запущенное из меню рабочего стола, этот PATH не
// видит — `python3` там разрешается в системный, где torch обычно нет (та же грабля, что с nvm
// и node, см. CLAUDE.md). Поэтому ищем ещё и по абсолютным путям.
function pyenvCandidates() {
  const home = os.homedir();
  const root = process.env.PYENV_ROOT || path.join(home, '.pyenv');
  const out = [];
  let versions;
  try { versions = fs.readdirSync(path.join(root, 'versions')); } catch (_) { versions = []; }
  // свежие версии первыми: 3.12.1 раньше 3.9.7
  versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const v of versions) out.push([path.join(root, 'versions', v, 'bin', 'python3'), 'pyenv ' + v]);
  // shim — последним: он выбирает версию по `.python-version` рабочего каталога, а cwd у редактора
  // чужой (папка проекта), поэтому конкретный интерпретатор предсказуемее.
  out.push([path.join(root, 'shims', 'python3'), 'pyenv']);
  return out;
}

// Сбросить память о проверенных интерпретаторах: человек мог доустановить torch, и «Проверить»
// в настройках обязана спросить заново, а не повторить вчерашний ответ.
function resetProbe() { probeCache.clear(); lastError = ''; }

function state(settings, opts = {}) {
  if (opts.fresh) resetProbe();
  const d = detect(settings);
  return {
    ...d,
    ready: !!(d.python && d.model),
    // чего именно не хватает — UI пишет это в плашке вместо безликого «движок не настроен»
    missing: d.python ? (d.model ? '' : 'model') : 'python',
    running: !!proc && ready,
    voices: lastVoices.slice(),
    modelName: d.model ? path.basename(d.model) : '',
    sampleRate: lastSampleRate,
    omographs: lastOmographs,
    error: lastError || d.error || '',
  };
}

// ── сайдкар ───────────────────────────────────────────────────────────────────────────────────
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { log('info', 'tts', 'сайдкар простаивал — гашу'); stop(); }, IDLE_MS);
}
function stop() {
  clearTimeout(idleTimer);
  const p = proc;
  proc = null; ready = false;
  if (!p) return;
  try { p.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); } catch (_) {}
  setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) {} }, 500);
  for (const [, w] of waiting) { clearTimeout(w.timer); w.resolve({ ok: false, error: 'движок остановлен' }); }
  waiting.clear();
}
function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.op === 'hello') {
    ready = true;
    if (Array.isArray(msg.voices) && msg.voices.length) lastVoices = msg.voices;
    if (msg.sampleRate) lastSampleRate = msg.sampleRate;
    lastOmographs = !!msg.omographs;
    return;
  }
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  clearTimeout(w.timer);
  w.resolve(msg);
}
function ensureProc(settings) {
  const d = detect(settings);
  if (!d.python) return { ok: false, error: d.error || 'не найден python с torch — укажите путь в настройках модуля' };
  if (!d.model) return { ok: false, error: `не найдена модель голоса (${MODEL_FILE}) — скачайте её или укажите путь` };
  const key = d.python + '|' + d.model;
  if (proc && procKey !== key) stop();
  if (proc) { armIdle(); return { ok: true }; }

  procKey = key;
  lastError = '';
  let child;
  try {
    child = spawn(d.python, [SCRIPT, '--model', d.model, '--preload'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    proc = null;
    lastError = e.message;
    return { ok: false, error: e.message };
  }
  proc = child;
  // События процесса сверяем с ТЕКУЩИМ сайдкаром: stop() гасит старый не мгновенно (quit, SIGTERM
  // через 500 мс), а новый может подняться сразу (окно закрыли и открыли, сменили модель). Без
  // сверки поздний exit старого обнулял `proc` нового и отклонял его запросы — новый python с
  // torch оставался сиротой до выхода редактора, а следующая фраза поднимала ещё один.
  let tail = '';   // свой хвост у каждого процесса: строки старого не склеиваются со строками нового
  child.stdout.on('data', (chunk) => {
    if (proc !== child) return;
    tail += chunk.toString('utf8');
    let nl;
    while ((nl = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, nl).trim();
      tail = tail.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    const s = chunk.toString('utf8').trim();
    if (s) log('info', 'tts', s);
  });
  child.on('exit', (code, signal) => {
    if (proc !== child) return;   // этот уже остановлен через stop(): его ожидания разобраны там
    const wasReady = ready;
    proc = null; ready = false;
    for (const [, w] of waiting) { clearTimeout(w.timer); w.resolve({ ok: false, error: 'движок озвучки завершился' }); }
    waiting.clear();
    if (code !== 0 && code !== null) {
      lastError = `движок озвучки завершился с кодом ${code}`;
      log('error', 'tts', lastError + (signal ? ' (' + signal + ')' : ''));
    } else if (wasReady) log('info', 'tts', 'сайдкар остановлен');
  });
  child.on('error', (e) => { if (proc === child) lastError = e.message; log('error', 'tts', 'spawn: ' + e.message); });
  armIdle();
  return { ok: true };
}

function request(payload) {
  return new Promise((resolve) => {
    if (!proc) { resolve({ ok: false, error: 'движок не запущен' }); return; }
    const id = ++seq;
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, error: 'движок не ответил вовремя' });
    }, REQ_TIMEOUT_MS);
    waiting.set(id, { resolve, timer });
    try { proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n'); }
    catch (e) { waiting.delete(id); clearTimeout(timer); resolve({ ok: false, error: e.message }); }
  });
}

// Прогрев: поднять процесс заранее (окно модуля открылось), чтобы первое «Озвучить» не ждало
// загрузку модели. Ошибку не глотаем — она уедет в state() и в UI.
function warmup(settings) {
  const r = ensureProc(settings);
  if (!r.ok) lastError = r.error;
  return r;
}

// ── кэш ───────────────────────────────────────────────────────────────────────────────────────
// В ключ входит и модель: v4 и v5 звучат по-разному и пишут разную частоту, а кэш проверяет
// только наличие файла — без этого после переезда на v5 старые фразы отдавались бы как новые.
function cacheKey(text, voice, rate, model) {
  return crypto.createHash('sha1').update([path.basename(model || ''), voice, rate, text].join(' ')).digest('hex');
}
// Чистку кэша запускаем не после каждой фразы (это readdir + stat на каждый файл), а изредка:
// потолок мягкий, а на длинном тексте фраз сотни.
let sinceLastPrune = 0;
const PRUNE_EVERY = 40;
function maybePruneCache() {
  if (++sinceLastPrune < PRUNE_EVERY) return;
  sinceLastPrune = 0;
  pruneCache();
}
function pruneCache() {
  let files;
  try { files = fs.readdirSync(cacheDir()).filter((f) => f.endsWith('.wav')); } catch (_) { return; }
  const stats = [];
  let total = 0;
  for (const f of files) {
    const p = path.join(cacheDir(), f);
    try { const st = fs.statSync(p); total += st.size; stats.push({ p, size: st.size, at: st.mtimeMs }); } catch (_) {}
  }
  if (total <= CACHE_MAX_BYTES) return;
  stats.sort((a, b) => a.at - b.at); // самые старые — первыми под нож
  for (const s of stats) {
    if (total <= CACHE_MAX_BYTES) break;
    try { fs.unlinkSync(s.p); total -= s.size; } catch (_) {}
  }
}

// Синтез одной фразы → путь к WAV (24 кГц, моно). Повтор того же текста тем же голосом
// отдаётся из кэша мгновенно.
async function speak(settings, { text, voice, rate }) {
  const t = String(text == null ? '' : text).trim();
  // Пустая фраза — не ошибка, а нечего читать: плеер должен спокойно шагнуть дальше.
  if (!t) return { ok: true, skipped: true, reason: 'пустая фраза' };
  const v = voice || 'xenia';
  const r = rate || 'medium';
  // Числа движок глотает, латиницу не читает вовсе, а фраза без кириллицы роняет его пустым
  // ValueError — поэтому говорим не исходным текстом, а нормализованным (см. lib/ttsnorm.js).
  const spoken = normalizeForSpeech(t);
  if (!hasSpeakable(spoken)) return { ok: true, skipped: true, reason: 'нечего произносить' };
  const file = path.join(cacheDir(), cacheKey(spoken, v, r, detect(settings).model) + '.wav');
  if (exists(file)) {
    // Файл из кэша могла оставить прошлая авария — заголовок WAV занимает 44 байта, всё
    // короче звуком быть не может, и лучше пересинтезировать, чем отдать плееру мусор.
    let big;
    try { big = fs.statSync(file).size > 1024; } catch (_) { big = false; }
    if (big) {
      try { fs.utimesSync(file, new Date(), new Date()); } catch (_) {} // освежить для LRU-чистки
      armIdle();
      return { ok: true, file, cached: true };
    }
    try { fs.unlinkSync(file); } catch (_) {}
  }
  const up = ensureProc(settings);
  if (!up.ok) return up;
  try { fs.mkdirSync(cacheDir(), { recursive: true }); } catch (_) {}
  const res = await request({ op: 'speak', text: spoken, voice: v, rate: r, out: file });
  armIdle();
  if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || 'синтез не удался' };
  maybePruneCache();
  return { ok: true, file, dur: res.dur, took: res.took };
}

// ── загрузка модели ───────────────────────────────────────────────────────────────────────────
// 39 МБ по явному действию пользователя (в поставку модель не кладём — лицензия CC BY-NC-SA).
let downloading = false;   // вторая загрузка писала бы в тот же .part и портила первую
function downloadModel(onProgress) {
  return new Promise((resolve) => {
    if (downloading) { resolve({ ok: false, error: 'загрузка модели уже идёт' }); return; }
    const dest = modelDefault();
    const tmp = dest + '.part';
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) {}
    downloading = true;
    let settled = false;
    const done = (result) => { if (settled) return; settled = true; downloading = false; resolve(result); };
    const fail = (msg) => {
      try { file.destroy(); } catch (_) {}          // без этого дескриптор недописанного файла оставался открытым
      try { fs.unlinkSync(tmp); } catch (_) {}
      done({ ok: false, error: msg });
    };
    let file;
    try { file = fs.createWriteStream(tmp); } catch (e) { downloading = false; resolve({ ok: false, error: e.message }); return; }

    // Хранилище моделей может ответить редиректом — без этого сохранился бы HTML-«переезд».
    const start = (url, hops) => {
      if (hops > 5) { fail('слишком много перенаправлений'); return; }
      const req = (url.startsWith('http://') ? http : https).get(url, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          start(new URL(res.headers.location, url).href, hops + 1);
          return;
        }
        if (code !== 200) { res.resume(); fail('HTTP ' + code); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0, lastTick = 0;
        res.on('data', (c) => {
          got += c.length;
          const now = Date.now();
          if (onProgress && now - lastTick > 300) { lastTick = now; try { onProgress({ got, total }); } catch (_) {} }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          // Оборванная закачка тоже доходит до 'finish' — молча сохранённый огрызок потом
          // выглядел бы установленной моделью и падал уже в момент синтеза.
          if (total && got !== total) { fail(`загрузка оборвалась: ${got} из ${total} байт`); return; }
          if (got < 1024 * 1024) { fail('файл модели подозрительно мал — загрузка не удалась'); return; }
          try { fs.renameSync(tmp, dest); } catch (e) { fail(e.message); return; }
          log('info', 'tts', `модель голоса загружена: ${dest}`);
          done({ ok: true, file: dest, size: got });
        }));
        res.on('error', (e) => fail(e.message));
        res.on('aborted', () => fail('соединение прервано'));
      });
      req.on('error', (e) => fail(e.message));
      req.setTimeout(120000, () => { req.destroy(); fail('таймаут загрузки'); });
    };
    start(MODEL_URL, 0);
  });
}

module.exports = { configure, detect, state, speak, warmup, stop, resetProbe, downloadModel, MODEL_URL, MODEL_FILE };
