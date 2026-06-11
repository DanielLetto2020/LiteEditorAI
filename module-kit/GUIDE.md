# LiteEditor — руководство по созданию модулей (API v1)

Этот документ — полная самодостаточная спецификация для разработки пользовательского модуля
LiteEditor. Он написан в первую очередь для ИИ-агентов (Claude Code, Codex и др.): здесь есть
всё необходимое — схема манифеста, точные сигнатуры API, правила оформления и полный рабочий
пример. Ходить за дополнительной информацией никуда не нужно.

## Что такое модуль

Модуль — это панель, открывающаяся в правом слоте редактора (как встроенные Git, Базы данных,
Контейнеры). В правом слоте одновременно открыта **одна** панель — это закон UX редактора,
модуль его не обходит. Модуль может быть привязан к активному проекту (через подписку), а может
быть полностью независимым (калькулятор, заметки, интеграция со сторонним сервисом).

Технически модуль — это ES-модуль JavaScript, который редактор загружает в рантайме через
динамический `import()`. Никакой сборки со стороны редактора нет: один файл `index.js` со всеми
зависимостями внутри (если нужны библиотеки — автор бандлит их в свой файл сам, например esbuild:
`esbuild src.js --bundle --format=esm --outfile=index.js`).

**Модель доверия:** модуль исполняется в основном окне редактора без песочницы. Установка
модуля = доверие его коду, как установка любой программы. Поле `capabilities` манифеста —
честная декларация того, что модуль делает (показывается пользователю), а не техническое
ограничение.

## Куда ставится

```
~/.LiteEditorAI/modules/<id>/
  manifest.json     ← обязательный
  index.js          ← обязательный (имя можно сменить полем main)
```

Путь одинаков на всех ОС: Linux/macOS — `~/.LiteEditorAI/modules/`,
Windows — `C:\Users\<имя>\.LiteEditorAI\modules\`.
**Имя папки обязано совпадать с `id` из манифеста.**

После добавления/правки файлов модуль подхватывается через меню
«Модули → Пересканировать» (или «Перезагрузить» у конкретного модуля) — перезапуск редактора
не нужен.

## manifest.json

```json
{
  "id": "calculator",
  "name": "Калькулятор",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "index.js",
  "description": "Простой калькулятор с историей вычислений",
  "author": "",
  "repo": "",
  "icon": "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 4v3h10V6H7zm0 5v2h2v-2H7zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2zm-8 4v2h2v-2H7zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2z",
  "capabilities": []
}
```

| Поле          | Обязательное | Описание |
|---------------|--------------|----------|
| `id`          | да | Уникальный идентификатор: только `a-z`, `0-9`, `-`. Совпадает с именем папки. |
| `name`        | да | Человекочитаемое имя — заголовок панели и пункт меню «Модули». |
| `version`     | да | Semver-версия самого модуля. |
| `apiVersion`  | да | Версия API редактора, под которую написан модуль. Сейчас — `1`. При несовместимости редактор не загрузит модуль и объяснит почему. |
| `main`        | нет | Точка входа, по умолчанию `index.js`. |
| `description` | нет | Одно предложение — показывается в списке модулей. |
| `author`, `repo` | нет | Автор и URL репозитория (нужны для будущего каталога). |
| `icon`        | нет | SVG-path (viewBox 24×24, заливка currentColor) для меню. Без него — иконка по умолчанию. |
| `capabilities`| нет | Декларация возможностей. В API v1 список пуст — модулям не выдаются привилегии; поле зарезервировано. |

## index.js — контракт жизненного цикла

```js
export function activate(ctx) {
  // вызывается ОДИН раз при загрузке модуля (включение тумблера / старт редактора).
  // Здесь строится UI внутри ctx.panel.element и вешаются подписки.
}

