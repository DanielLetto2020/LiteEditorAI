// Синхронизация ключа settings между окнами (редактор + окна модулей).
//
// Зачем: settings пишут несколько окон, и раньше каждое писало объект ЦЕЛИКОМ из своей копии,
// снятой при открытии окна. Побеждала последняя запись: модуль «Задачи» переключал вид на канбан,
// потом Ctrl+= в редакторе записывал settings без этого поля — и вид сбрасывался. Смену языка main
// пишет сам (i18n:set), а копия редактора оставалась со старым lang: смена темы после смены
// языка возвращала русский после перезапуска.
//
// Как теперь: окно отправляет только ИЗМЕНЁННЫЕ поля (store:patch) — разницу между своим объектом
// и тем, что оно последним знало о диске. main вливает патч в файл и рассылает его остальным окнам
// (store:changed), те применяют его к своему объекту. Логика модулей не меняется: они по-прежнему
// правят объект settings и зовут saveSettings().
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * @param {any} lite            window.lite
 * @param {Record<string, any>} settings  живой объект настроек окна (его и правят модули)
 * @param {{ base?: Record<string, any> | null, onRemote?: (msg: { set: Record<string, any>, unset: string[] }) => void }} [opts]
 *   base — что лежит на диске сейчас (снапшот стора). У редактора settings = дефолты + base, поэтому
 *   первый save запишет и дефолты — как раньше, когда объект уходил целиком.
 */
export function syncSettings(lite, settings, { base = null, onRemote = null } = {}) {
  const known = clone(base || {}) || {};
  function save() {
    const set = {};
    const unset = [];
    for (const k of Object.keys(settings)) if (!same(settings[k], known[k])) set[k] = clone(settings[k]);
    for (const k of Object.keys(known)) if (!has(settings, k)) unset.push(k);
    if (!Object.keys(set).length && !unset.length) return false;
    Object.assign(known, clone(set));
    for (const k of unset) delete known[k];
    lite.store.patch('settings', set, unset);
    return true;
  }
  try {
    lite.store.onChanged((msg) => {
      if (!msg || msg.key !== 'settings') return;
      const set = msg.set || {};
      const unset = Array.isArray(msg.unset) ? msg.unset : [];
      for (const k of Object.keys(set)) { settings[k] = clone(set[k]); known[k] = clone(set[k]); }
      for (const k of unset) { delete settings[k]; delete known[k]; }
      if (onRemote) { try { onRemote({ set, unset }); } catch (_) {} }
    });
  } catch (_) {}
  return { save };
}
