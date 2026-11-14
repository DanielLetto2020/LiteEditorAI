// Мультибуферное ядро редактора «Проект» (BufferPool + вкладки + группы Primary/Split + история позиций).
// Чистая логика без прямого обращения к DOM — тестируется напрямую в Node (test/viewer-ide.test.js).

export function isVirtualTab(id) {
  if (!id) return false;
  const s = String(id);
  return s.startsWith('diff:') || s.startsWith('cdiff:') || s.startsWith('sdiff:') || s.startsWith('rawdiff:') || s.startsWith('cmp:');
}

export const isVirtualTabId = isVirtualTab;

export function eolOfText(s) {
  const str = String(s || '');
  const crlf = (str.match(/\r\n/g) || []).length;
  return crlf && crlf * 2 >= (str.match(/\n/g) || []).length ? '\r\n' : '\n';
}

export function normEolText(s) {
  return String(s || '').replace(/\r\n?/g, '\n');
}

export function toDiskEol(text, eol) {
  const norm = normEolText(text);
  return eol === '\r\n' ? norm.replace(/\n/g, '\r\n') : norm;
}

export function detectIndentSpec(text) {
  const lines = String(text || '').split('\n', 4000);
  let tabs = 0, spaces = 0, prev = 0;
  const steps = new Map();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    if (ln[0] === '\t') { tabs++; continue; }
    const n = ln.length - ln.trimStart().length;
    if (n) spaces++;
    const d = Math.abs(n - prev);
    if (d >= 2 && d <= 8) steps.set(d, (steps.get(d) || 0) + 1);
    prev = n;
  }
  if (tabs > spaces && tabs > 0) {
    return { useTabs: true, tabSize: 4, size: 4, unit: '\t' };
  }
  let best = 0, bestN = 0;
  for (const [d, n] of steps) if (n > bestN) { best = d; bestN = n; }
  const sz = best || 2;
  return { useTabs: false, tabSize: sz, size: sz, unit: ' '.repeat(sz) };
}

export function convertIndentation(text, targetOrUseTabs, targetSize = 2, currentSize = 0) {
  let useTabs = false;
  let step = 2;
  if (targetOrUseTabs && typeof targetOrUseTabs === 'object') {
    useTabs = !!targetOrUseTabs.useTabs;
    step = Math.max(1, targetOrUseTabs.tabSize || targetOrUseTabs.size || 2);
  } else {
    useTabs = !!targetOrUseTabs;
    step = Math.max(1, targetSize || 2);
  }
  const detected = currentSize > 0 ? currentSize : (detectIndentSpec(text).tabSize || 2);
  const srcStep = Math.max(1, detected);

  return String(text || '').split('\n').map((line) => {
    const m = line.match(/^[ \t]+/);
    if (!m) return line;
    const lead = m[0];
    let cols = 0;
    for (const ch of lead) cols += ch === '\t' ? srcStep : 1;
    const rest = line.slice(lead.length);
    if (useTabs) {
      const tCount = Math.floor(cols / step);
      const rem = cols % step;
      return '\t'.repeat(tCount) + ' '.repeat(rem) + rest;
    }
    const levels = Math.round(cols / srcStep);
    return ' '.repeat(levels * step) + rest;
  }).join('\n');
}

function normSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

function pathInside(child, parent) {
  if (!child || !parent) return false;
  const c = normSlash(child);
  const p = normSlash(parent).replace(/\/+$/, '');
  if (c === p) return true;
  return c.startsWith(p + '/');
}

function createGroup(id) {
  return {
    id,
    tabs: [],
    pinned: new Set(),
    previewTab: null,
    active: null,
    mru: [],
  };
}

