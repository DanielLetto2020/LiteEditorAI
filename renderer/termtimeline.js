// Шкала времени слева от терминала («когда это было напечатано»).
//
// Зачем: у агента (Claude Code и т.п.) вывод идёт сплошным потоком, и через час работы
// непонятно, что было пять минут назад, а что — до обеда. Печатать время В САМ вывод нельзя:
// это чужой поток, там Ink/curses перерисовывают нижние строки, любой префикс ломает вёрстку.
// Поэтому шкала — ОТДЕЛЬНЫЙ слой DOM рядом с .xterm, а не текст в буфере. Побочный плюс:
// шкала не попадает в выделение — копируется чистый вывод без времени.
//
// Как она держится за строки: не по «номеру строки» (буфер обрезается по scrollback, номера
// уезжают), а через term.registerMarker() — xterm сам двигает IMarker.line при обрезке и сам
// его диспозит, когда строка выпала из истории. Ручная Map<индекс, время> потребовала бы
// пересчёта смещений на каждый trim и всё равно рассинхронизировалась бы.
//
// По той же причине маркером сделана и ОПОРА «где кончилась прошлая порция вывода» (anchor).
// Числовой опорой шкала работала только до первого заполнения scrollback: baseY растёт, пока
// буфер не упёрся в потолок (rows + scrollback), а дальше новые строки добавляются обрезкой
// сверху, baseY замирает, и `baseY + cursorY` перестаёт расти. Опора-число с этого момента
// навсегда равна текущему низу, весь вывод классифицируется как «перерисовка живой зоны» —
// и засечки не ставятся больше никогда. У IMarker.line обрезанные строки вычитает сам xterm,
// поэтому сравнение остаётся верным на любом объёме вывода.
//
// Что считается «засечкой» (метку ставим не на каждую строку — иначе стена цифр):
//   cmd  — пользователь отправил ввод (Enter): начало команды/промпта, самая полезная опора;
//   gap  — вывод возобновился после тишины ≥ QUIET_MS: граница между «делами»;
//   tick — сменилась минута: чтобы шкала не была пустой в непрерывном потоке.
//
// Метки ставятся только на ФИНАЛИЗИРОВАННЫЕ строки — те, что выше позиции курсора. Живую зону
// внизу агент перерисовывает (спиннер, поле ввода), и метка на ней прыгала бы вместе с текстом.

const MAX_MARKS = 400;      // потолок числа маркеров на терминал (старые отбрасываем)
const QUIET_MS = 20000;     // пауза в выводе, после которой ставим засечку «новое дело»
const TICK_MS = 60000;      // минимальный шаг между метками-минутами
const RAIL_STEP = 5;        // шаг делений рельса, в строках экрана

