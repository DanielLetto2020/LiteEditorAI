// LiteEditor — модуль «Озвучка»: буфер обмена → редактируемый текст → живой русский голос.
//
// Зачем: ответы агента длинные, читать их глазами утомительно. Скопировал кусок вывода —
// он тут же в модуле, можно поправить и слушать. Дополнительный вход — пункт «Озвучить»
// в контекстном меню терминала (main маршрутизирует его сюда, см. voice:open).
//
// Устройство:
// - Слежение за буфером обмена делает main (событий «буфер изменился» в Electron нет, поэтому
//   опрос — и только пока это окно открыто). Сюда прилетает tts:clip.
// - Синтез — python-сайдкар Silero v4_ru (lib/tts.js): фраза → WAV-байты. Играем через WebAudio:
//   `<audio src="blob:">` режет CSP редактора, AudioContext её не касается.
// - Текст читается ПО ПРЕДЛОЖЕНИЯМ: пока звучит текущее, синтезируется следующее. Отсюда пауза,
//   перемотка, подсветка читаемой фразы и мгновенный старт на длинном тексте.
// - Два режима документа: правка (textarea — даёт выделение в символах даром) и чтение
//   (слой со спанами предложений: подсветка + клик «читать отсюда»).
// Изоляция как у остальных модулей: ядро не импортируем, бэкенд — только через window.lite.
import { el, icon, iconBtn, toast, makeModal, showConfirm } from '../ui.js';

const $ = (sel) => document.querySelector(sel);
const lite = window.lite;

// Silero принимает только эти ступени темпа — растягивает речь, не трогая высоту голоса.
const RATES = [
  { v: 'x-slow', label: '0.5×' },
  { v: 'slow', label: '0.75×' },
  { v: 'medium', label: '1×' },
  { v: 'fast', label: '1.25×' },
  { v: 'x-fast', label: '1.5×' },
];
const VOICE_LABEL = {
  xenia: 'Ксения — женский, чистый',
  baya: 'Байя — женский, тёплый',
  kseniya: 'Ксения v1 — женский',
  aidar: 'Айдар — мужской',
  eugene: 'Евгений — мужской',
};
const MAX_CLIPS = 200;              // история копирований
const MAX_CLIP_CHARS = 100000;      // защита от «скопировал весь лог»
const MAX_HISTORY_CHARS = 4000000;  // потолок на всю историю: файл состояния не должен пухнуть
const MAX_SENTENCE = 350;           // длиннее — режем по запятым: иначе долгая пауза перед стартом

// ── чистка текста ─────────────────────────────────────────────────────────────────────────────
// Из терминала прилетает не проза, а каша: рамки псевдографики, остатки ANSI, спиннеры, эмодзи,
// полные пути и блоки кода. Читать это вслух невозможно, поэтому чистим на входе (тумблер в шапке).
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const BOX_RE = /[─-╿▀-▟■-◿•·◦]/g;
const SPINNER_RE = /[⠀-⣿✦✧✳✴✻✼]/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu;
const RULE_RE = /^[\s\-=_*#~+.]{4,}$/;

function cleanText(raw) {
  let t = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(ANSI_RE, '');
  // Блоки кода вслух не читают — заменяем пересказом «блок кода, N строк».
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body) => {
    const n = body.split('\n').filter((l) => l.trim()).length;
    return `\n(блок кода, ${n} ${plural(n, 'строка', 'строки', 'строк')})\n`;
  });
  t = t.replace(EMOJI_RE, '').replace(SPINNER_RE, '');
  const lines = t.split('\n').map((ln) => ln.replace(BOX_RE, ' ').replace(/[ \t]+/g, ' ').trim());
  const kept = [];
  for (const ln of lines) {
    if (RULE_RE.test(ln)) continue;                    // линейка-разделитель
    if (!ln && kept.length && !kept[kept.length - 1]) continue; // не копим пустые строки
    kept.push(ln);
  }
  t = kept.join('\n');
  // Markdown-оформление читается как мусор; путь длиннее двух сегментов — как поток слогов.
  t = t.replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(?:\/[\w.@+-]+){3,}/g, (m) => m.slice(m.lastIndexOf('/') + 1));
  return t.trim();
}
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ── нарезка на предложения ────────────────────────────────────────────────────────────────────
// Возвращает [{start,end,text}] в координатах ИСХОДНОГО текста: по ним строится слой чтения
// и определяется, какие фразы попали в выделение.
function splitSentences(text) {
  const out = [];
  const push = (from, to) => {
    const chunk = text.slice(from, to);
    if (!chunk.trim()) return;
    if (chunk.length <= MAX_SENTENCE) { out.push({ start: from, end: to, text: chunk.trim() }); return; }
    // Слишком длинная фраза (списки, «простыня» без точек) — режем по запятым, потом по пробелам.
    let s = from;
    while (s < to) {
      let e = Math.min(s + MAX_SENTENCE, to);
      if (e < to) {
        const win = text.slice(s, e);
        const cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf(' — '));
        e = s + (cut > MAX_SENTENCE * 0.4 ? cut + 1 : (win.lastIndexOf(' ') > 0 ? win.lastIndexOf(' ') : win.length));
      }
      const part = text.slice(s, e);
      if (part.trim()) out.push({ start: s, end: e, text: part.trim() });
      s = e;
    }
  };
  const re = /[.!?…]+["»)\]]*(?=\s|$)|\n+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    push(last, m.index + m[0].length);
    last = m.index + m[0].length;
  }
  push(last, text.length);
  return out;
}