export function createBufferPool() {
  const buffers = new Map();       // tabId -> BufferRecord
  const groups = {
    primary: createGroup('primary'),
    split: createGroup('split'),
  };
  let activeGroup = 'primary';
  const recentList = [];
  let navStack = [];               // [{ group, tabId, line, col }]
  let navIdx = -1;
  let navJumping = false;

  function getGroup(gid = activeGroup) {
    return groups[gid === 'split' ? 'split' : 'primary'];
  }

  function keepPinsFirst(g) {
    if (!g.pinned.size) return;
    const pins = g.tabs.filter((id) => g.pinned.has(id));
    const rest = g.tabs.filter((id) => !g.pinned.has(id));
    g.tabs = [...pins, ...rest];
  }

  function touchMru(g, id) {
    if (!id) return;
    const i = g.mru.indexOf(id);
    if (i >= 0) g.mru.splice(i, 1);
    g.mru.unshift(id);
  }

  function addRecent(filePath) {
    if (!filePath || isVirtualTab(filePath)) return;
    const i = recentList.indexOf(filePath);
    if (i >= 0) recentList.splice(i, 1);
    recentList.unshift(filePath);
    if (recentList.length > 40) recentList.pop();
  }

  function isOpenAnywhere(tabId) {
    return groups.primary.tabs.includes(tabId) || groups.split.tabs.includes(tabId);
  }

  function pruneOrphanBuffer(tabId) {
    if (isOpenAnywhere(tabId)) return;
    const buf = buffers.get(tabId);
    if (buf && buf.dirty) return;
    buffers.delete(tabId);
  }

  function ensureBuffer(tabId, opts = {}) {
    let buf = buffers.get(tabId);
    const defaultTitle = opts.title || String(tabId).split(/[\\/]/).pop() || String(tabId);
    if (!buf) {
      buf = {
        id: tabId,
        kind: opts.kind || (isVirtualTab(tabId) ? 'diff' : 'file'),
        title: defaultTitle,
        path: opts.path !== undefined ? opts.path : (isVirtualTab(tabId) ? null : tabId),
        state: null,
        splitState: null,
        scrollTop: 0,
        scrollLeft: 0,
        splitScrollTop: 0,
        splitScrollLeft: 0,
        dirty: false,
        docEol: opts.docEol || '\n',
        diskBase: opts.diskBase ?? '',
        readOnly: !!opts.readOnly,
        indent: opts.indent || { useTabs: false, tabSize: 2, size: 2, unit: '  ' },
        langOverride: null,
        conflictOnDisk: false,
        viewMode: opts.viewMode || 'code',
        cursorLine: 1,
        cursorCol: 1,
        gitHunks: [],
        gitHeaderLines: [],
        meta: opts.meta || null,
      };
      buffers.set(tabId, buf);
    } else {
      if (opts.title !== undefined) buf.title = opts.title;
      if (opts.kind !== undefined) buf.kind = opts.kind;
      if (opts.path !== undefined) buf.path = opts.path;
      if (opts.viewMode !== undefined) buf.viewMode = opts.viewMode;
      if (opts.readOnly !== undefined) buf.readOnly = !!opts.readOnly;
      if (opts.meta !== undefined) buf.meta = opts.meta;
    }
    return buf;
  }

  // Поддерживает оба вызова:
  //   openTabInGroup('primary', tabId, opts)
  //   openTabInGroup(tabId, opts)
  function openTabInGroup(arg1, arg2, arg3) {
    let gid = activeGroup;
    let tabId;
    let opts;
    if ((arg1 === 'primary' || arg1 === 'split') && typeof arg2 === 'string') {
      gid = arg1;
      tabId = arg2;
      opts = arg3 || {};
    } else {
      tabId = arg1;
      opts = arg2 || {};
      if (opts.group) gid = opts.group;
    }

    const g = getGroup(gid);
    const exists = g.tabs.includes(tabId);
    const explicitPreview = opts.preview;
    const wantPreview = explicitPreview === true && !g.pinned.has(tabId);

    if (exists) {
      if (explicitPreview === false && g.previewTab === tabId) {
        g.previewTab = null;
      }
    } else if (wantPreview && g.previewTab && g.tabs.includes(g.previewTab) && !g.pinned.has(g.previewTab)) {
      const oldPrev = g.previewTab;
      const oldBuf = buffers.get(oldPrev);
      if (oldBuf && oldBuf.dirty) {
        g.previewTab = tabId;
        g.tabs.push(tabId);
      } else {
        const idx = g.tabs.indexOf(oldPrev);
        g.tabs.splice(idx, 1, tabId);
        const mi = g.mru.indexOf(oldPrev);
        if (mi >= 0) g.mru.splice(mi, 1);
        g.previewTab = tabId;
        pruneOrphanBuffer(oldPrev);
      }
    } else {
      g.tabs.push(tabId);
      if (wantPreview) g.previewTab = tabId;
    }

    keepPinsFirst(g);
    if (opts.activate !== false) {
      g.active = tabId;
      touchMru(g, tabId);
    }
    if (!isVirtualTab(tabId)) addRecent(tabId);
    return g;
  }

  function promotePreview(tabId, gid) {
    for (const g of gid ? [getGroup(gid)] : [groups.primary, groups.split]) {
      if (g.previewTab === tabId) g.previewTab = null;
    }
  }

  function togglePin(arg1, arg2) {
    const hasGroup = (arg1 === 'primary' || arg1 === 'split') && typeof arg2 === 'string';
    const gid = hasGroup ? arg1 : 'primary';
    const tabId = hasGroup ? arg2 : arg1;
    const g = getGroup(gid);
    if (!g.tabs.includes(tabId)) return false;
    let pinnedNow;
    if (g.pinned.has(tabId)) {
      g.pinned.delete(tabId);
      pinnedNow = false;
    } else {
      g.pinned.add(tabId);
      if (g.previewTab === tabId) g.previewTab = null;
      pinnedNow = true;
    }
    keepPinsFirst(g);
    return pinnedNow;
  }

  function reorderTab(gid, tabId, targetIdxOrId, after = false) {
    const g = getGroup(gid);
    const from = g.tabs.indexOf(tabId);
    if (from < 0) return;

    if (typeof targetIdxOrId === 'number') {
      const targetId = g.tabs[targetIdxOrId];
      if (!targetId || targetId === tabId) return;
      if (g.pinned.has(tabId) !== g.pinned.has(targetId)) return;
      g.tabs.splice(from, 1);
      const clamped = Math.max(0, Math.min(g.tabs.length, targetIdxOrId));
      g.tabs.splice(clamped, 0, tabId);
      keepPinsFirst(g);
      return;
    }

    const targetTabId = targetIdxOrId;
    if (tabId === targetTabId) return;
    const to = g.tabs.indexOf(targetTabId);
    if (to < 0 || g.pinned.has(tabId) !== g.pinned.has(targetTabId)) return;
    g.tabs.splice(from, 1);
    const nextIdx = g.tabs.indexOf(targetTabId);
    g.tabs.splice(after ? nextIdx + 1 : nextIdx, 0, tabId);
    keepPinsFirst(g);
  }

  function pickNextTab(g, closedId) {
    for (const m of g.mru) {
      if (m !== closedId && g.tabs.includes(m)) return m;
    }
    const vi = g.tabs.indexOf(closedId);
    return g.tabs[vi + 1] || g.tabs[vi - 1] || null;
  }

  function closeTabInGroup(gid, tabId, forceDropBuffer = false) {
    const g = getGroup(gid);
    const idx = g.tabs.indexOf(tabId);
    if (idx < 0) return g.active;
    const next = g.active === tabId ? pickNextTab(g, tabId) : g.active;
    g.tabs.splice(idx, 1);
    g.pinned.delete(tabId);
    if (g.previewTab === tabId) g.previewTab = null;
    const mi = g.mru.indexOf(tabId);
    if (mi >= 0) g.mru.splice(mi, 1);
    g.active = next && g.tabs.includes(next) ? next : (g.tabs[0] || null);
    if (forceDropBuffer && !isOpenAnywhere(tabId)) buffers.delete(tabId);
    else pruneOrphanBuffer(tabId);
    return g.active;
  }

  function mruTabs(gid = 'primary') {
    const g = getGroup(gid);
    const seen = new Set();
    const out = [];
    for (const id of g.mru) {
      if (g.tabs.includes(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    for (const id of g.tabs) {
      if (!seen.has(id)) out.push(id);
    }
    return out;
  }

  function pushNav(loc) {
    if (navJumping || !loc || !loc.tabId) return;
    const entry = {
      group: loc.group || activeGroup,
      tabId: loc.tabId,
      line: Math.max(1, loc.line || 1),
      col: Math.max(1, loc.col || 1),
    };
    const cur = navStack[navIdx];
    if (cur && cur.tabId === entry.tabId && Math.abs((cur.line || 1) - entry.line) <= 4) {
      cur.line = entry.line;
      cur.col = entry.col;
      return;
    }
    navStack = navStack.slice(0, navIdx + 1);
    navStack.push(entry);
    if (navStack.length > 120) navStack.shift();
    navIdx = navStack.length - 1;
  }

  function canNavBack() { return navIdx > 0; }
  function canNavFwd() { return navIdx >= 0 && navIdx < navStack.length - 1; }

  function stepNav(dir) {
    if (dir < 0) {
      if (!canNavBack()) return null;
      navIdx--;
      return navStack[navIdx];
    }
    if (!canNavFwd()) return null;
    navIdx++;
    return navStack[navIdx];
  }

  function remapPaths(oldPrefix, newPrefix) {
    const oldNorm = normSlash(oldPrefix).replace(/\/+$/, '');
    const newNorm = normSlash(newPrefix).replace(/\/+$/, '');
    const mapOne = (p) => {
      if (!p || isVirtualTab(p)) return p;
      const pn = normSlash(p);
      if (pn === oldNorm) return newNorm;
      if (pn.startsWith(oldNorm + '/')) return newNorm + pn.slice(oldNorm.length);
      return p;
    };

    for (const [key, buf] of [...buffers.entries()]) {
      if (!isVirtualTab(key) && pathInside(key, oldNorm)) {
        const nextKey = mapOne(key);
        buffers.delete(key);
        buf.id = nextKey;
        buf.path = nextKey;
        buf.title = nextKey.split('/').pop() || nextKey;
        buffers.set(nextKey, buf);
      } else if (buf.path && pathInside(buf.path, oldNorm)) {
        buf.path = mapOne(buf.path);
      }
    }
    for (const g of [groups.primary, groups.split]) {
      g.tabs = g.tabs.map(mapOne);
      const nextPins = new Set();
      for (const p of g.pinned) nextPins.add(mapOne(p));
      g.pinned = nextPins;
      if (g.previewTab) g.previewTab = mapOne(g.previewTab);
      if (g.active) g.active = mapOne(g.active);
      g.mru = g.mru.map(mapOne);
    }
    for (const n of navStack) n.tabId = mapOne(n.tabId);
    for (let i = 0; i < recentList.length; i++) recentList[i] = mapOne(recentList[i]);
  }

  function dropUnder(prefix) {
    const dropped = [];
    const shouldDrop = (id) => {
      if (!id) return false;
      if (!isVirtualTab(id)) return pathInside(id, prefix);
      const b = buffers.get(id);
      return !!(b && b.path && pathInside(b.path, prefix));
    };
    for (const [id] of [...buffers.entries()]) {
      if (shouldDrop(id)) {
        dropped.push(id);
        buffers.delete(id);
      }
    }
    for (const g of [groups.primary, groups.split]) {
      const wasActiveDropped = shouldDrop(g.active);
      g.tabs = g.tabs.filter((id) => !shouldDrop(id));
      for (const p of [...g.pinned]) if (shouldDrop(p)) g.pinned.delete(p);
      if (shouldDrop(g.previewTab)) g.previewTab = null;
      g.mru = g.mru.filter((id) => !shouldDrop(id));
      if (wasActiveDropped) g.active = g.mru[0] || g.tabs[g.tabs.length - 1] || null;
    }
    navStack = navStack.filter((n) => !shouldDrop(n.tabId));
    navIdx = Math.min(navIdx, navStack.length - 1);
    for (let i = recentList.length - 1; i >= 0; i--) {
      if (pathInside(recentList[i], prefix)) recentList.splice(i, 1);
    }
    return dropped;
  }

  function resetAll() {
    buffers.clear();
    for (const g of [groups.primary, groups.split]) {
      g.tabs = [];
      g.pinned.clear();
      g.previewTab = null;
      g.active = null;
      g.mru = [];
    }
    activeGroup = 'primary';
    navStack = [];
    navIdx = -1;
  }

  function serializeWorkspace(projRootOrSet = null) {
    const projRoot = typeof projRootOrSet === 'string' ? projRootOrSet : null;
    const allow = (id) => !isVirtualTab(id) && (!projRoot || pathInside(id, projRoot));
    const fileTabs = (g) => g.tabs.filter(allow).slice(0, 24);
    const cursors = {};
    for (const id of new Set([...fileTabs(groups.primary), ...fileTabs(groups.split)])) {
      const b = buffers.get(id);
      if (b && (b.cursorLine > 1 || b.cursorCol > 1)) {
        cursors[id] = { line: b.cursorLine || 1, col: b.cursorCol || 1 };
      }
    }
    return {
      tabs: fileTabs(groups.primary),
      pinned: [...groups.primary.pinned].filter(allow),
      active: groups.primary.active && allow(groups.primary.active) ? groups.primary.active : null,
      splitOpen: fileTabs(groups.split).length > 0,
      splitTabs: fileTabs(groups.split),
      splitPinned: [...groups.split.pinned].filter(allow),
      splitActive: groups.split.active && allow(groups.split.active) ? groups.split.active : null,
      cursors,
    };
  }

  return {
    get activeGroup() { return activeGroup; },
    set activeGroup(v) { activeGroup = v === 'split' ? 'split' : 'primary'; },
    get navJumping() { return navJumping; },
    set navJumping(v) { navJumping = !!v; },
    ensureBuffer,
    getBuffer: (id) => buffers.get(id) || null,
    hasBuffer: (id) => buffers.has(id),
    allBuffers: () => [...buffers.values()],
    groupState: (gid = 'primary') => getGroup(gid),
    openTabInGroup,
    closeTabInGroup,
    promotePreview,
    isPreviewTab: (tabId, gid = 'primary') => getGroup(gid).previewTab === tabId,
    togglePin,
    reorderTab,
    mruTabs,
    recentFiles: () => [...recentList],
    pushNav,
    canNavBack,
    canNavFwd,
    stepNav,
    remapPaths,
    dropUnder,
    resetAll,
    clearAll: resetAll,
    serializeWorkspace,
  };
}
