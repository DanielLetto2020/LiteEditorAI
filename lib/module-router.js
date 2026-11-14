// Единый маршрутизатор готовности модулей (окон и встроенных WebFrameMain-доков)
// и ленивый загрузчик доменных IPC-групп для главного процесса Electron.
// Модуль не зависит от 'electron', поэтому покрывается чистыми юнит-тестами Node.

'use strict';

/**
 * @typedef {object} QueuedMessage
 * @property {string} channel
 * @property {any} payload
 * @property {boolean} focus
 */

/**
 * Создаёт единый маршрутизатор доставки событий и стартовых аргументов в окна модулей / док-фреймы.
 * Заменяет разрозненные пары `xxxPanelReady` + `pendingXxxOpens` единой очередью с гарантией порядка,
 * защитой от переполнения и прозрачной поддержкой как `BrowserWindow`, так и `WebFrameMain`.
 *
 * @param {object} cfg
 * @param {(modId: string) => void} [cfg.ensureTarget] открыть окно или показать док, если его ещё нет
 * @param {(modId: string) => any} cfg.getTarget вернуть живой таргет (BrowserWindow или WebFrameMain) либо null
 * @param {(target: any, channel: string, payload: any) => boolean} cfg.sendToTarget безопасная отправка в таргет
 * @param {(target: any) => void} [cfg.focusTarget] развернуть из минимизации и сфокусировать окно
 */
function createModuleRouter(cfg) {
  const ensureTarget = cfg && typeof cfg.ensureTarget === 'function' ? cfg.ensureTarget : () => {};
  const getTarget = cfg && typeof cfg.getTarget === 'function' ? cfg.getTarget : () => null;
  const sendToTarget = cfg && typeof cfg.sendToTarget === 'function' ? cfg.sendToTarget : () => false;
  const focusTarget = cfg && typeof cfg.focusTarget === 'function' ? cfg.focusTarget : null;

  /** @type {Set<string>} */
  const readyMods = new Set();
  /** @type {Map<string, QueuedMessage[]>} */
  const queues = new Map();
  /** @type {Map<string, any>} */
  const pendingArgs = new Map();

  /**
   * Доставить стартовый параметр открытия окна (`module:arg`) сразу (если окно уже подписалось)
   * или запомнить последний параметр до прихода `module:ready`.
   * @param {string} modId
   * @param {any} arg
   * @param {any} [liveReadyTarget] живое окно с флагом `__modReady`, если уже открыто
   */
  function deliverArg(modId, arg, liveReadyTarget) {
    if (arg == null) return;
    if (liveReadyTarget && sendToTarget(liveReadyTarget, 'module:arg', arg)) {
      pendingArgs.delete(modId);
      return;
    }
    pendingArgs.set(modId, arg);
  }

  /**
   * Выдать отложенный `module:arg` окну при получении от него `module:ready`.
   * @param {string} modId
   * @param {any} target
   */
  function consumeArg(modId, target) {
    if (!pendingArgs.has(modId)) return false;
    const arg = pendingArgs.get(modId);
    pendingArgs.delete(modId);
    return sendToTarget(target, 'module:arg', arg);
  }

  /**
   * Отправить сообщение модулю: если панель уже прислала сигнал готовности и жива — уходит немедленно;
   * иначе открывает модуль через `ensureTarget` и ставит сообщение в очередь до `markReady(modId)`.
   *
   * @param {string} modId
   * @param {string} channel
   * @param {any} [payload]
   * @param {object} [opts]
   * @param {boolean} [opts.focus] сфокусировать таргет при доставке (по умолчанию false)
   * @param {number} [opts.maxQueue] лимит очереди ожидания на модуль (по умолчанию 100)
   * @param {boolean} [opts.dedupe] не дублировать в очереди уже ожидающий вызов того же канала
   * @param {boolean} [opts.ensure] вызывать ли `ensureTarget(modId)` перед проверкой (по умолчанию true)
   */
  function sendWhenReady(modId, channel, payload, opts = {}) {
    const focus = !!opts.focus;
    const maxQueue = Math.max(1, Number(opts.maxQueue) || 100);
    if (opts.ensure !== false) ensureTarget(modId);

    if (readyMods.has(modId)) {
      const target = getTarget(modId);
      if (target) {
        if (focus && focusTarget) focusTarget(target);
        if (sendToTarget(target, channel, payload)) return true;
      }
      readyMods.delete(modId);
    }

    let q = queues.get(modId);
    if (!q) { q = []; queues.set(modId, q); }
    if (opts.dedupe && q.some((it) => it.channel === channel)) return false;
    q.push({ channel, payload, focus });
    while (q.length > maxQueue) q.shift();
    return false;
  }

  /**
   * Пометить панель модуля готовой и синхронно выгрузить накопленную очередь в порядке поступления.
   * @param {string} modId
   * @param {any} [overrideTarget] явный таргет для флаша (например только что подключившийся док-фрейм)
   */
  function markReady(modId, overrideTarget) {
    readyMods.add(modId);
    const q = queues.get(modId);
    if (!q || !q.length) return 0;
    const target = overrideTarget || getTarget(modId);
    if (!target) return 0;
    let sent = 0;
    while (q.length) {
      const item = q.shift();
      if (!item) continue;
      if (item.focus && focusTarget) focusTarget(target);
      if (sendToTarget(target, item.channel, item.payload)) sent++;
    }
    return sent;
  }

  /**
   * Сбросить флаг готовности модуля (при закрытии окна или откреплении дока).
   * @param {string} modId
   * @param {{ clearArg?: boolean, clearQueue?: boolean }} [opts]
   */
  function markNotReady(modId, opts = {}) {
    readyMods.delete(modId);
    if (opts.clearArg !== false) pendingArgs.delete(modId);
    if (opts.clearQueue) queues.delete(modId);
  }

  /** @param {string} modId */
  function isReady(modId) { return readyMods.has(modId); }

  /** @param {string} modId */
  function pendingCount(modId) { const q = queues.get(modId); return q ? q.length : 0; }

  return {
    deliverArg,
    consumeArg,
    sendWhenReady,
    markReady,
    markNotReady,
    isReady,
    pendingCount,
  };
}