export function initVoice(host) {
  const { layout, GUTTER, saveUiState, refitActiveTerminal, closeOtherPanels, settings } = host;

  let paneOpen = false;
  let unsubClip = null, unsubOpen = null;
  let engine = { ready: false, voices: [], python: '', model: '', error: '' };

  // ---------------- состояние ----------------
  const persisted = (host.STORE && host.STORE.voice) || {};
  const state = {
    clips: Array.isArray(host.STORE && host.STORE.voiceClips) ? host.STORE.voiceClips : [],
    activeId: null,
    watch: persisted.watch !== false,          // перехват буфера — смысл модуля, по умолчанию вкл
    watchSelection: !!persisted.watchSelection, // X11 PRIMARY (выделение мышью) — шумно, по умолчанию выкл
    autoPlay: !!persisted.autoPlay,            // «Читать сразу» — по умолчанию выкл
    clean: persisted.clean !== false,          // чистка терминального мусора
    filter: '',
    mode: 'edit',                              // edit | read
  };
  function saveState() {
    host.persist('voice', {
      watch: state.watch, watchSelection: state.watchSelection,
      autoPlay: state.autoPlay, clean: state.clean,
    });
  }
  // Лимит режет только незакреплённые записи: закреплённое человек оставил намеренно, терять его
  // при сохранении нельзя. Дополнительно держим потолок по объёму — иначе десяток «скопировал весь
  // лог» раздувает файл истории на десятки мегабайт.
  function trimClips(list) {
    const pinned = list.filter((c) => c.pinned);
    const rest = list.filter((c) => !c.pinned).slice(0, Math.max(0, MAX_CLIPS - pinned.length));
    const kept = new Set(rest);
    const out = list.filter((c) => c.pinned || kept.has(c));
    let bytes = 0;
    return out.filter((c, i) => {
      bytes += (c.text || '').length;
      return i === 0 || c.pinned || bytes <= MAX_HISTORY_CHARS;   // свежую запись не выбрасываем никогда
    });
  }
  function saveClips() {
    state.clips = trimClips(state.clips);
    // Открытая запись могла не пережить обрезку — тогда возвращаем её в историю, иначе
    // дальнейшая правка сохранялась бы в никуда: клипа с таким id уже нет.
    if (state.activeId && !state.clips.some((c) => c.id === state.activeId)) {
      const ta = $('#voice-text');
      const text = ta ? ta.value : '';
      if (text.trim()) {
        state.clips.unshift({ id: state.activeId, text, at: Date.now(), src: 'edit', pinned: false });
        state.clips = trimClips(state.clips);
      } else state.activeId = null;
    }
    host.persist('voiceClips', state.clips);
  }
  function voice() { return settings.ttsVoice || 'xenia'; }
  function rate() { return settings.ttsRate || 'medium'; }

  // ---------------- плеер ----------------
  const player = { list: [], i: 0, playing: false, paused: false, src: null, gen: 0, endCurrent: null, bufs: new Map(), pending: new Map() };
  let audioCtx = null;
  function ac() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function toArrayBuffer(wav) {
    if (!wav) return null;
    if (wav instanceof ArrayBuffer) return wav;
    return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength); // Buffer из IPC
  }
  function bufferFor(idx) {
    if (player.bufs.has(idx)) return Promise.resolve(player.bufs.get(idx));
    // Запоминаем сам ЗАПРОС, а не только результат: иначе предзагрузка следующей фразы и
    // дошедший до неё цикл синтезировали одно и то же двумя параллельными вызовами.
    const inFlight = player.pending.get(idx);
    if (inFlight) return inFlight;
    const s = player.list[idx];
    if (!s) return Promise.resolve(null);
    const job = (async () => {
      const r = await lite.tts.speak(s.text, voice(), rate());
      if (r && r.skipped) { player.bufs.set(idx, null); return null; }  // произносить нечего (номер строки, голая пунктуация)
      if (!r || r.ok !== true) throw new Error((r && r.error) || 'синтез не удался');
      const buf = await ac().decodeAudioData(toArrayBuffer(r.wav));
      player.bufs.set(idx, buf);
      // Буферы прочитанных фраз не держим: минута речи — это мегабайты, а длинный текст читают целиком.
      for (const k of player.bufs.keys()) if (k < idx - 1) player.bufs.delete(k);
      return buf;
    })();
    player.pending.set(idx, job);
    job.catch(() => {}).then(() => { if (player.pending.get(idx) === job) player.pending.delete(idx); });
    return job;
  }
  function prefetch(idx) { if (player.list[idx] && !player.bufs.has(idx)) bufferFor(idx).catch(() => {}); }
  function playBuffer(buf) {
    return new Promise((resolve) => {
      const ctx = ac();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      player.src = src;
      let done = false;
      let guard = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (guard) { clearInterval(guard); guard = null; }
        if (player.endCurrent === finish) player.endCurrent = null;
        if (player.src === src) player.src = null;
        resolve();
      };
      src.onended = finish;
      src.start();
      // Страховка от зависшего чтения: если `ended` не придёт (сменилось звуковое устройство,
      // окно усыпили), цикл не должен встать навсегда. Сверяемся с часами самого контекста —
      // на паузе они стоят, поэтому пауза страховку не будит.
      const endsAt = ctx.currentTime + buf.duration;
      guard = setInterval(() => { if (ctx.currentTime > endsAt + 2) finish(); }, 500);
      // Стоп и перемотка обязаны ЗАВЕРШИТЬ этот промис, а не просто погасить звук: иначе цикл
      // чтения остаётся висеть на await вместе со всеми своими буферами.
      player.endCurrent = finish;
    });
  }
  async function runFrom(startIdx) {
    const gen = ++player.gen;
    let skipped = 0;
    const failures = [];
    player.playing = true; player.paused = false;
    try { await ac().resume(); } catch (_) {}
    setMode('read');
    for (let i = startIdx; i < player.list.length; i++) {
      if (gen !== player.gen) return;
      player.i = i;
      highlight(i);
      updatePlayer();
      let buf = null;
      try { buf = await bufferFor(i); }
      catch (e) {
        if (gen !== player.gen) return;
        // Раньше любая осечка на одной фразе останавливала чтение всего текста — человек слышал
        // три строки и тишину. Теперь фраза пропускается, а сводка уходит в конце.
        failures.push((e && e.message) || String(e));
      }
      if (gen !== player.gen) return;
      prefetch(i + 1);              // следующая фраза синтезируется, пока звучит текущая
      if (!buf) { skipped++; continue; }
      await playBuffer(buf);
      if (gen !== player.gen) return;
    }
    player.playing = false;
    player.src = null;
    highlight(-1);
    setMode('edit');   // дочитали до конца — текст снова редактируемый, иначе он «залипал» в режиме чтения
    updatePlayer();
    reportSkips(skipped, failures);
  }
  // Одна сводка в конце вместо тоста на каждой фразе.
  function reportSkips(skipped, failures) {
    if (!skipped) return;
    if (failures.length) {
      toast(`Озвучка: ${failures.length} ${plural(failures.length, 'фраза', 'фразы', 'фраз')} не прочитано — ${failures[0]}`, { kind: 'err', ttl: 8000 });
      return;
    }
    toast(`Пропущено ${skipped} ${plural(skipped, 'фраза', 'фразы', 'фраз')}: произносить нечего`, { kind: 'warn', ttl: 5000 });
  }
  function stopPlayback() {
    player.gen++;
    player.playing = false; player.paused = false;
    const src = player.src;
    player.src = null;
    if (src) { try { src.onended = null; src.stop(); } catch (_) {} }
    if (player.endCurrent) { const f = player.endCurrent; player.endCurrent = null; f(); }
    if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (_) {} }
    highlight(-1);
    setMode('edit');
    updatePlayer();
  }
  function togglePause() {
    if (!player.playing) return;
    if (player.paused) { try { ac().resume(); } catch (_) {} player.paused = false; }
    else { try { ac().suspend(); } catch (_) {} player.paused = true; }
    updatePlayer();
  }
  // Старт: если в тексте выделен кусок — читаем только фразы, попавшие в выделение.
  let engineAsking = false;
  function play() {
    if (!engine.ready) {
      // Состояние движка могло ещё не приехать (окно только что открылось) — спросим и повторим,
      // и только на реальном «движка нет» покажем настройки. Повторные нажатия, пока идёт
      // проверка, игнорируем: иначе несколько ответов запускали чтение и тут же ставили паузу.
      if (engineAsking) return;
      engineAsking = true;
      refreshEngine().then(() => {
        engineAsking = false;
        renderToolbar();
        if (engine.ready) play();
        else openSettings();
      }).catch(() => { engineAsking = false; });
      return;
    }
    if (player.playing) { togglePause(); return; }
    const ta = $('#voice-text');
    if (!ta) return;
    const text = ta.value;
    if (!text.trim()) { toast('Нечего озвучивать — текст пуст', { kind: 'warn' }); return; }
    const all = splitSentences(text);
    if (!all.length) { toast('Нечего озвучивать', { kind: 'warn' }); return; }
    const sel = selectionRange(ta);
    player.list = all;
    player.bufs.clear();
    player.pending.clear();
    let from = 0;
    if (sel) {
      const idx = all.findIndex((s) => s.end > sel.start && s.start < sel.end);
      if (idx >= 0) {
        player.list = all.filter((s) => s.end > sel.start && s.start < sel.end);
        from = 0;
        renderRead(text, player.list);
        runFrom(from);
        return;
      }
    }
    renderRead(text, all);
    runFrom(from);
  }
  function selectionRange(ta) {
    if (ta.selectionStart == null || ta.selectionEnd == null) return null;
    if (ta.selectionEnd - ta.selectionStart < 2) return null;
    return { start: ta.selectionStart, end: ta.selectionEnd };
  }

  // ---------------- документ: правка ↔ чтение ----------------
  function setMode(m) {
    if (state.mode === m) return;
    state.mode = m;
    const ta = $('#voice-text'), rd = $('#voice-read');
    if (!ta || !rd) return;
    ta.classList.toggle('hidden', m === 'read');
    rd.classList.toggle('hidden', m !== 'read');
  }
  // Слой чтения: текст режется на спаны по предложениям (промежутки достаются соседям, чтобы
  // документ выглядел ровно так же). Клик по фразе — «читать отсюда».
  function renderRead(text, list) {
    const rd = $('#voice-read');
    if (!rd) return;
    rd.innerHTML = '';
    let pos = 0;
    list.forEach((s, i) => {
      // Текст между фразами (и всё, что не попало в выделение) — отдельным куском: иначе он
      // прилипал бы к соседней фразе и подсвечивался вместе с ней.
      if (s.start > pos) rd.appendChild(el('span', 'voice-tail', text.slice(pos, s.start)));
      const sp = el('span', 'voice-sent');
      sp.dataset.i = String(i);
      sp.textContent = text.slice(s.start, s.end);
      sp.onclick = () => { stopHighlightOnly(); player.list = list; runFrom(i); };
      rd.appendChild(sp);
      pos = s.end;
    });
    if (pos < text.length) rd.appendChild(el('span', 'voice-tail', text.slice(pos)));
  }
  function stopHighlightOnly() {
    player.gen++;
    const src = player.src;
    player.src = null;
    if (src) { try { src.onended = null; src.stop(); } catch (_) {} }
    if (player.endCurrent) { const f = player.endCurrent; player.endCurrent = null; f(); }
    player.paused = false;
    if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (_) {} }
  }
  function highlight(i) {
    const rd = $('#voice-read');
    if (!rd) return;
    rd.querySelectorAll('.voice-sent.is-live').forEach((n) => n.classList.remove('is-live'));
    if (i < 0) return;
    const node = rd.querySelector(`.voice-sent[data-i="${i}"]`);
    if (!node) return;
    node.classList.add('is-live');
    const box = node.getBoundingClientRect(), area = rd.getBoundingClientRect();
    if (box.top < area.top + 40 || box.bottom > area.bottom - 40) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------------- история клипов ----------------
  function clipTitle(text) {
    const line = String(text).split('\n').map((s) => s.trim()).find((s) => s) || '';
    return line.length > 90 ? line.slice(0, 90) + '…' : line;
  }
  function addClip(raw, opts = {}) {
    const whole = String(raw == null ? '' : raw);
    const src = whole.slice(0, MAX_CLIP_CHARS);
    if (whole.length > MAX_CLIP_CHARS) {
      toast(`Фрагмент обрезан до ${Math.round(MAX_CLIP_CHARS / 1000)} тыс. знаков — озвучен будет только он`, { kind: 'warn', ttl: 7000 });
    }
    const text = state.clean ? cleanText(src) : src.trim();
    if (!text) return null;
    const same = state.clips.find((c) => c.text === text);
    if (same) {                       // тот же текст скопировали повторно — поднимаем наверх, не плодим
      same.at = Date.now();
      state.clips = [same, ...state.clips.filter((c) => c !== same)];
    } else {
      state.clips.unshift({ id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6), text, at: Date.now(), src: opts.source || 'clipboard', pinned: false });
    }
    const clip = state.clips[0];
    saveClips();   // сам подрежет историю, сохранив закреплённое
    // Во время чтения документ не подменяем: случайное копирование обрывало озвучку на середине.
    // Новый фрагмент просто появляется в истории; «Читать сразу» и «Озвучить» из терминала — это
    // явная команда читать, там подмена нужна (opts.force).
    if (player.playing && !opts.force) { renderList(); return clip; }
    loadClip(clip.id, { keepScroll: true });
    renderList();
    return clip;
  }
  function loadClip(id, opts = {}) {
    const clip = state.clips.find((c) => c.id === id);
    if (!clip) return;
    if (state.activeId && state.activeId !== id) saveActiveText();  // правка в поле ждала автосохранения — забираем её сейчас
    state.activeId = id;
    stopPlayback();
    const ta = $('#voice-text');
    if (ta) { ta.value = clip.text; if (!opts.keepScroll) ta.scrollTop = 0; }
    renderList();
    recountSentences();
  }
  function saveActiveText() {
    const ta = $('#voice-text');
    if (!ta) return;
    const clip = state.clips.find((c) => c.id === state.activeId);
    if (!clip || clip.text === ta.value) return;
    clip.text = ta.value.slice(0, MAX_CLIP_CHARS);
    saveClips();
    renderList();
  }
  function renderList() {
    const box = $('#voice-list');
    if (!box) return;
    const keepScroll = box.scrollTop;   // список перерисовывается и при автосохранении правки
    box.innerHTML = '';
    const q = state.filter.trim().toLowerCase();
    const items = state.clips.filter((c) => !q || c.text.toLowerCase().includes(q));
    if (!items.length) {
      box.appendChild(el('div', 'voice-empty', state.clips.length
        ? 'Ничего не найдено'
        : 'История пуста. Скопируйте текст — он появится здесь.'));
      box.scrollTop = 0;
      return;
    }
    const pinned = items.filter((c) => c.pinned), rest = items.filter((c) => !c.pinned);
    for (const group of [pinned, rest]) {
      for (const c of group) {
        const card = el('div', 'voice-clip' + (c.id === state.activeId ? ' is-active' : '') + (c.pinned ? ' is-pinned' : ''));
        card.onclick = () => loadClip(c.id);
        const head = el('div', 'voice-clip-head');
        head.appendChild(el('span', 'voice-clip-title', clipTitle(c.text) || '(пусто)'));
        const acts = el('div', 'voice-clip-acts');
        const pin = iconBtn('icon-btn mini', 'pin', c.pinned ? 'Открепить' : 'Закрепить');
        pin.onclick = (e) => { e.stopPropagation(); c.pinned = !c.pinned; saveClips(); renderList(); };
        const del = iconBtn('icon-btn mini', 'trash', 'Удалить из истории');
        del.onclick = (e) => {
          e.stopPropagation();
          state.clips = state.clips.filter((x) => x !== c);
          if (state.activeId === c.id) { state.activeId = null; const ta = $('#voice-text'); if (ta) ta.value = ''; }
          saveClips(); renderList();
        };
        acts.append(pin, del);
        head.appendChild(acts);
        const meta = el('div', 'voice-clip-meta');
        const d = new Date(c.at);
        meta.appendChild(el('span', null, String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')));
        meta.appendChild(el('span', 'voice-dot', '·'));
        meta.appendChild(el('span', null, c.text.length > 999 ? `${(c.text.length / 1000).toFixed(1)} тыс. знаков` : `${c.text.length} знаков`));
        if (c.src === 'selection') { meta.appendChild(el('span', 'voice-dot', '·')); meta.appendChild(el('span', null, 'выделение')); }
        card.append(head, meta);
        box.appendChild(card);
      }
    }
    box.scrollTop = keepScroll;
  }

  // ---------------- шапка и плеер ----------------
  function renderToolbar() {
    const bar = $('#voice-toolbar');
    if (!bar) return;
    bar.innerHTML = '';

    const eng = el('button', 'voice-engine' + (engine.ready ? ' is-ok' : ' is-off'));
    eng.type = 'button';
    eng.appendChild(el('span', 'voice-dotmark'));
    const lack = engine.missing === 'model' ? 'Нет модели голоса'
      : engine.missing === 'python' ? 'Нет Python с torch'
        : 'Движок не настроен';
    eng.appendChild(el('span', null, engine.ready ? `Голос: ${shortVoice(voice())}` : lack));
    eng.title = engine.ready
      ? `python: ${engine.python}\nмодель: ${engine.model}`
      : (engine.error || 'Нажмите, чтобы указать движок синтеза');
    eng.onclick = openSettings;
    bar.appendChild(eng);

    const vsel = el('select', 'voice-select');
    for (const v of (engine.voices.length ? engine.voices : ['xenia'])) {
      const o = el('option', null, VOICE_LABEL[v] || v);
      o.value = v;
      if (v === voice()) o.selected = true;
      vsel.appendChild(o);
    }
    vsel.title = 'Голос диктора';
    vsel.onchange = () => { settings.ttsVoice = vsel.value; host.saveSettings(); player.bufs.clear(); player.pending.clear(); renderToolbar(); };
    bar.appendChild(vsel);

    const rsel = el('select', 'voice-select voice-select-rate');
    for (const r of RATES) {
      const o = el('option', null, r.label);
      o.value = r.v;
      if (r.v === rate()) o.selected = true;
      rsel.appendChild(o);
    }
    rsel.title = 'Темп речи';
    rsel.onchange = () => { settings.ttsRate = rsel.value; host.saveSettings(); player.bufs.clear(); player.pending.clear(); };
    bar.appendChild(rsel);

    bar.appendChild(toggle('Перехват буфера', 'Скопированный текст сразу попадает сюда', state.watch, (v) => {
      state.watch = v; saveState(); applyWatch();
    }));
    bar.appendChild(toggle('Читать сразу', 'Новый текст из буфера озвучивается без нажатия кнопки', state.autoPlay, (v) => {
      state.autoPlay = v; saveState();
    }));
    bar.appendChild(toggle('Чистить текст', 'Убирать рамки, ANSI, эмодзи и длинные пути перед чтением', state.clean, (v) => {
      state.clean = v; saveState();
    }));
  }
  function shortVoice(v) { return (VOICE_LABEL[v] || v).split(' —')[0]; }
  function toggle(label, title, value, onChange) {
    const wrap = el('label', 'voice-toggle' + (value ? ' is-on' : ''));
    wrap.title = title;
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!value;
    cb.onchange = () => { wrap.classList.toggle('is-on', cb.checked); onChange(cb.checked); };
    wrap.append(cb, el('span', null, label));
    return wrap;
  }
  // Счётчик фраз считаем не на каждое нажатие клавиши: на длинном тексте нарезка не бесплатна,
  // а число в плеере — справочное.
  let sentCount = 0;
  function recountSentences() {
    const ta = $('#voice-text');
    sentCount = ta && ta.value.trim() ? splitSentences(ta.value).length : 0;
    updatePlayer();
  }
  function updatePlayer() {
    const bar = $('#voice-player');
    if (!bar) return;
    bar.innerHTML = '';
    const ta = $('#voice-text');
    const hasSel = ta ? !!selectionRange(ta) : false;

    const main = el('button', 'btn primary voice-play');
    main.type = 'button';
    main.appendChild(icon(player.playing && !player.paused ? 'pause' : 'play', 16));
    main.appendChild(el('span', null, player.playing
      ? (player.paused ? 'Продолжить' : 'Пауза')
      : (hasSel ? 'Озвучить выделенное' : 'Озвучить')));
    main.onclick = play;
    bar.appendChild(main);

    const stop = el('button', 'btn voice-stop');
    stop.type = 'button';
    stop.appendChild(icon('stop', 16));
    stop.appendChild(el('span', null, 'Стоп'));
    stop.disabled = !player.playing;
    stop.onclick = stopPlayback;
    bar.appendChild(stop);

    if (player.playing) {
      const prev = iconBtn('icon-btn', 'undo', 'Предыдущая фраза');
      prev.onclick = () => { if (player.i > 0) { stopHighlightOnly(); runFrom(player.i - 1); } };
      const next = iconBtn('icon-btn', 'redo', 'Следующая фраза');
      next.onclick = () => { if (player.i + 1 < player.list.length) { stopHighlightOnly(); runFrom(player.i + 1); } };
      bar.append(prev, next);
    }

    bar.appendChild(el('div', 'voice-spacer'));
    if (player.playing) {
      // Паузу видно только по подписи кнопки — этого мало: со стороны это выглядит как «замолчало
      // само на середине». Поэтому состояние написано прямо в строке прогресса.
      const prog = el('span', 'voice-progress' + (player.paused ? ' is-paused' : ''),
        `Фраза ${player.i + 1} из ${player.list.length}`);
      if (player.paused) prog.appendChild(el('span', null, ' · пауза')); // отдельным узлом: строка-шаблон остаётся общей для словаря
      bar.appendChild(prog);
    }
    else if (sentCount > 0) bar.appendChild(el('span', 'voice-progress', `${sentCount} ${plural(sentCount, 'фраза', 'фразы', 'фраз')}`));
    bar.appendChild(el('span', 'voice-hint', 'Ctrl+Enter — озвучить · Ctrl+U — ударение · Esc — стоп'));
  }

  // ---------------- настройка движка ----------------
  function openSettings() {
    const { m, close } = makeModal(`
      <h2>Движок озвучки</h2>
      <p class="voice-modal-note">Голос синтезирует Silero v4_ru в отдельном процессе Python: нужен интерпретатор с установленным torch и файл модели (39 МБ). В поставку редактора движок не входит.</p>
      <label class="voice-lbl">Python с torch</label>
      <div class="voice-path-row"><input id="vs-py" type="text" placeholder="python3"><button class="btn" id="vs-py-pick">Выбрать…</button></div>
      <div class="voice-path-hint" id="vs-py-hint"></div>
      <label class="voice-lbl">Модель голоса (v4_ru.pt)</label>
      <div class="voice-path-row"><input id="vs-model" type="text" placeholder="~/.LiteEditorAI/tts/v4_ru.pt"><button class="btn" id="vs-model-pick">Выбрать…</button></div>
      <div class="voice-path-hint" id="vs-model-hint"></div>
      <div class="voice-dl"><button class="btn" id="vs-dl">Скачать модель (39 МБ)</button><span id="vs-dl-status"></span></div>
      <div class="modal-actions">
        <button class="btn" id="vs-check">Проверить</button>
        <button class="btn primary" id="vs-save">Сохранить</button>
      </div>`);
    const py = m.querySelector('#vs-py'), md = m.querySelector('#vs-model');
    py.value = settings.ttsPython || '';
    md.value = settings.ttsModel || '';
    const pyHint = m.querySelector('#vs-py-hint'), mdHint = m.querySelector('#vs-model-hint');
    const paint = () => {
      pyHint.textContent = engine.python
        ? `найден: ${engine.python}${engine.torch ? ' · torch ' + engine.torch : ''}${engine.pythonSource ? ' (' + engine.pythonSource + ')' : ''}`
        : (engine.error || 'не найден — укажите путь к интерпретатору, где стоит torch');
      pyHint.classList.toggle('is-bad', !engine.python);
      mdHint.textContent = engine.model ? `найдена: ${engine.model}` : 'не найдена — скачайте кнопкой ниже или укажите путь';
      mdHint.classList.toggle('is-bad', !engine.model);
    };
    paint();
    m.querySelector('#vs-py-pick').onclick = async () => {
      const r = await lite.tts.pick('python');
      if (r && r.ok) py.value = r.path;
    };
    m.querySelector('#vs-model-pick').onclick = async () => {
      const r = await lite.tts.pick('model');
      if (r && r.ok) md.value = r.path;
    };
    const apply = async (fresh) => {
      settings.ttsPython = py.value.trim();
      settings.ttsModel = md.value.trim();
      host.saveSettings();
      await refreshEngine(fresh);
      paint();
      renderToolbar();
    };
    m.querySelector('#vs-check').onclick = async () => {
      await apply(true);   // человек мог доустановить torch — спрашиваем заново, а не из памяти
      toast(engine.ready ? 'Движок готов' : `Движок не готов: ${engine.error || 'проверьте пути'}`, { kind: engine.ready ? 'ok' : 'err' });
    };
    m.querySelector('#vs-save').onclick = async () => { await apply(true); close(); };
    const dl = m.querySelector('#vs-dl'), dlStatus = m.querySelector('#vs-dl-status');
    dl.onclick = async () => {
      dl.disabled = true;
      dlStatus.textContent = 'Загрузка…';
      const off = lite.tts.onDownloadProgress(({ got, total }) => {
        dlStatus.textContent = total
          ? `${Math.round(got / 1048576)} из ${Math.round(total / 1048576)} МБ`
          : `${Math.round(got / 1048576)} МБ`;
      });
      const r = await lite.tts.downloadModel();
      off();
      dl.disabled = false;
      if (!r || r.ok !== true) { dlStatus.textContent = ''; toast(`Не удалось скачать модель: ${(r && r.error) || ''}`, { kind: 'err' }); return; }
      dlStatus.textContent = 'Готово';
      md.value = r.file;
      await apply();
      paint();
    };
  }

  async function refreshEngine(fresh) {
    try {
      const s = await lite.tts.state(fresh);
      engine = s || engine;
      engine.ready = !!(s && s.ready);
    } catch (e) {
      engine = { ready: false, voices: [], python: '', model: '', error: String(e && e.message || e) };
    }
    return engine;
  }

  // ---------------- слежение за буфером ----------------
  function applyWatch() {
    try { lite.tts.clipWatch(paneOpen && state.watch, state.watchSelection); } catch (_) {}
  }
  function onClip({ text, source }) {
    if (!text || !state.watch) return;
    const clip = addClip(text, { source, force: state.autoPlay });
    if (clip && state.autoPlay) setTimeout(play, 60);
  }
  // Текст из контекстного меню терминала («Озвучить») — приходит через main.
  function onExternalText({ text }) {
    if (!text) return;
    const clip = addClip(text, { source: 'terminal', force: true });
    if (clip) setTimeout(play, 120);   // «Озвучить» из меню терминала — команда читать, а не просто положить текст
  }

  // ---------------- ударение ----------------
  // Silero читает `+` перед гласной как ударение: «з+амок» ≠ «зам+ок». Ctrl+U ставит его
  // в позицию курсора, повторное нажатие на том же месте — убирает.
  function toggleAccent() {
    const ta = $('#voice-text');
    if (!ta || state.mode !== 'edit') return;
    const pos = ta.selectionStart;
    const v = ta.value;
    if (v[pos - 1] === '+') {
      ta.value = v.slice(0, pos - 1) + v.slice(pos);
      ta.selectionStart = ta.selectionEnd = pos - 1;
    } else {
      ta.value = v.slice(0, pos) + '+' + v.slice(pos);
      ta.selectionStart = ta.selectionEnd = pos + 1;
    }
    saveActiveText();
    recountSentences();
  }

  // ---------------- панель ----------------
  function setOpen(open, opts = {}) {
    if (open === paneOpen) { if (open) renderPanel(); return; }
    if (open) closeOtherPanels('voice');
    const delta = (layout.voice || 620) + GUTTER;
    paneOpen = open;
    $('#voice-pane').classList.toggle('hidden', !open);
    $('#gutter-voice').classList.toggle('hidden', !open);
    if (opts.grow !== false) lite.win.growBy(open ? delta : -delta);
    saveUiState();
    if (open) renderPanel(); else { stopPlayback(); applyWatch(); }
    setTimeout(refitActiveTerminal, 150);
  }

  let wired = false;
  function renderPanel() {
    if (!paneOpen) return;
    if (!wired) {
      wired = true;
      const ta = $('#voice-text');
      if (ta) {
        let saveT;
        ta.addEventListener('input', () => { clearTimeout(saveT); saveT = setTimeout(() => { saveActiveText(); recountSentences(); }, 400); });
        ta.addEventListener('select', () => updatePlayer());
        ta.addEventListener('mouseup', () => setTimeout(updatePlayer, 0));
        ta.addEventListener('keyup', (e) => { if (e.shiftKey || e.key === 'ArrowLeft' || e.key === 'ArrowRight') updatePlayer(); });
      }
      const q = $('#voice-filter');
      if (q) q.addEventListener('input', () => { state.filter = q.value; renderList(); });
      document.addEventListener('keydown', (e) => {
        if (!paneOpen) return;
        if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); play(); return; }
        if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); toggleAccent(); return; }
        if (e.key === 'Escape' && player.playing) { e.preventDefault(); stopPlayback(); }
      });
      unsubClip = lite.tts.onClip(onClip);
      unsubOpen = lite.tts.onOpenText(onExternalText);
      try { lite.tts.panelReady(); } catch (_) {}    // флаш отложенных «Озвучить» из main
    }
    renderList();
    renderToolbar();
    recountSentences();
    applyWatch();
    refreshEngine().then(() => {
      renderToolbar();
      if (engine.ready) { try { lite.tts.warmup(); } catch (_) {} } // модель в память заранее: первое «Озвучить» не ждёт 3 секунды
    });
    if (!state.activeId && state.clips.length) loadClip(state.clips[0].id);
  }

  function clearHistory() {
    showConfirm('Очистить историю', 'Удалить все незакреплённые записи из истории копирований?', 'Очистить', () => {
      state.clips = state.clips.filter((c) => c.pinned);
      if (!state.clips.find((c) => c.id === state.activeId)) {
        state.activeId = null;
        const ta = $('#voice-text');
        if (ta) ta.value = '';       // иначе в поле остался бы текст записи, которой уже нет
        stopPlayback();
        recountSentences();
      }
      host.persist('voiceClips', state.clips);   // без saveClips: он вернул бы удалённую запись обратно
      renderList();
    });
  }

  return {
    isOpen: () => paneOpen,
    setOpen,
    toggle: () => setOpen(!paneOpen),
    renderPanel,
    openSettings,
    clearHistory,
    onExternalText,
    // Окно закрывается: забрать правку, дописать историю синхронно (обычная запись — send,
    // она могла не долететь до закрытия), снять слежение и оборвать звук.
    confirmClose: (proceed) => {
      try {
        saveActiveText();
        state.clips = trimClips(state.clips);
        try { lite.store.setSync('voiceClips', state.clips); } catch (_) { host.persist('voiceClips', state.clips); }
        stopPlayback();
        if (unsubClip) unsubClip();
        if (unsubOpen) unsubOpen();
        lite.tts.clipWatch(false);
      } catch (_) {}
      proceed();
    },
  };
}
