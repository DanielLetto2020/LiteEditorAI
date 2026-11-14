// Планировщик вкладок проекта при первом открытии (ensureProjectTabs).
// Вычисляет, какие сохранённые вкладки должны материализоваться сразу (xterm + node-pty),
// а какие остаться легковесными отложенными записями до первого переключения на них,
// и в какую именно вкладку должен вооружаться автоввод (termPrefill).

/**
 * @typedef {{ names?: unknown, custom?: unknown, active?: unknown, split?: unknown }} SavedProjTabs
 * @typedef {{ name: string, customName: boolean, eager: boolean, prefill: boolean }} PlannedTab
 */

/**
 * @param {SavedProjTabs | null | undefined} saved
 * @param {string} [fallbackName]
 * @returns {{ activeIndex: number, splitIndices: [number, number] | null, tabs: PlannedTab[] }}
 */
export function planProjectTabs(saved, fallbackName = 'Терминал 1') {
  const rawNames = saved && Array.isArray(saved.names) && saved.names.length ? saved.names : [fallbackName];
  const rawCustom = saved && Array.isArray(saved.custom) ? saved.custom : [];
  const count = rawNames.length;

  const rawActive = saved && Number.isInteger(saved.active) ? /** @type {number} */ (saved.active) : 0;
  const activeIndex = Math.max(0, Math.min(rawActive, count - 1));

  /** @type {[number, number] | null} */
  let splitIndices = null;
  if (saved && Array.isArray(saved.split) && saved.split.length === 2) {
    const [i0, i1] = saved.split;
    if (
      Number.isInteger(i0) && Number.isInteger(i1)
      && i0 >= 0 && i0 < count
      && i1 >= 0 && i1 < count
      && i0 !== i1
    ) {
      splitIndices = [i0, i1];
    }
  }

  const eagerSet = new Set([activeIndex]);
  if (splitIndices) {
    eagerSet.add(splitIndices[0]);
    eagerSet.add(splitIndices[1]);
  }

  /** @type {PlannedTab[]} */
  const tabs = rawNames.map((n, i) => {
    const str = typeof n === 'string' && n.trim() ? n : fallbackName;
    return {
      name: str,
      customName: !!rawCustom[i],
      eager: eagerSet.has(i),
      prefill: i === activeIndex,
    };
  });

  return { activeIndex, splitIndices, tabs };
}