export function deactivate() {
  // вызывается при выключении/перезагрузке модуля.
  // ОБЯЗАН убрать за собой: clearInterval/clearTimeout, отписки, внешние ресурсы.
  // DOM панели редактор удаляет сам — чистить его не нужно.
}
```

Оба экспорта обязательны. `activate` может быть `async`. Ошибка, выброшенная из `activate`,
не роняет редактор: модуль помечается сломанным, пользователь видит сообщение.

## API: объект ctx (v1)

Единственная точка доступа к редактору. Глобальных API нет: `window.lite` и внутренние
модули редактора трогать запрещено (см. «Правила»).

```js
ctx.api          // number — версия API редактора (1)
ctx.id           // string — id вашего модуля

// ---- Панель (правый слот) ------------------------------------------------
ctx.panel.element        // HTMLElement — корневой контейнер ВАШЕГО UI (тело панели).
                         // Заголовок с именем и кнопкой закрытия рисует редактор.
ctx.panel.setTitle(text) // сменить заголовок панели (по умолчанию — name из манифеста)
ctx.panel.open()         // открыть панель (остальные панели слота закроются сами)
ctx.panel.close()        // закрыть панель
ctx.panel.isOpen()       // boolean
ctx.panel.onClose(fn)    // fn() при закрытии панели пользователем (это НЕ deactivate —
                         // модуль остаётся загруженным); возвращает функцию отписки

// ---- UI-хелперы (нативный вид редактора) ----------------------------------
ctx.ui.el(tag, cls, text)            // → HTMLElement; cls и text необязательны
ctx.ui.icon(name, size = 16)         // → SVG-элемент встроенной иконки
ctx.ui.iconBtn(cls, name, title, size) // → <button class=cls> с SVG-иконкой и tooltip.
                                     //   Для нативного вида передавайте cls='icon-btn'
                                     //   (иначе кнопка получит дефолтный белый фон браузера).
ctx.ui.toast(msg, opts)              // всплывашка; opts: { kind: 'error', actionLabel, action }
ctx.ui.makeModal(innerHtml, onClose) // → { overlay, m, close } — модальное окно;
                                     //   закрытие по клику мимо и по Escape уже встроено
ctx.ui.showConfirm(title, text, yesLabel, onYes, altLabel?, onAlt?) // диалог подтверждения
ctx.ui.showPrompt(title, label, initial, onOk) // ввод строки; onOk(v) может вернуть
                                     //   { error: 'текст' }, чтобы не закрывать диалог
// Имена встроенных иконок (ctx.ui.icon / iconBtn): star pencil eye note git folder palette
// archive x plus refresh save diff maximize terminal columns eraser trash search check
// download upload sliders grid copy play warning file globe clipboard chat key stop pause
// box layers database power flag

// ---- Хранилище (персист между запусками) -----------------------------------
ctx.storage.get(key, def)   // прочитать значение (или def, если нет)
ctx.storage.set(key, value) // сохранить (value — любой JSON-сериализуемый)
ctx.storage.all()           // объект со всеми ключами модуля
// Данные изолированы по id модуля: чужие ключи недоступны, ваши — не конфликтуют с чужими.

// ---- Проекты (только чтение) ------------------------------------------------
ctx.projects.list()       // → [{ id, name, path }]
ctx.projects.activeId()   // → string | null
ctx.projects.onChange(fn) // fn(activeId) при смене активного проекта; → функция отписки

// ---- Команды (палитра Ctrl+K) -----------------------------------------------
ctx.commands.register(title, fn) // добавить команду в палитру; → функция удаления команды