const pad2 = (n) => (n < 10 ? '0' + n : String(n));
const hhmm = (ts) => { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const hhmmss = (ts) => { const d = new Date(ts); return hhmm(ts) + ':' + pad2(d.getSeconds()); };

// Высота строки в пикселях. Приватное _renderService даёт дробное значение (важно: ошибка в
// полпикселя на 40 строк уводит метку на строку вниз), но приватное API может пропасть при
// обновлении xterm — поэтому фолбэк на измерение .xterm-screen.
function cellHeight(term) {
  try {
    const h = term._core._renderService.dimensions.css.cell.height;
    if (h > 0) return h;
  } catch (_) {}
  const screen = term.element && term.element.querySelector('.xterm-screen');
  if (screen && term.rows > 0) return screen.clientHeight / term.rows;
  return 0;
}

// Подключает шкалу к уже открытому терминалу (term.open(container) должен быть вызван ДО).
// Возвращает handle; вызывающий обязан звать dispose() при закрытии терминала.
// onGeometry — колбэк «ширина области терминала изменилась», вызывающий делает fit + pty.resize.
export function attachTimeline(term, container, { enabled = false, fontSize = 13, onGeometry = null } = {}) {
  const root = document.createElement('div');
  root.className = 'term-timeline';
  root.setAttribute('data-no-i18n', '');   // время и цифры переводить нечего
  // Рельс с делениями — под метками (метки рисуются поверх). Засечки ставятся только по
  // событиям, поэтому в тишине полоса была бы пустой; рельс даёт ей опору и ритм.
  const rail = document.createElement('div');
  rail.className = 'ttl-rail';
  root.appendChild(rail);
  const inner = document.createElement('div');
  inner.className = 'ttl-inner';
  root.appendChild(inner);
  container.insertBefore(root, container.firstChild);

  const marks = [];           // [{ marker, ts, kind }] — порядок = порядок появления
  let anchor = null;          // IMarker на строке, где остановилась прошлая порция вывода
  let lastMarkTs = 0;         // время последней поставленной засечки
  let lastOutputAt = 0;       // время предыдущего вывода — для распознавания паузы
  let pendingCmd = false;     // пользователь нажал Enter, ждём первую строку ответа
  let on = enabled;
  let raf = 0;
  let lastHtml = null;        // подпись отрисованного состояния: гасит лишние правки DOM
  let lastRail = null;        // подпись рельса — он зависит только от геометрии, не от меток

  let curFont = fontSize;
  // Ширина шкалы и отступ под неё считаются в JS (зависят от кегля). Отступ вешается на САМ
  // term.element, а не на контейнер: FitAddon вычитает из доступной ширины padding именно
  // элемента терминала, а padding родителя не видит — на контейнере колонки считались бы по
  // старой ширине и вывод вылезал бы за край.
  const applyFont = (fs) => {
    curFont = fs || 13;
    // Шкала мельче вывода на 3pt (это подпись, а не текст) и не уже 9px, иначе цифры сливаются.
    const labelFs = Math.max(9, curFont - 3);
    root.style.fontSize = labelFs + 'px';
    // «12:34» — 5 моноширинных знаков (≈0.62 от кегля) плюс место под риску засечки.
    const w = Math.ceil(labelFs * 0.62 * 5) + 11;
    root.style.width = w + 'px';
    if (on && term.element) term.element.style.paddingLeft = (w + 6) + 'px';
  };
  let posPatched = false;     // мы ли поменяли position контейнера (чтобы вернуть как было)
  const applyVisible = () => {
    root.style.display = on ? '' : 'none';
    if (on) {
      // Абсолютной шкале нужен позиционированный предок. .term-instance уже absolute, но
      // контейнер в панели модулей может быть static — тогда и только тогда вмешиваемся.
      if (getComputedStyle(container).position === 'static') { container.style.position = 'relative'; posPatched = true; }
      applyFont(curFont);
    } else if (term.element) {
      term.element.style.paddingLeft = '';
    }
  };
  applyFont(fontSize);
  applyVisible();

  // Переставить опору на текущую строку курсора. Старый маркер ОБЯЗАТЕЛЬНО диспозим: без
  // этого каждая порция вывода оставляла бы по маркеру в buffer.markers терминала.
  function setAnchor() {
    if (anchor && !anchor.isDisposed) { try { anchor.dispose(); } catch (_) {} }
    anchor = null;
    if (!on) return;                            // выключенная шкала не держит ни одного маркера
    try { if (term.buffer.active.type === 'normal') anchor = term.registerMarker(0); } catch (_) { anchor = null; }
  }

  // Снять всё, что шкала держит в буфере xterm.
  function dropMarkers() {
    if (anchor && !anchor.isDisposed) { try { anchor.dispose(); } catch (_) {} }
    anchor = null;
    for (const m of marks) { try { m.marker.dispose(); } catch (_) {} }
    marks.length = 0;
  }

  // Засечка — это САМ маркер-опора: он уже стоит ровно на нужной строке (там, где кончилась
  // прошлая порция = где начинается новая), поэтому просто передаём его в marks, а опору
  // заводим заново. Лишний registerMarker не нужен.
  function keepAsMark(marker, ts, kind) {
    marks.push({ marker, ts, kind });
    lastMarkTs = ts;
    if (marks.length > MAX_MARKS) {
      for (const dead of marks.splice(0, marks.length - MAX_MARKS)) {
        try { dead.marker.dispose(); } catch (_) {}
      }
    }
  }

  // Вызывается после разбора каждой порции вывода PTY.
  function onOutput() {
    const b = term.buffer.active;
    const now = Date.now();
    if (b.type === 'alternate') { lastOutputAt = now; return; } // vim/less/htop — истории нет, метить нечего
    if (!anchor || anchor.isDisposed) { setAnchor(); lastOutputAt = now; return; } // опора потерялась — ставим заново
    const bottom = b.baseY + b.cursorY;
    if (bottom === anchor.line) { lastOutputAt = now; return; } // курсор не сдвинулся — опору не трогаем
    if (bottom < anchor.line) {                 // курсор ушёл ВВЕРХ (clear/reset/перерисовка живой зоны)
      setAnchor();
      lastOutputAt = now;
      return;
    }
    const gap = now - lastOutputAt;
    const kind = pendingCmd ? 'cmd'
      : gap >= QUIET_MS ? 'gap'
        : (now - lastMarkTs >= TICK_MS ? 'tick' : null);
    if (kind) { keepAsMark(anchor, now, kind); anchor = null; } // опора стала засечкой
    setAnchor();
    lastOutputAt = now;
    pendingCmd = false;
  }

  function render() {
    raf = 0;
    if (!on || !term.element) return;
    const b = term.buffer.active;
    const cell = cellHeight(term);
    if (!cell) return;
    // Верх шкалы совмещаем с фактическим верхом области строк: у контейнера свои padding'и,
    // а у .xterm — свои. Считаем по факту, а не по константам из CSS.
    const screen = term.element.querySelector('.xterm-screen');
    let top = 0;
    if (screen) top = screen.getBoundingClientRect().top - root.getBoundingClientRect().top;

    // Мёртвые маркеры убираем из массива целиком. Обычно они умирают с головы (первой
    // обрезается самая старая строка), но удаление строк (ESC[M и подобное — агенты этим
    // пользуются) гасит маркер из СЕРЕДИНЫ, и такая дыра иначе жила бы до конца сессии.
    if (marks.some((m) => m.marker.isDisposed)) {
      const alive = marks.filter((m) => !m.marker.isDisposed);
      marks.length = 0;
      for (const m of alive) marks.push(m);
    }

    // Деления рельса привязаны к СТРОКАМ экрана, а не ко времени: интерполировать минуты
    // между засечками нельзя — вывод идёт рывками, и деление встало бы не туда, соврав про
    // «когда это было». Поэтому они меняются только при смене кегля/размера окна, и
    // перестраиваются по своей подписи, а не каждый кадр.
    const railSig = Math.round(top) + '|' + Math.round(cell * 100) + '|' + term.rows;
    if (railSig !== lastRail) {
      lastRail = railSig;
      rail.style.top = top + 'px';
      rail.replaceChildren();
      for (let y = RAIL_STEP; y < term.rows; y += RAIL_STEP) {
        const t = document.createElement('div');
        t.className = 'ttl-tick';
        t.style.top = Math.round(y * cell) + 'px';
        rail.appendChild(t);
      }
    }

    const rows = [];
    if (b.type === 'normal') {
      const vy = b.viewportY;
      for (const m of marks) {
        if (m.marker.isDisposed) continue;
        const y = m.marker.line - vy;
        if (y < 0 || y >= term.rows) continue;
        rows.push({ y, ts: m.ts, kind: m.kind });
      }
    }
    // Подпись состояния: если ничего не изменилось (а onRender стреляет на каждый кадр вывода),
    // DOM не трогаем вовсе — иначе шкала мигала бы и жгла CPU при активном выводе.
    const sig = Math.round(top) + '|' + Math.round(cell * 100) + '|' + rows.map((r) => r.y + ':' + r.ts + ':' + r.kind).join(',');
    if (sig === lastHtml) return;
    lastHtml = sig;
    inner.style.top = top + 'px';
    inner.replaceChildren();
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'ttl-mark ' + r.kind;
      d.style.top = (r.y * cell) + 'px';
      d.style.height = cell + 'px';
      d.textContent = hhmm(r.ts);
      d.title = hhmmss(r.ts);
      inner.appendChild(d);
    }
  }

  function schedule() { if (on && !raf) raf = requestAnimationFrame(render); }

  // Выключенная шкала не делает НИЧЕГО: по умолчанию она выключена, и оплачивать её работу
  // (маркеры в буфере, разбор каждой порции) те, кто её не включал, не должны.
  const subs = [
    term.onWriteParsed(() => { if (!on) return; onOutput(); schedule(); }),
    term.onScroll(schedule),
    term.onRender(schedule),
    term.onResize(() => { lastHtml = null; schedule(); }),
  ];
  setAnchor();                                 // опора сразу на текущей строке: иначе первая
                                               // порция вывода уходила бы только на её установку
                                               // и самая первая засечка терялась
  return {
    // Enter в терминале: следующая строка вывода получит засечку «команда».
    markInput(data) { if (on && typeof data === 'string' && data.includes('\r')) pendingCmd = true; },
    setEnabled(next) {
      if (next === on) return;
      on = next;
      applyVisible();
      lastHtml = null;
      // Включили — начинаем отсчёт с текущей строки; выключили — отпускаем все маркеры.
      if (on) { setAnchor(); } else { dropMarkers(); inner.replaceChildren(); }
      if (onGeometry) onGeometry();            // ширина области вывода изменилась → пересчёт cols
      schedule();
    },
    setFontSize(fs) { applyFont(fs); lastHtml = null; schedule(); },
    // Терминал очистили (Ctrl+L / «Очистить») — старые засечки указывают в пустоту.
    // Зовётся ПОСЛЕ term.clear()/term.reset(), которые гасят маркеры сами, — поэтому опору
    // здесь ставим заново, иначе потерялась бы первая засечка после очистки.
    reset() {
      dropMarkers();
      lastMarkTs = 0; lastOutputAt = 0; pendingCmd = false;
      lastHtml = null;
      inner.replaceChildren();
      setAnchor();
      schedule();
    },
    dispose() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      on = false;
      for (const s of subs) { try { s.dispose(); } catch (_) {} }
      dropMarkers();
      root.remove();
      if (term.element) term.element.style.paddingLeft = '';
      if (posPatched) { container.style.position = ''; posPatched = false; }
    },
  };
}