/**
 * Ленивая регистрация тяжёлого IPC-бэкенда: при старте процесса вешает только легковесные прокси-обработчики
 * на перечисленные каналы, а сам `load(collectorIpc)` (вместе с `require()` драйверов БД, брокеров, S3 и т.д.)
 * вызывается ровно один раз при первом реальном обращении рендерера к любому из каналов группы.
 *
 * @template TApi
 * @param {{ handle: (ch: string, fn: (...a: any[]) => any) => void, on: (ch: string, fn: (...a: any[]) => any) => void }} ipcMain
 * @param {object} spec
 * @param {string[]} [spec.handles] список каналов `ipcMain.handle`
 * @param {string[]} [spec.ons] список каналов `ipcMain.on`
 * @param {(ipc: any) => TApi} spec.load
 */
function createLazyIpc(ipcMain, spec) {
  const handleNames = Array.isArray(spec.handles) ? spec.handles : [];
  const onNames = Array.isArray(spec.ons) ? spec.ons : [];
  const loadFn = spec.load;

  let loaded = false;
  /** @type {TApi | null} */
  let api = null;
  /** @type {Map<string, (...a: any[]) => any>} */
  const handles = new Map();
  /** @type {Map<string, (...a: any[]) => any>} */
  const ons = new Map();

  function ensure() {
    if (!loaded) {
      loaded = true;
      const collector = {
        handle(ch, fn) { handles.set(ch, fn); },
        on(ch, fn) { ons.set(ch, fn); },
      };
      api = loadFn(collector);
    }
    return { handles, ons, api };
  }

  for (const ch of handleNames) {
    ipcMain.handle(ch, (event, ...args) => {
      const g = ensure();
      const fn = g.handles.get(ch);
      if (!fn) throw new Error(`Lazy IPC handler not registered after load: ${ch}`);
      return fn(event, ...args);
    });
  }

  for (const ch of onNames) {
    ipcMain.on(ch, (event, ...args) => {
      const g = ensure();
      const fn = g.ons.get(ch);
      if (fn) return fn(event, ...args);
    });
  }

  return {
    isLoaded: () => loaded,
    getApi: () => (loaded ? api : null),
    ensure: () => ensure().api,
  };
}

module.exports = { createModuleRouter, createLazyIpc };