// ---- Тема ---------------------------------------------------------------------
ctx.theme.current()   // → имя активной темы
ctx.theme.onChange(fn) // fn(name) при смене темы; → функция отписки
```

Чего в API v1 **нет** (и не пытайтесь достать обходом): терминалы/PTY, файловая система,
сеть от имени редактора, `window.lite`. Сетевые запросы со своей стороны (обычный `fetch`
к внешним API) модулю доступны — задекларируйте это строкой `"network"` в `capabilities`.

## Правила оформления (обязательные)

1. **Только CSS-токены тем.** Никаких хардкод-цветов/теней/радиусов (`#fff`, `red`,
   `box-shadow: ...px #000`) — модуль обязан выглядеть нативно в любой из тем редактора.
   Используйте `var(--токен)` в инлайн-стилях или в своём `<style>`-блоке, добавленном
   внутрь `ctx.panel.element`. Доступные токены:

   | Группа | Токены |
   |--------|--------|
   | Акцент | `--green` `--green-bright` `--green-dim` `--accent-soft` `--border-accent` `--accent-contrast` `--accent-glow` |
   | Поверхности | `--bg` `--bar` `--panel` `--panel-solid` `--surface` `--surface-2` `--bg-input` `--bg-pop` `--modal` `--ink` `--ink-2` |
   | Линии | `--border` `--border-strong` `--app-border` |
   | Текст | `--text` `--text-dim` `--text-mute` |
   | Hover | `--hover` `--hover-2` |
   | Статус | `--danger` `--warn` `--info` `--add` `--star` |
   | Форма/тени | `--radius` `--card-shadow` `--card-active-bg` `--card-active-shadow` |

   Типовые связки: текст — `var(--text)`, второстепенный — `var(--text-dim)`, фон поля ввода —
   `var(--bg-input)`, рамка — `1px solid var(--border)`, скругление — `var(--radius)`,
   кнопки/карточки — класс `btn` или фон `var(--surface)`.

2. **DOM — только внутри `ctx.panel.element`** (плюс модалки через `ctx.ui.makeModal`).
   Лазить в документ за пределами своей панели — нарушение контракта: сегодня сработает,
   в следующем релизе сломается без предупреждения.

3. **Селекторы стилей — с префиксом.** Если добавляете `<style>`, все правила начинайте
   с класса вида `.ext-<id> ...` (и повесьте этот класс на свой корневой элемент), чтобы
   не зацепить чужой UI.

4. **`deactivate()` убирает всё**, что пережило бы выгрузку: таймеры, подписки
   (`onChange`/`onClose`/`register` возвращают функции отписки — сохраните и вызовите их),
   WebSocket'ы и т.п. Это делает включение/выключение/перезагрузку мгновенными.

5. **Зависимости — внутрь `index.js`.** Редактор не выполняет `npm install` и не резолвит
   `import 'lodash'`. Либо ванильный JS, либо предварительный бандл в один файл.

6. **Никаких обращений к интернету без декларации** `"network"` в `capabilities`.

## Типичные ошибки

- **`eval()` и `new Function()` НЕ РАБОТАЮТ** — CSP редактора не содержит `'unsafe-eval'`,
  любой такой вызов бросит `EvalError`. Вычисления/парсинг пишите обычным кодом
  (пример безопасного парсера выражений — в калькуляторе ниже).
- Захардкоженный цвет → модуль уродует половину тем. Всегда `var(--токен)`.
- Забытая отписка в `deactivate` → после перезагрузки модуля колбэки срабатывают дважды.
- `id` в манифесте не совпадает с именем папки → модуль не загрузится.
- Попытка `import` внешнего пакета по имени → в рантайме резолвить нечем; бандлите заранее.
- Тяжёлая работа прямо в `activate` → панель «зависает» при включении. Стройте UI сразу,
  данные подгружайте асинхронно после.
- Обращение к `window.lite` или DOM редактора → работает до первого обновления редактора.

## Полный пример: калькулятор с историей

`~/.LiteEditorAI/modules/calculator/manifest.json` — см. раздел «manifest.json» выше (как есть).

`~/.LiteEditorAI/modules/calculator/index.js`:

```js
// Калькулятор: кнопочная сетка, живой предпросмотр результата, история (ctx.storage).
// Выражения считает собственный мини-парсер (рекурсивный спуск) — eval()/new Function()
// в редакторе ЗАБЛОКИРОВАНЫ CSP ('unsafe-eval' нет), вычисления пишутся кодом.
let unsubs = []; // все отписки — для deactivate

// + - * / % ( ), унарный минус, десятичные с точкой или запятой
function calcEval(src) {
  const s = String(src).replace(/,/g, '.').replace(/[\s_]+/g, '');
  if (!s) throw new Error('пусто');
  let i = 0;
  const num = () => {
    const m = /^\d*\.?\d+/.exec(s.slice(i));
    if (!m) throw new Error('ожидалось число');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = () => {
    if (s[i] === '-') { i++; return -factor(); }
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '(') {
      i++;
      const v = expr();
      if (s[i] !== ')') throw new Error('нет закрывающей скобки');
      i++;
      return v;
    }
    return num();
  };
  const term = () => {
    let v = factor();
    while (s[i] === '*' || s[i] === '/' || s[i] === '%') {
      const op = s[i++], r = factor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const expr = () => {
    let v = term();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++], r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  if (i < s.length) throw new Error('лишний символ «' + s[i] + '»');
  if (!Number.isFinite(v)) throw new Error('деление на ноль');
  return v;
}
const fmt = (v) => String(parseFloat(v.toFixed(10))); // срезаем хвосты двоичной арифметики

export function activate(ctx) {
  const { el, iconBtn } = ctx.ui;
  const root = el('div', 'ext-calculator');
  root.innerHTML = `
    <style>
      .ext-calculator { display:flex; flex-direction:column; gap:10px; padding:14px;
        color:var(--text); height:100%; box-sizing:border-box; }
      .ext-calculator .calc-in { background:var(--bg-input); color:var(--text);
        border:1px solid var(--border); border-radius:var(--radius); padding:10px 14px;
        font:inherit; font-size:16px; outline:none; text-align:right; }
      .ext-calculator .calc-in:focus { border-color:var(--border-accent); }
      .ext-calculator .calc-res { min-height:34px; font-size:24px; text-align:right;
        padding:0 6px; color:var(--text-dim); transition:color .15s; }
      .ext-calculator .calc-res.ok { color:var(--green-bright); }
      .ext-calculator .calc-res.err { color:var(--danger); font-size:13px; }
      .ext-calculator .calc-pad { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
      .ext-calculator .calc-btn { border:1px solid var(--border); border-radius:var(--radius);
        background:var(--surface); color:var(--text); font:inherit; font-size:16px;
        padding:10px 0; cursor:pointer; }
      .ext-calculator .calc-btn:hover { background:var(--hover-2); }
      .ext-calculator .calc-btn:active { background:var(--card-active-bg); box-shadow:var(--card-active-shadow); }
      .ext-calculator .calc-btn.op { color:var(--green-bright); background:var(--accent-soft); border-color:var(--border-accent); }
      .ext-calculator .calc-btn.danger { color:var(--danger); }
      .ext-calculator .calc-btn.eq { grid-column:1 / -1; background:var(--green); color:var(--accent-contrast); font-weight:700; border-color:var(--border-accent); }
      .ext-calculator .calc-hist-head { display:flex; align-items:center; margin-top:4px; }
      .ext-calculator .calc-hist-title { flex:1; font-size:11px; letter-spacing:.08em;
        text-transform:uppercase; color:var(--text-mute); }
      .ext-calculator .calc-hist { flex:1; min-height:0; overflow:auto; display:flex;
        flex-direction:column; gap:6px; }
      .ext-calculator .calc-row { display:flex; gap:8px; background:var(--surface);
        border:1px solid var(--border); border-radius:var(--radius); padding:6px 12px;
        cursor:pointer; font-size:13px; }
      .ext-calculator .calc-row:hover { background:var(--hover); }
      .ext-calculator .calc-row .ce { flex:1; color:var(--text-dim); overflow:hidden;
        text-overflow:ellipsis; white-space:nowrap; }
      .ext-calculator .calc-row .cv { color:var(--green-bright); font-weight:600; }
      .ext-calculator .calc-empty { color:var(--text-mute); font-size:12px; padding:4px 6px; }
    </style>
    <input class="calc-in" type="text" placeholder="0" spellcheck="false" autocomplete="off">
    <div class="calc-res"></div>
    <div class="calc-pad"></div>
    <div class="calc-hist-head"><span class="calc-hist-title">История</span></div>
    <div class="calc-hist"></div>`;
  ctx.panel.element.appendChild(root);

  const input = root.querySelector('.calc-in');
  const res = root.querySelector('.calc-res');
  const pad = root.querySelector('.calc-pad');
  const histBox = root.querySelector('.calc-hist');
  let history = ctx.storage.get('history', []); // [{expr, value}] — новые в начале

  const saveHist = () => ctx.storage.set('history', history.slice(0, 30));
  const renderHist = () => {
    histBox.innerHTML = '';
    if (!history.length) { histBox.appendChild(el('div', 'calc-empty', 'Пока пусто — посчитайте что-нибудь.')); return; }
    for (const h of history) {
      const row = el('div', 'calc-row');
      row.appendChild(el('span', 'ce', h.expr + ' ='));
      row.appendChild(el('span', 'cv', h.value));
      row.onclick = () => { input.value = h.expr; preview(); input.focus(); };
      histBox.appendChild(row);
    }
  };
  const clearBtn = iconBtn('icon-btn', 'trash', 'Очистить историю');
  clearBtn.addEventListener('click', () => { history = []; saveHist(); renderHist(); });
  root.querySelector('.calc-hist-head').appendChild(clearBtn);

  const preview = () => { // живой предпросмотр, ошибки молча гасим до «=»
    const v = input.value.trim();
    res.className = 'calc-res';
    if (!v) { res.textContent = ''; return; }
    try { res.textContent = '= ' + fmt(calcEval(v)); } catch (_) { res.textContent = '…'; }
  };
  const commit = () => {
    const v = input.value.trim();
    if (!v) return;
    try {
      const value = fmt(calcEval(v));
      res.className = 'calc-res ok';
      res.textContent = '= ' + value;
      history = [{ expr: v, value }, ...history.filter((h) => h.expr !== v)].slice(0, 30);
      saveHist(); renderHist();
    } catch (e) {
      res.className = 'calc-res err';
      res.textContent = '⚠ ' + e.message;
    }
  };

  // кнопочная сетка: подпись → действие/символ (÷ × − показываем красиво, считаем как / * -)
  const KEYS = ['C', '(', ')', '⌫', '7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '.', '%', '+', '='];
  const CHAR = { '÷': '/', '×': '*', '−': '-' };
  for (const k of KEYS) {
    const b = el('button', 'calc-btn', k);
    if (k === '=') b.classList.add('eq');
    else if (k === 'C' || k === '⌫') b.classList.add('danger');
    else if ('÷×−+%()'.includes(k)) b.classList.add('op');
    b.addEventListener('click', () => {
      if (k === 'C') { input.value = ''; preview(); }
      else if (k === '⌫') { input.value = input.value.slice(0, -1); preview(); }
      else if (k === '=') commit();
      else { input.value += (CHAR[k] || k); preview(); }
      if (k !== '=') input.focus();
    });
    pad.appendChild(b);
  }
  input.addEventListener('input', preview);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  renderHist();

  unsubs.push(ctx.commands.register('Калькулятор: открыть', () => ctx.panel.open()));
  setTimeout(() => input.focus(), 50);
}

export function deactivate() {
  for (const u of unsubs) { try { u(); } catch {} }
  unsubs = [];
}
```

Этот же пример лежит рабочим кодом в `module-kit/examples/calculator/` — он и спецификация
обязаны совпадать.

## Чеклист готовности модуля

- [ ] Папка `~/.LiteEditorAI/modules/<id>/`, `id` = имя папки.
- [ ] `manifest.json` с обязательными полями, `apiVersion: 1`.
- [ ] `index.js` экспортирует `activate(ctx)` и `deactivate()`.
- [ ] Все цвета/тени/радиусы — через `var(--токен)`.
- [ ] Свои стили — под префиксом `.ext-<id>`.
- [ ] `deactivate` вызывает все сохранённые отписки.
- [ ] Сторонние библиотеки вбандлены в `index.js` (если есть).
- [ ] `capabilities` честно отражает, что модуль делает.
- [ ] Проверено: «Модули → Пересканировать» → модуль появился, открывается, переключение
      темы не ломает вид, выкл/вкл тумблером работает без перезапуска редактора.
