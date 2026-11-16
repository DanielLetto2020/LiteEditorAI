// Общее ядро проектных терминалов (xterm + вкладки + сплит + агенты + поиск + промпты).
// Используется как главным окном (renderer/renderer.js), так и вынесенными окнами
// проектов (renderer/proj-term-window.js), чтобы поведение было идентичным без дублирования.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

import { t as tt } from './i18n.js';
import { planProjectTabs } from './proj-tabs.js';
import {
  prepareRenderer, activateRenderer, releaseRenderer, applyUnicode11,
  copySelection, ptyResizer, writeTermWithAck, creditPtyAck, dropPtyAck,
} from './termutil.js';
import { attachTimeline } from './termtimeline.js';
import { el, icon, iconBtn, menuRow, placeMenu, closeMenus, makeModal, showConfirm, showPrompt } from './ui.js';

const $ = (sel) => document.querySelector(sel);

// ---- распознавание состояния активности и Claude Code ----
export const PROMPT_RE = /\(y\/n\)|\[y\/n\]|\[Y\/n\]|\(yes\/no\)|overwrite\?|password[^\n]{0,24}:|passphrase[^\n]{0,24}:|press\s+(?:enter|return|any key)|continue\?/i;
const ANSI_RE = /\x1b\][^\x07]*\x07|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const TAIL_SRC = 8192;
export const CLAUDE_TITLE_RE = /^([◐◑✳])\s/;
const CLAUDE_PROBE_MS = 150;
const CLAUDE_PROBE_MAX_MS = 1000;
const CLAUDE_PICK_RE = /^\s*❯\s*1\.\s/;
const CLAUDE_FOOT_RE = /\bEsc to cancel\b/;
const FILELINK_RE = /(?:[a-zA-Z]:)?(?:\.{0,2}[\\/])?[\w.\-\\/]+\.[A-Za-z][\w]*(?::\d+)?/g;
const PREFILL_QUIET_MS = 150;
const PREFILL_MAX_WAIT = 1500;
const GS_PER_SESSION = 60;

const DEFAULT_PROMPTS = [
  { id: 'ps_explain', title: 'Объясни код', body: 'Объясни, что делает этот код, по шагам — без изменений.' },
  { id: 'ps_bugs', title: 'Найди баги', body: 'Найди потенциальные баги и уязвимости в коде проекта и предложи исправления.' },
  { id: 'ps_tests', title: 'Напиши тесты', body: 'Напиши модульные тесты для последних изменений.' },
  { id: 'ps_refactor', title: 'Отрефактори', body: 'Предложи рефакторинг: чище и проще, без изменения поведения.' },
];

export const stripAnsi = (str) => str.replace(ANSI_RE, '');
export const hasRealBell = (s) => s.indexOf('\x07') !== -1 && s.replace(OSC_RE, '').includes('\x07');

export function looksLikeShellTitle(s) {
  if (/^\S+@\S+/.test(s)) return true;
  if (/^[~/]\S*$/.test(s)) return true;
  if (/^[A-Za-z]:[\\/]\S*$/.test(s)) return true;
  return false;
}

export function scanTermBuffer(term, q, { isRe = false, caseSens = false } = {}) {
  const out = [];
  if (!term || !q) return out;
  try {
    const buf = term.buffer.active;
    let re = null;
    if (isRe) {
      try { re = new RegExp(q, caseSens ? '' : 'i'); } catch (_) { return out; }
    }
    const needle = caseSens ? q : q.toLowerCase();
    for (let y = 0; y < buf.length && out.length < GS_PER_SESSION; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      const hit = re ? re.test(text) : (caseSens ? text.includes(needle) : text.toLowerCase().includes(needle));
      if (hit) out.push({ y, text: text.trim().slice(0, 200) });
    }
  } catch (_) {}
  return out;
}

function fmtRest(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/**
 * Создаёт общий оверлей отдыха Помодоро поверх `#term-body`.
 * @param {{ lite: any, onRestored?: () => void }} opts
 */
export function createRestGuardController({ lite, onRestored }) {
  let restGuardEl = null;
  const REST_R = 70, REST_C = 2 * Math.PI * REST_R;
  return function applyRestGuard(s) {
    const host = $('#term-body');
    if (!host) return;
    if (!s || !s.show) {
      if (restGuardEl) {
        restGuardEl.remove();
        restGuardEl = null;
        try { if (onRestored) onRestored(); } catch (_) {}
      }
      return;
    }
    if (!restGuardEl) {
      restGuardEl = el('div', 'rest-overlay');
      restGuardEl.tabIndex = -1;
      const card = el('div', 'rest-card');
      const ringWrap = el('div', 'rest-ring');
      ringWrap.innerHTML = `<svg viewBox="0 0 160 160" class="rest-ring-svg" aria-hidden="true">
        <circle class="rest-ring-bg" cx="80" cy="80" r="${REST_R}"/>
        <circle class="rest-ring-fg" cx="80" cy="80" r="${REST_R}" stroke-dasharray="${REST_C.toFixed(1)}" stroke-dashoffset="0"/>
      </svg>`;
      const center = el('div', 'rest-ring-center');
      center.appendChild(el('div', 'rest-title'));
      center.appendChild(el('div', 'rest-clock'));
      ringWrap.appendChild(center);
      card.appendChild(ringWrap);
      card.appendChild(el('div', 'rest-sub', 'Отойдите от экрана — агенты продолжают работать'));
      const skipBtn = el('button', 'rest-skip');
      skipBtn.append(icon('skip', 16), el('span', null, 'Пропустить'));
      skipBtn.onclick = () => { try { lite.editorBus.pomodoroSkip(); } catch (_) {} };
      card.appendChild(skipBtn);
      restGuardEl.appendChild(card);
      host.appendChild(restGuardEl);
      try { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); } catch (_) {}
      try { restGuardEl.focus(); } catch (_) {}
    }
    const done = s.total ? Math.max(0, Math.min(1, (s.total - s.remaining) / s.total)) : 0;
    restGuardEl.querySelector('.rest-title').textContent = s.phase === 'long' ? 'Длинный перерыв' : 'Короткий перерыв';
    restGuardEl.querySelector('.rest-clock').textContent = fmtRest(s.remaining) + (s.paused ? '  ⏸' : '');
    const skip = /** @type {HTMLElement | null} */ (restGuardEl.querySelector('.rest-skip'));
    if (skip) skip.style.display = s.allowSkip ? '' : 'none';
    const fg = /** @type {SVGCircleElement | null} */ (restGuardEl.querySelector('.rest-ring-fg'));
    if (fg) fg.style.strokeDashoffset = (REST_C * done).toFixed(1);
    restGuardEl.style.setProperty('--rest-dim', (0.45 + 0.37 * done).toFixed(2));
  };
}

/**
 * Создаёт движок терминальных вкладок, сплитов, индикаторов, поиска и меню промптов.
 * @param {{
 *   lite: any,
 *   STORE: Record<string, any>,
 *   persist: (key: string, value: any) => void,
 *   getSettings: () => Record<string, any>,
 *   saveSettings: () => void,
 *   termTheme: () => Record<string, any>,
 *   getProjects: () => any[],
 *   getActiveId: () => string | null,
 *   setActiveProject?: (id: string) => void,
 *   isDetached?: (projId: string) => boolean,
 *   getSplitFrac?: () => number,
 *   setSplitFrac?: (frac: number, save: boolean) => void,
 *   extTerms?: Map<string, any>,
 *   isExtTerm?: (id: string) => boolean,
 *   restartExtTerminal?: (id: string) => void,
 *   refitExtra?: () => void,
 *   onStatusChange?: (projId: string, sid: string) => void,
 *   onTabsChanged?: (projId: string) => void,
 *   onTurnEnd?: (projId: string, state: string, sid: string, reason?: string, worked?: boolean) => void,
 *   onAfterShowActive?: () => void,
 *   onHotkey?: (e: KeyboardEvent) => boolean,
 *   onSessionExit?: (sid: string, projId: string) => void,
 * }} host
 */
export function createTermEngine(host) {
  const { lite, STORE, persist } = host;
  const extTerms = host.extTerms || new Map();
  const isExtTerm = host.isExtTerm || (() => false);

  const tabsByProj = new Map();
  const terms = new Map();
  const lazyTabs = new Map();
  const projState = new Map();
  let agentScan = new Map();
  const adoptPtys = new Map();
  let agentScanTimer = null;
  let agentScanSeq = 0;

  const BOOT_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let sessionSeq = 0;

  function activeProject() {
    const aid = host.getActiveId();
    return host.getProjects().find((p) => p.id === aid) || null;
  }
  function activeSessionId() {
    const t = tabsByProj.get(host.getActiveId());
    return t ? t.active : null;
  }
  function projSessions(projId) {
    const t = tabsByProj.get(projId);
    return t ? t.sessions : [];
  }
  function hasTabSession(sid) {
    return !!(sid && (terms.has(sid) || lazyTabs.has(sid)));
  }
  function tabMeta(sid) {
    return terms.get(sid) || lazyTabs.get(sid) || null;
  }
  function isProjSplit(t) {
    return !!(t && Array.isArray(t.splitPair) && t.splitPair.length === 2
      && t.splitPair[0] !== t.splitPair[1] && terms.has(t.splitPair[0]) && terms.has(t.splitPair[1]));
  }
  function isSessionVisible(sid) {
    const t = tabsByProj.get(host.getActiveId());
    if (!t || !sid) return false;
    if (isProjSplit(t)) return t.splitPair.includes(sid);
    return t.active === sid;
  }

  function applySplitCss(frac, save = false) {
    const clamped = Math.max(0.2, Math.min(0.8, Number.isFinite(+frac) ? +frac : 0.5));
    const tb = $('#term-body');
    if (tb) tb.style.setProperty('--split-pct', (clamped * 100).toFixed(2) + '%');
    if (host.setSplitFrac) host.setSplitFrac(clamped, save);
  }

  // ---- статус сессий, Claude Code и агенты ----
  function setProjState(sid, state) {
    projState.set(sid, state);
    const rec = terms.get(sid);
    document.querySelectorAll(`.tab[data-sid="${sid}"] .tab-dot`).forEach((d) => { d.className = 'tab-dot pind ' + state; });
    if (host.onStatusChange && rec) host.onStatusChange(rec.projId, sid);
    scheduleAgentScan();
  }

  async function agentReport(id) {
    try {
      if (lite.pty.agentState) return await lite.pty.agentState(id);
      const fg = await lite.pty.foregroundState(id);
      return fg ? { fg, claude: null } : null;
    } catch (_) { return null; }
  }

  function claudeDialogOnScreen(term) {
    const b = term.buffer.active;
    let pick = false, foot = false;
    for (let y = b.baseY; y < b.baseY + term.rows; y++) {
      const line = b.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (CLAUDE_PICK_RE.test(text)) pick = true;
      if (CLAUDE_FOOT_RE.test(text)) foot = true;
    }
    return pick && foot;
  }

  function stopClaudeProbe(rec) {
    clearTimeout(rec.probeTimer);
    clearTimeout(rec.probeDeadline);
    rec.probeTimer = rec.probeDeadline = null;
  }

  function scheduleClaudeProbe(id, delay = CLAUDE_PROBE_MS) {
    const rec = terms.get(id);
    if (!rec) return;
    clearTimeout(rec.probeTimer);
    rec.probeTimer = setTimeout(() => probeClaude(id), delay);
    if (!rec.probeDeadline) rec.probeDeadline = setTimeout(() => probeClaude(id), CLAUDE_PROBE_MAX_MS);
  }

  function setAgentState(id, st, reason) {
    const rec = terms.get(id);
    if (!rec) return;
    const prev = projState.get(id);
    if (st === prev) return;
    const worked = prev === 'busy' && Date.now() - (rec.busyStart || 0) >= 1500;
    if (st === 'busy') rec.busyStart = Date.now();
    rec.sawBell = false;
    setProjState(id, st);
    if (st === 'busy') return;
    if (host.onTurnEnd) host.onTurnEnd(rec.projId, st, id, reason, worked);
  }

  function claudeVerdict(id, report) {
    const rec = terms.get(id);
    const rep = report && report.claude;
    if (rep) {
      const c = rec.claude || (rec.claude = {});
      clearTimeout(rec.idleTimer);
      const st = rep.status === 'busy' ? 'busy' : rep.status === 'waiting' ? 'waiting' : 'quiet';
      if (c.titled && (st === 'busy') !== c.working && (rec.claudeRetry || 0) < 3) {
        rec.claudeRetry = (rec.claudeRetry || 0) + 1;
        scheduleClaudeProbe(id, 300);
        return true;
      }
      rec.claudeRetry = 0;
      setAgentState(id, st, rep.waitingFor);
      return true;
    }
    if (!rec.claude) return false;
    if (rec.claude.titled && !(report && report.fg === 'shell')) {
      setAgentState(id, rec.claude.working ? 'busy' : claudeDialogOnScreen(rec.term) ? 'waiting' : 'quiet');
      return true;
    }
    rec.claude = null;
    stopClaudeProbe(rec);
    return false;
  }

  function leaveClaude(id) {
    const rec = terms.get(id);
    if (!rec) return;
    rec.claude = null;
    rec.claudeRetry = 0;
    stopClaudeProbe(rec);
    clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => settleProject(id), host.getSettings().idleMs || 1200);
  }

  async function probeClaude(id) {
    const rec = terms.get(id);
    if (!rec) return;
    stopClaudeProbe(rec);
    const seq = rec.probeSeq = (rec.probeSeq || 0) + 1;
    const report = await agentReport(id);
    if (!terms.has(id) || rec.probeSeq !== seq || !rec.claude) return;
    if (!claudeVerdict(id, report)) settleProject(id);
  }

  function onClaudeTitle(id, raw) {
    const rec = terms.get(id);
    if (!rec) return;
    const m = CLAUDE_TITLE_RE.exec(String(raw || ''));
    if (!m) {
      if (rec.claude && rec.claude.titled) leaveClaude(id);
      return;
    }
    const working = m[1] !== '✳';
    const c = rec.claude || (rec.claude = {});
    const was = c.titled ? c.working : null;
    c.titled = true;
    c.working = working;
    clearTimeout(rec.idleTimer);
    if (was === working) return;
    if (working) setAgentState(id, 'busy');
    scheduleClaudeProbe(id, working ? CLAUDE_PROBE_MS : 60);
  }

  async function settleProject(id) {
    const rec = terms.get(id);
    if (!rec) return;
    const seq = rec.activitySeq;
    const report = await agentReport(id);
    if (!terms.has(id) || rec.activitySeq !== seq) return;
    if (claudeVerdict(id, report)) return;
    const kind = report ? report.fg : null;
    const st = host.getSettings();
    if (kind === 'running') {
      if (projState.get(id) !== 'busy') setProjState(id, 'busy');
      clearTimeout(rec.idleTimer);
      rec.idleTimer = setTimeout(() => settleProject(id), st.idleMs || 1200);
      return;
    }
    let waiting;
    if (kind === 'waiting') waiting = true;
    else if (kind === 'shell') waiting = false;
    else waiting = PROMPT_RE.test((rec.tail || '').split('\n').pop().trim());
    if (rec.sawBell) waiting = true;
    const worked = rec.sawBell || (projState.get(id) === 'busy' && (Date.now() - (rec.busyStart || 0)) >= 1500);
    rec.sawBell = false;
    const next = waiting ? 'waiting' : 'quiet';
    setProjState(id, next);
    if (host.onTurnEnd) host.onTurnEnd(rec.projId, next, id, undefined, worked);
  }

  function markActivity(id, data) {
    const rec = terms.get(id);
    if (!rec) return;
    const bell = !!(data && hasRealBell(data));
    if (bell) rec.sawBell = true;
    if (rec.claude) { scheduleClaudeProbe(id); return; }
    const echoLike = !bell && data && data.length <= 8 && (Date.now() - (rec.lastInputAt || 0)) < 250;
    if (echoLike) return;
    const src = data || '';
    rec.tail = stripAnsi((rec.tail || '') + (src.length > TAIL_SRC ? src.slice(-TAIL_SRC) : src)).slice(-400);
    rec.activitySeq = (rec.activitySeq || 0) + 1;
    if (projState.get(id) !== 'busy') { rec.busyStart = Date.now(); setProjState(id, 'busy'); }
    clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => settleProject(id), host.getSettings().idleMs || 1200);
  }

  function projAggState(projId) {
    const live = projSessions(projId).filter((s) => terms.has(s));
    if (!live.length) return 'idle';
    const ss = live.map((s) => projState.get(s));
    return ss.includes('waiting') ? 'waiting' : ss.includes('busy') ? 'busy' : 'quiet';
  }

  function sessionAgent(sid) {
    const r = agentScan.get(sid);
    if (r && r.agent) return r.agent;
    const rec = terms.get(sid);
    return rec && rec.claude ? 'claude' : null;
  }

  function projHasAgent(projId) {
    return projSessions(projId).some((s) => sessionAgent(s));
  }

  function projIdle(projId) {
    const live = projSessions(projId).filter((s) => terms.has(s));
    return projId !== host.getActiveId() && live.length > 0 && live.every((s) => {
      const rec = terms.get(s), r = agentScan.get(s);
      return (rec && rec.exited) || (r && r.idle && !sessionAgent(s));
    });
  }

  async function refreshAgents() {
    clearTimeout(agentScanTimer); agentScanTimer = null;
    if (!lite.pty.agents) return null;
    const ids = [...tabsByProj.values()].flatMap((t) => t.sessions).filter((s) => terms.has(s));
    const seq = ++agentScanSeq;
    let res = {};
    try { if (ids.length) res = (await lite.pty.agents(ids)) || {}; } catch (_) { return null; }
    if (seq !== agentScanSeq) return null;
    agentScan = new Map(Object.entries(res));
    if (host.onStatusChange) {
      // Дёргаем общий апдейт после завершения опроса (renderer обновит фильтр, вынесенное окно пошлёт статус)
      const aid = host.getActiveId();
      if (aid && tabsByProj.has(aid)) host.onStatusChange(aid, null);
    }
    return agentScan;
  }

  function scheduleAgentScan(delay = 500) {
    if (!agentScanTimer) agentScanTimer = setTimeout(refreshAgents, delay);
  }

  // ---- ссылки на файлы в выводе ----
  async function openFromTerminal(projPath, raw) {
    const mm = raw.match(/^(.*?)(?::(\d+))?$/);
    let p = mm[1]; const line = mm[2] ? parseInt(mm[2], 10) : 0;
    if (!/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) p = projPath.replace(/[\\/]$/, '') + '/' + p.replace(/^\.[\\/]/, '');
    if (!(await lite.fs.exists(p))) return;
    lite.editorBus.openInViewer(p, line);
  }

  function fileLinkProvider(term, projPath) {
    return {
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) { cb(undefined); return; }
        const text = line.translateToString(true);
        const links = [];
        let m; FILELINK_RE.lastIndex = 0;
        while ((m = FILELINK_RE.exec(text))) {
          const raw = m[0];
          if (!/[\\/]/.test(raw) && !/^\w+\.\w+(:\d+)?$/.test(raw)) continue;
          const startX = m.index + 1;
          links.push({
            range: { start: { x: startX, y }, end: { x: startX + raw.length - 1, y } },
            text: raw,
            activate: () => openFromTerminal(projPath, raw),
          });
        }
        cb(links.length ? links : undefined);
      },
    };
  }

  // ---- автоввод и вставка ----
  function armPrefill(id, text) {
    const rec = terms.get(id); if (!rec || !text) return;
    rec.prefill = text;
    rec.prefillTimer = setTimeout(() => firePrefill(id), PREFILL_MAX_WAIT);
  }
  function nudgePrefill(id) {
    const rec = terms.get(id); if (!rec || !rec.prefill) return;
    clearTimeout(rec.prefillTimer);
    rec.prefillTimer = setTimeout(() => firePrefill(id), PREFILL_QUIET_MS);
  }
  function cancelPrefill(id) {
    const rec = terms.get(id); if (!rec || !rec.prefill) return;
    clearTimeout(rec.prefillTimer); rec.prefill = '';
  }
  function firePrefill(id) {
    const rec = terms.get(id); if (!rec || !rec.prefill) return;
    const text = rec.prefill; rec.prefill = '';
    rec.lastInputAt = Date.now();
    lite.pty.write(id, text);
  }

  function writeAsPaste(id, text) {
    const rec = terms.get(id) || extTerms.get(id);
    const bracketed = !!(rec && rec.term && rec.term.modes && rec.term.modes.bracketedPasteMode);
    const s = String(text);
    lite.pty.write(id, bracketed ? '\x1b[200~' + s.replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r') + '\x1b[201~' : s);
  }

  async function pasteInto(id) {
    const text = await lite.readClipboard();
    if (text) { cancelPrefill(id); writeAsPaste(id, text); }
    const rec = isExtTerm(id) ? extTerms.get(id) : terms.get(id);
    if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
  }

  // ---- промпты (правый клик в терминале) ----
  function loadPromptStore() {
    let v = STORE.promptSnippets;
    if (Array.isArray(v)) { v = { global: v, byProject: {} }; persist('promptSnippets', v); return v; }
    if (!v || typeof v !== 'object') { v = { global: DEFAULT_PROMPTS.map((p) => ({ ...p })), byProject: {} }; persist('promptSnippets', v); return v; }
    if (!Array.isArray(v.global)) v.global = [];
    if (!v.byProject || typeof v.byProject !== 'object') v.byProject = {};
    return v;
  }
  function savePromptStore(s) { persist('promptSnippets', s); }
  function newPromptId() { return 'ps_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

  function insertPrompt(sid, body) {
    const text = String(body || '').replace(/[\r\n]+$/, '');
    if (text) { cancelPrefill(sid); writeAsPaste(sid, text); }
    const rec = terms.get(sid);
    if (rec && rec.term) { try { rec.term.focus(); } catch (_) {} }
  }

  function openPromptsManager(projId) {
    const store = loadPromptStore();
    const projName = (host.getProjects().find((p) => p.id === projId) || {}).name || 'Проект';
    const clone = (arr) => (arr || []).map((p) => ({ id: p.id, title: p.title || '', body: p.body || '' }));
    const cols = { proj: clone(store.byProject[projId]), glob: clone(store.global) };
    const listEls = {};
    const syncFromDom = () => {
      for (const key of ['proj', 'glob']) {
        if (!listEls[key]) continue;
        for (const row of listEls[key].children) {
          const it = cols[key].find((x) => x.id === row.dataset.id);
          if (!it) continue;
          it.title = row.querySelector('.pm-title').value;
          it.body = row.querySelector('.pm-body').value;
        }
      }
    };
    const persistNow = () => {
      if (cols.proj.length) store.byProject[projId] = cols.proj; else delete store.byProject[projId];
      store.global = cols.glob;
      savePromptStore(store);
    };
    const commit = () => { syncFromDom(); persistNow(); };
    const { m, close } = makeModal(`
      <h2>Заготовленные промпты</h2>
      <div class="pm-hint">Доступны по правому клику в терминале → «Промпты». Клик по карточке вставляет текст в активный терминал <b>без запуска</b>. Слева — промпты этого проекта, справа — общие для всех проектов.</div>
      <div class="pm-cols">
        <div class="pm-col">
          <div class="pm-col-head" data-head="proj"></div>
          <div class="pm-list" data-list="proj"></div>
          <button class="btn pm-add" data-add="proj">＋ Добавить</button>
        </div>
        <div class="pm-col">
          <div class="pm-col-head">Общие</div>
          <div class="pm-list" data-list="glob"></div>
          <button class="btn pm-add" data-add="glob">＋ Добавить</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="pm-done">Готово</button>
      </div>`, commit);
    m.querySelector('[data-head="proj"]').textContent = 'Проект — ' + projName;
    listEls.proj = m.querySelector('[data-list="proj"]');
    listEls.glob = m.querySelector('[data-list="glob"]');
    const move = (key, i, d) => { syncFromDom(); const a = cols[key], j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; persistNow(); render(); };
    const remove = (key, i) => { syncFromDom(); cols[key].splice(i, 1); persistNow(); render(); };
    const add = (key) => { syncFromDom(); const it = { id: newPromptId(), title: '', body: '' }; cols[key].push(it); persistNow(); render(key, it.id); };
    const transfer = (key, i) => { syncFromDom(); const dest = key === 'proj' ? 'glob' : 'proj'; const [it] = cols[key].splice(i, 1); cols[dest].push(it); persistNow(); render(dest, it.id); };
    const buildRow = (key, it, i) => {
      const row = el('div', 'pm-row'); row.dataset.id = it.id;
      const head = el('div', 'pm-row-head');
      const ti = el('input', 'pm-title'); ti.type = 'text'; ti.value = it.title; ti.placeholder = 'Название';
      ti.addEventListener('change', commit);
      const ctrl = el('div', 'pm-ctrl');
      const up = iconBtn('pm-mini', 'chevron-up', 'Выше', 15); up.disabled = i === 0;
      up.addEventListener('click', () => move(key, i, -1));
      const down = iconBtn('pm-mini', 'chevron-down', 'Ниже', 15); down.disabled = i === cols[key].length - 1;
      down.addEventListener('click', () => move(key, i, 1));
      const toGlob = key === 'proj';
      const mv = iconBtn('pm-mini', toGlob ? 'globe' : 'folder', toGlob ? 'В общие' : 'В проект', 15);
      mv.addEventListener('click', () => transfer(key, i));
      const del = iconBtn('pm-mini del', 'trash', 'Удалить', 15);
      del.addEventListener('click', () => remove(key, i));
      ctrl.append(up, down, mv, del);
      head.append(ti, ctrl);
      const body = el('textarea', 'pm-body'); body.value = it.body; body.placeholder = 'Текст промпта…';
      body.addEventListener('change', commit);
      row.append(head, body);
      return row;
    };
    const render = (focusKey, focusId) => {
      for (const key of ['proj', 'glob']) {
        const listEl = listEls[key]; listEl.innerHTML = '';
        if (!cols[key].length) { listEl.appendChild(el('div', 'pm-empty', key === 'proj' ? 'Нет промптов проекта' : 'Нет общих промптов')); continue; }
        cols[key].forEach((it, i) => listEl.appendChild(buildRow(key, it, i)));
      }
      if (focusId && listEls[focusKey]) {
        const r = listEls[focusKey].querySelector(`.pm-row[data-id="${focusId}"]`);
        if (r) setTimeout(() => { const elTi = /** @type {HTMLInputElement | null} */ (r.querySelector('.pm-title')); if (elTi) elTi.focus(); }, 20);
      }
    };
    m.querySelectorAll('.pm-add').forEach((b) => { if (b instanceof HTMLElement) b.onclick = () => add(b.dataset.add); });
    const done = m.querySelector('#pm-done');
    if (done instanceof HTMLElement) done.onclick = close;
    render();
  }

  function buildPromptPanel(sid, projId, schedClose, keepOpen) {
    const sub = el('div', 'menu-dropdown menu-sub prompt-flyout');
    sub.addEventListener('click', (e) => e.stopPropagation());
    sub.addEventListener('mouseenter', keepOpen);
    sub.addEventListener('mouseleave', schedClose);
    const head = el('div', 'prompt-head');
    head.appendChild(el('span', 'prompt-head-title', 'Промпты'));
    const gear = iconBtn('prompt-gear', 'sliders', 'Управление промптами', 15);
    gear.addEventListener('click', () => { closeMenus(); openPromptsManager(projId); });
    head.appendChild(gear);
    sub.appendChild(head);
    const list = el('div', 'prompt-list');
    const store = loadPromptStore();
    const proj = projId ? (store.byProject[projId] || []) : [];
    const glob = store.global || [];
    const addCards = (arr) => {
      for (const p of arr) {
        const card = el('div', 'prompt-card');
        card.appendChild(el('div', 'prompt-card-title', p.title || '(без названия)'));
        if (p.body) card.appendChild(el('div', 'prompt-card-body', p.body));
        card.addEventListener('click', () => { closeMenus(); insertPrompt(sid, p.body); });
        list.appendChild(card);
      }
    };
    if (!proj.length && !glob.length) {
      list.appendChild(el('div', 'prompt-empty', 'Промптов пока нет'));
    } else if (proj.length) {
      list.appendChild(el('div', 'prompt-group', 'Проект'));
      addCards(proj);
      if (glob.length) { list.appendChild(el('div', 'prompt-group', 'Общие')); addCards(glob); }
    } else {
      addCards(glob);
    }
    sub.appendChild(list);
    return sub;
  }

  function addPromptsItem(dd, sid) {
    const projId = (terms.get(sid) || {}).projId || String(sid).split('::')[0];
    const row = el('div', 'menu-row menu-flyout');
    const ic = el('span', 'menu-ic'); ic.appendChild(icon('chat', 16));
    row.append(ic, el('span', null, 'Промпты'));
    const arr = el('span', 'menu-arrow'); arr.appendChild(icon('chevron-right', 15)); row.appendChild(arr);
    let sub = null, closeT = null;
    const closeSub = () => { if (sub) { sub.remove(); sub = null; } row.classList.remove('sub-open'); };
    const schedClose = () => { clearTimeout(closeT); closeT = setTimeout(closeSub, 240); };
    const keepOpen = () => clearTimeout(closeT);
    row.addEventListener('mouseenter', () => {
      clearTimeout(closeT);
      if (sub) return;
      sub = buildPromptPanel(sid, projId, schedClose, keepOpen);
      $('#menu-layer').appendChild(sub);
      const rr = row.getBoundingClientRect();
      sub.style.top = rr.top + 'px';
      sub.style.left = (rr.right - 4) + 'px';
      const sr = sub.getBoundingClientRect();
      if (sr.right > window.innerWidth - 8) sub.style.left = Math.max(8, rr.left - sr.width + 4) + 'px';
      if (sr.bottom > window.innerHeight - 8) sub.style.top = Math.max(8, window.innerHeight - 8 - sr.height) + 'px';
      row.classList.add('sub-open');
    });
    row.addEventListener('mouseleave', schedClose);
    dd.appendChild(row);
  }

  function showTermMenu(x, y, term, sid) {
    closeMenus();
    const dd = el('div', 'menu-dropdown');
    dd.style.minWidth = '160px';
    const hasSel = term.hasSelection && term.hasSelection();
    dd.appendChild(menuRow('copy', 'Копировать', hasSel ? () => {
      closeMenus();
      lite.copyText(term.getSelection());
      if (term.clearSelection) term.clearSelection();
    } : null, hasSel ? '' : 'disabled'));
    dd.appendChild(menuRow('clipboard', 'Вставить', () => { closeMenus(); pasteInto(sid); }));
    dd.appendChild(menuRow('volume', 'Озвучить', hasSel ? () => {
      closeMenus();
      lite.tts.openFromEditor(term.getSelection());
    } : null, hasSel ? '' : 'disabled'));
    dd.appendChild(el('div', 'menu-sep'));
    addPromptsItem(dd, sid);
    dd.appendChild(el('div', 'menu-sep'));
    dd.appendChild(menuRow('eraser', 'Очистить', () => { closeMenus(); clearTerminal(sid); }));
    dd.appendChild(menuRow('refresh', 'Перезапустить', () => { closeMenus(); restartTerminal(sid); }));
    dd.addEventListener('click', (e) => e.stopPropagation());
    placeMenu(dd, x, y);
  }

  // ---- фабрика xterm + управление сессиями/вкладками/сплитом ----
  /** @param {HTMLElement} container @param {string} id @param {{ cwd?: string, onInput?: (data: string) => boolean | void, onKey?: (e: KeyboardEvent) => boolean | void }} [opts] */
  function buildXterm(container, id, opts = {}) {
    const { cwd, onInput, onKey } = opts;
    const st = host.getSettings();
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
      fontSize: st.fontSize, cursorBlink: true, allowProposedApi: true, theme: host.termTheme(), scrollback: 5000,
      allowTransparency: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((_e, uri) => lite.openExternal(uri)));
    applyUnicode11(term);
    term.open(container);
    prepareRenderer(term);
    const syncPty = ptyResizer(id, term);
    const timeline = attachTimeline(term, container, {
      enabled: st.termTimeline === true,
      fontSize: st.fontSize,
      onGeometry: () => requestAnimationFrame(() => { try { fit.fit(); syncPty(); } catch (_) {} }),
    });
    fit.fit();
    const created = lite.pty.create({ id, cwd, cols: term.cols, rows: term.rows });
    term.onData((data) => { if (onInput && onInput(data) === false) return; timeline.markInput(data); lite.pty.write(id, data); });
    term.onResize(syncPty);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC') return !copySelection(term);
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyV') { e.preventDefault(); pasteInto(id); return false; }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') { cancelPrefill(id); lite.pty.write(id, lite.platform === 'win32' ? '\n' : '\\\r'); return false; }
      if (onKey && onKey(e) === false) return false;
      if (host.onHotkey && host.onHotkey(e)) { e.stopPropagation(); return false; }
      return true;
    });
    container.addEventListener('contextmenu', (e) => { e.preventDefault(); showTermMenu(e.clientX, e.clientY, term, id); });
    return { term, fit, search, timeline, syncPty, created };
  }

  function newSessionId(projId) {
    return projId + '::t' + (++sessionSeq) + '.' + BOOT_ID;
  }

  function createLazyTab(proj, name, custom, { sid = null, autoTitled = false } = {}) {
    const id = sid || newSessionId(proj.id);
    lazyTabs.set(id, { projId: proj.id, name, customName: !!custom, autoTitled: !!autoTitled });
    tabsByProj.get(proj.id).sessions.push(id);
    return id;
  }

  function materializeSession(sid) {
    if (!sid) return null;
    if (terms.has(sid)) return sid;
    const lazy = lazyTabs.get(sid);
    if (!lazy) return null;
    const proj = host.getProjects().find((p) => p.id === lazy.projId);
    if (!proj) { lazyTabs.delete(sid); return null; }
    lazyTabs.delete(sid);
    return createSession(proj, lazy.name, lazy.customName, null, {
      existingSid: sid,
      pushToTabs: false,
      allowPrefill: true,
      autoTitled: lazy.autoTitled,
    });
  }

  function createSession(proj, name, custom, adoptId, { existingSid = null, pushToTabs = true, allowPrefill = true, autoTitled = false, attachReason = 'reload' } = {}) {
    const id = adoptId || existingSid || newSessionId(proj.id);
    const container = el('div', 'term-instance');
    container.addEventListener('mousedown', () => focusSplitSlot(id));
    container.addEventListener('focusin', () => focusSplitSlot(id));
    $('#terminals').appendChild(container);
    const { term, fit, search, timeline, syncPty, created } = buildXterm(container, id, {
      cwd: proj.path,
      onInput: (data) => {
        const r = terms.get(id);
        if (r && r.exited) { if (data === '\r' || data === '\n') restartTerminal(id); return false; }
        cancelPrefill(id);
        if (r) r.lastInputAt = Date.now();
      },
      onKey: (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          const r = terms.get(id);
          if (r && r.exited) { e.preventDefault(); restartTerminal(id); return false; }
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') { addTab(); return false; }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyW') { const s = activeSessionId(); if (s) closeTab(s); return false; }
        if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { cycleTab(e.key === 'PageDown' ? 1 : -1); return false; }
        if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyF') { focusSplitSlot(id); openTermSearch(); return false; }
      },
    });
    term.registerLinkProvider(fileLinkProvider(term, proj.path));
    const rec = {
      term, fit, search, timeline, syncPty, container, projId: proj.id,
      name, customName: !!custom, autoTitled: !!autoTitled,
      idleTimer: null, sawBell: false, tail: '', busyStart: 0, lastInputAt: 0, activitySeq: 0,
      prefill: '', prefillTimer: null, redraw: false, needsFit: false, exited: false,
      adoptPending: /** @type {string[] | null} */ (adoptId ? [] : null),
      claude: null, probeTimer: null, probeDeadline: null, probeSeq: 0, claudeRetry: 0,
    };
    terms.set(id, rec);
    if (adoptId) {
      Promise.resolve(created).then((res) => {
        const r = terms.get(id);
        if (!r) return;
        const queued = r.adoptPending || [];
        r.adoptPending = null;
        const backlog = res && typeof res.backlog === 'string' ? res.backlog : '';
        if (backlog) r.term.write(backlog);
        else if (attachReason !== 'transfer') r.term.write('\x1b[90m' + tt('[терминал подхвачен после перезагрузки окна]') + '\x1b[0m\r\n');
        for (const chunk of queued) {
          writeTermWithAck(r.term, id, chunk);
          markActivity(id, chunk);
        }
        r.redraw = true;
        if (isSessionVisible(id)) refitActiveTerminal();
        // При переносе между окнами быстро определяем реальное состояние агента (busy/waiting/quiet).
        if (attachReason === 'transfer') {
          settleProject(id);
          scheduleAgentScan(200);
        }
      }).catch(() => {
        const r = terms.get(id);
        if (r) { r.adoptPending = null; r.redraw = true; }
      });
    } else if (allowPrefill) {
      armPrefill(id, (host.getSettings().termPrefill || '').trim());
    }
    term.onTitleChange((t) => { onClaudeTitle(id, t); adoptTermTitle(id, t); });
    if (pushToTabs) tabsByProj.get(proj.id).sessions.push(id);
    return id;
  }

  function ensureProjectTabs(proj) {
    if (!proj || tabsByProj.has(proj.id)) return;
    if (host.isDetached && host.isDetached(proj.id)) return;
    tabsByProj.set(proj.id, { sessions: [], active: null, splitPair: null });
    const saved = (STORE.projTabs || {})[proj.id];
    const plan = planProjectTabs(saved, tt('Терминал {0}', 1));
    const adopted = adoptPtys.get(proj.id);
    if (adopted && adopted.length) {
      adoptPtys.delete(proj.id);
      adopted.forEach((id, i) => {
        const pt = plan.tabs[i];
        createSession(proj, pt ? pt.name : tt('Терминал {0}', i + 1), pt ? pt.customName : false, id);
      });
      for (let i = adopted.length; i < plan.tabs.length; i++) {
        createLazyTab(proj, plan.tabs[i].name, plan.tabs[i].customName);
      }
    } else {
      for (const pt of plan.tabs) {
        if (pt.eager) createSession(proj, pt.name, pt.customName, null, { allowPrefill: pt.prefill });
        else createLazyTab(proj, pt.name, pt.customName);
      }
    }
    const t = tabsByProj.get(proj.id);
    const actSid = t.sessions[Math.min(plan.activeIndex, t.sessions.length - 1)] || t.sessions[0];
    materializeSession(actSid);
    t.active = actSid;
    if (plan.splitIndices) {
      const s0 = t.sessions[plan.splitIndices[0]];
      const s1 = t.sessions[plan.splitIndices[1]];
      if (s0 && s1 && s0 !== s1) {
        materializeSession(s0);
        materializeSession(s1);
        t.splitPair = [s0, s1];
      }
    }
    if (host.onTabsChanged) host.onTabsChanged(proj.id);
  }

  function disposeSession(sid, { killPty = true } = {}) {
    const wasLazy = lazyTabs.delete(sid);
    if (killPty && (!wasLazy || terms.has(sid))) {
      lite.pty.kill(sid);
      dropPtyAck(sid);
    } else {
      dropPtyAck(sid);
    }
    const rec = terms.get(sid);
    if (rec) {
      clearTimeout(rec.idleTimer);
      clearTimeout(rec.prefillTimer);
      stopClaudeProbe(rec);
      releaseRenderer(rec.term);
      try { rec.timeline.dispose(); } catch (_) {}
      try { rec.term.dispose(); } catch (_) {}
      rec.container.remove();
      terms.delete(sid);
    }
    projState.delete(sid);
    agentScan.delete(sid);
  }

  function unloadProjectTerms(id, { killPty = true, allowActive = false } = {}) {
    const t = tabsByProj.get(id);
    if (!t || (!allowActive && id === host.getActiveId())) return false;
    if (killPty && host.onTabsChanged) host.onTabsChanged(id);
    for (const sid of [...t.sessions]) disposeSession(sid, { killPty });
    tabsByProj.delete(id);
    if (host.onStatusChange) host.onStatusChange(id, null);
    return true;
  }

  function exportProjectSnapshot(projId) {
    const t = tabsByProj.get(projId);
    if (!t) return null;
    const tabs = t.sessions.map((sid) => {
      const rec = terms.get(sid);
      if (rec) {
        return {
          sid,
          name: rec.name,
          customName: !!rec.customName,
          autoTitled: !!rec.autoTitled,
          live: !rec.exited,
          exited: !!rec.exited,
        };
      }
      const lz = lazyTabs.get(sid);
      return {
        sid,
        name: (lz && lz.name) || 'Терминал',
        customName: !!(lz && lz.customName),
        autoTitled: !!(lz && lz.autoTitled),
        live: false,
        exited: false,
      };
    });
    return {
      projId,
      tabs,
      activeSid: t.active,
      splitPair: isProjSplit(t) ? t.splitPair.slice() : null,
      splitFrac: host.getSplitFrac ? host.getSplitFrac() : 0.5,
    };
  }

  function teardownProjectForDetach(projId) {
    const snap = exportProjectSnapshot(projId);
    unloadProjectTerms(projId, { killPty: false, allowActive: true });
    return snap;
  }

  function importProjectSnapshot(proj, snap, { aliveLiveIds = null, deadOnDetachIds = null, applySplitFrac = false } = {}) {
    if (!proj || !snap || !Array.isArray(snap.tabs) || !snap.tabs.length) return false;
    if (tabsByProj.has(proj.id)) unloadProjectTerms(proj.id, { killPty: false, allowActive: true });
    tabsByProj.set(proj.id, { sessions: [], active: null, splitPair: null });
    const t = tabsByProj.get(proj.id);

    for (const pt of snap.tabs) {
      const sid = pt.sid || newSessionId(proj.id);
      const died = !!(pt.exited || (deadOnDetachIds && deadOnDetachIds.includes(sid)));
      const alive = !!pt.live && !died && (!aliveLiveIds || aliveLiveIds.includes(sid));
      if (alive) {
        createSession(proj, pt.name, pt.customName, sid, {
          autoTitled: !!pt.autoTitled,
          allowPrefill: false,
          attachReason: 'transfer',
        });
      } else {
        createLazyTab(proj, pt.name, pt.customName, {
          sid,
          autoTitled: !!pt.autoTitled,
        });
      }
    }

    const actSid = (snap.activeSid && t.sessions.includes(snap.activeSid)) ? snap.activeSid : t.sessions[0];
    if (actSid) materializeSession(actSid);
    t.active = actSid || null;

    if (Array.isArray(snap.splitPair) && snap.splitPair.length === 2) {
      const [s0, s1] = snap.splitPair;
      if (s0 !== s1 && t.sessions.includes(s0) && t.sessions.includes(s1)) {
        materializeSession(s0);
        materializeSession(s1);
        t.splitPair = [s0, s1];
      }
    }
    if (applySplitFrac && Number.isFinite(snap.splitFrac)) applySplitCss(snap.splitFrac, false);
    if (host.onTabsChanged) host.onTabsChanged(proj.id);
    if (host.onStatusChange) host.onStatusChange(proj.id, null);
    return true;
  }

  function sendTextToProject(proj, text, { focusProject = true } = {}) {
    if (!proj || !text) return;
    ensureProjectTabs(proj);
    if (focusProject && host.setActiveProject) host.setActiveProject(proj.id);
    const sid = (tabsByProj.get(proj.id) || {}).active;
    if (!sid || !materializeSession(sid)) return;
    cancelPrefill(sid);
    writeAsPaste(sid, text);
  }

  // ---- вкладки и тултип ----
  let tabDragEl = null;
  let tabTipEl = null;
  let tabScrollRaf = 0;

  function showTabTip(anchor, text) {
    if (!tabTipEl) { tabTipEl = el('div'); tabTipEl.id = 'tab-tip'; document.body.appendChild(tabTipEl); }
    tabTipEl.textContent = text;
    tabTipEl.classList.add('show');
    const r = anchor.getBoundingClientRect();
    const tw = tabTipEl.offsetWidth, iw = window.innerWidth;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(6, Math.min(left, iw - tw - 6));
    tabTipEl.style.left = left + 'px';
    tabTipEl.style.top = (r.bottom + 6) + 'px';
  }
  function hideTabTip() { if (tabTipEl) tabTipEl.classList.remove('show'); }

  function updateTabScroll() {
    const bar = $('#term-tabs'), prev = $('#term-tabs-prev'), next = $('#term-tabs-next');
    if (!bar || !prev || !next) return;
    const overflow = bar.scrollWidth > bar.clientWidth + 1;
    prev.classList.toggle('show', overflow);
    next.classList.toggle('show', overflow);
    if (overflow) {
      const max = bar.scrollWidth - bar.clientWidth;
      /** @type {HTMLButtonElement} */ (prev).disabled = bar.scrollLeft <= 1;
      /** @type {HTMLButtonElement} */ (next).disabled = bar.scrollLeft >= max - 1;
    }
  }
  function scheduleTabScroll() {
    if (tabScrollRaf) return;
    tabScrollRaf = requestAnimationFrame(() => { tabScrollRaf = 0; updateTabScroll(); });
  }
  function scrollTabs(dir) {
    const bar = $('#term-tabs'); if (!bar) return;
    hideTabTip();
    bar.scrollBy({ left: dir * Math.max(140, bar.clientWidth * 0.7), behavior: 'smooth' });
  }
  function ensureActiveTabVisible() {
    const bar = $('#term-tabs'); if (!bar) return;
    const a = bar.querySelector('.tab.active'); if (!a) return;
    const br = bar.getBoundingClientRect(), ar = a.getBoundingClientRect();
    if (ar.left < br.left) bar.scrollLeft -= (br.left - ar.left) + 8;
    else if (ar.right > br.right) bar.scrollLeft += (ar.right - br.right) + 8;
  }

  function enableTabDnD(tab, bar, projId) {
    tab.draggable = true;
    tab.addEventListener('dragstart', (e) => {
      hideTabTip();
      tabDragEl = tab;
      tab.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', tab.dataset.sid || ''); } catch (_) {}
      }
    });
    tab.addEventListener('dragover', (e) => {
      if (!tabDragEl || tabDragEl === tab || tab.parentElement !== bar) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const r = tab.getBoundingClientRect();
      bar.insertBefore(tabDragEl, e.clientX < r.left + r.width / 2 ? tab : tab.nextSibling);
    });
    tab.addEventListener('dragend', (e) => {
      tab.classList.remove('dragging');
      if (!tabDragEl) return;
      tabDragEl = null;
      const t = tabsByProj.get(projId);
      if (t && e.dataTransfer && e.dataTransfer.dropEffect !== 'none') {
        const order = [...bar.querySelectorAll('.tab')]
          .map((x) => (x instanceof HTMLElement ? x.dataset.sid : ''))
          .filter((s) => s && t.sessions.includes(s));
        if (order.length === t.sessions.length) {
          t.sessions = order;
          if (host.onTabsChanged) host.onTabsChanged(projId);
        }
      }
      renderTabBar();
    });
  }

  function renderTabBar() {
    const bar = $('#term-tabs');
    if (!bar) return;
    hideTabTip();
    bar.innerHTML = '';
    const aid = host.getActiveId();
    const detached = !!(aid && host.isDetached && host.isDetached(aid));
    const t = detached ? null : tabsByProj.get(aid);
    const splitOn = isProjSplit(t);
    const addBtn = $('#term-tab-add');
    if (addBtn) addBtn.classList.toggle('hidden', !aid || !t);
    const sb = $('#term-split-btn');
    if (sb) {
      sb.classList.toggle('hidden', !aid || !t);
      sb.classList.toggle('on', splitOn);
      sb.title = splitOn ? 'Закрыть разделение терминала (Ctrl+Shift+D)' : 'Разделить терминал (Ctrl+Shift+D)';
    }
    if (!aid || !t || !t.sessions.length) { updateTabScroll(); return; }
    const projId = aid;
    t.sessions.forEach((sid) => {
      const rec = tabMeta(sid); if (!rec) return;
      const isLive = terms.has(sid);
      const isPeer = splitOn && sid !== t.active && t.splitPair.includes(sid);
      const tab = el('div', 'tab' + (sid === t.active ? ' active' : (isPeer ? ' split-peer' : '')) + (rec.autoTitled ? ' wide' : ''));
      tab.dataset.sid = sid;
      tab.appendChild(el('span', 'tab-dot pind ' + (isLive ? (projState.get(sid) || 'quiet') : 'idle')));
      const nameSpan = el('span', 'tab-name', rec.name);
      tab.appendChild(nameSpan);
      tab.addEventListener('mouseenter', () => { if (!tabDragEl && nameSpan.scrollWidth > nameSpan.clientWidth + 1) showTabTip(tab, rec.name); });
      tab.addEventListener('mouseleave', hideTabTip);
      if (t.sessions.length > 1) {
        const x = iconBtn('tab-close', 'x', 'Закрыть вкладку (Ctrl+Shift+W)', 12);
        x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(sid); });
        tab.appendChild(x);
        enableTabDnD(tab, bar, projId);
      }
      tab.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1 && t.sessions.length > 1) {
          e.preventDefault(); e.stopPropagation(); hideTabTip(); closeTab(sid);
        }
      });
      tab.addEventListener('click', () => { hideTabTip(); switchTab(sid); });
      tab.addEventListener('dblclick', () => renameTab(sid));
      bar.appendChild(tab);
    });
    ensureActiveTabVisible();
    updateTabScroll();
  }

  function focusSplitSlot(sid) {
    const aid = host.getActiveId();
    const t = tabsByProj.get(aid);
    if (!isProjSplit(t) || !t.splitPair.includes(sid) || t.active === sid) return;
    t.active = sid;
    if (host.onTabsChanged) host.onTabsChanged(aid);
    for (const s of t.splitPair) {
      const r = terms.get(s);
      if (r) r.container.classList.toggle('slot-focused', s === sid);
    }
    renderTabBar();
    syncTermSearchUI();
  }

  function toggleTermSplit() {
    const proj = activeProject();
    if (!proj || (host.isDetached && host.isDetached(proj.id))) return;
    ensureProjectTabs(proj);
    const t = tabsByProj.get(proj.id);
    if (!t) return;
    if (isProjSplit(t)) {
      t.splitPair = null;
      if (host.onTabsChanged) host.onTabsChanged(proj.id);
      showActiveTerminal();
      return;
    }
    const leftSid = (t.active && hasTabSession(t.active)) ? t.active : t.sessions[0];
    materializeSession(leftSid);
    let rightSid = t.sessions.find((s) => s !== leftSid && terms.has(s))
      || t.sessions.find((s) => s !== leftSid && lazyTabs.has(s))
      || null;
    if (rightSid) materializeSession(rightSid);
    else rightSid = createSession(proj, tt('Терминал {0}', t.sessions.length + 1));
    t.splitPair = [leftSid, rightSid];
    t.active = rightSid;
    if (host.onTabsChanged) host.onTabsChanged(proj.id);
    showActiveTerminal();
  }

  function showActiveTerminal() {
    const aid = host.getActiveId();
    const detached = !!(aid && host.isDetached && host.isDetached(aid));
    const t = detached ? null : tabsByProj.get(aid);
    const asid = detached ? null : activeSessionId();
    const splitOn = isProjSplit(t);
    const eh = $('#empty-hint');
    if (eh) eh.style.display = aid ? 'none' : 'flex';
    const termsEl = $('#terminals');
    if (termsEl) {
      termsEl.classList.toggle('is-split', splitOn);
      termsEl.style.display = detached ? 'none' : '';
    }
    const sg = $('#term-split-gutter');
    if (sg) sg.classList.toggle('hidden', !splitOn);
    for (const [sid, rec] of terms) {
      rec.container.classList.remove('slot-left', 'slot-right', 'slot-focused');
      if (detached) {
        rec.container.style.display = 'none';
      } else if (splitOn && t.splitPair.includes(sid)) {
        rec.container.style.display = 'block';
        rec.container.classList.add(sid === t.splitPair[0] ? 'slot-left' : 'slot-right');
        if (sid === asid) rec.container.classList.add('slot-focused');
        activateRenderer(rec.term);
      } else {
        rec.container.style.display = (!splitOn && sid === asid) ? 'block' : 'none';
        if (!splitOn && sid === asid) activateRenderer(rec.term);
      }
    }
    renderTabBar();
    syncTermSearchUI();
    if (!detached) refitActiveTerminal(true);
    if (host.onAfterShowActive) host.onAfterShowActive();
  }

  function refitActiveTerminal(focusIt = false) {
    if (host.refitExtra) { try { host.refitExtra(); } catch (_) {} }
    const aid = host.getActiveId();
    if (aid && host.isDetached && host.isDetached(aid)) return;
    const t = tabsByProj.get(aid);
    const asid = activeSessionId();
    const visibleIds = isProjSplit(t) ? t.splitPair.slice() : (asid ? [asid] : []);
    if (!visibleIds.length) return;
    requestAnimationFrame(() => {
      for (const sid of visibleIds) {
        const rec = terms.get(sid);
        if (!rec) continue;
        try {
          rec.fit.fit();
          rec.syncPty();
          rec.needsFit = false;
          if (focusIt && sid === asid) rec.term.focus();
        } catch (_) {}
        if (rec.redraw) {
          rec.redraw = false;
          const { cols, rows } = rec.term;
          if (cols > 2) { lite.pty.resize(sid, cols - 1, rows); setTimeout(() => lite.pty.resize(sid, cols, rows), 120); }
        }
      }
    });
  }

  function switchTab(sid) {
    const aid = host.getActiveId();
    const t = tabsByProj.get(aid);
    if (!t || !hasTabSession(sid)) return;
    if (!terms.has(sid) && !materializeSession(sid)) return;
    if (isProjSplit(t)) {
      if (!t.splitPair.includes(sid)) {
        const idx = t.splitPair[1] === t.active ? 1 : 0;
        t.splitPair[idx] = sid;
      }
      t.active = sid;
    } else {
      t.active = sid;
    }
    if (host.onTabsChanged) host.onTabsChanged(aid);
    showActiveTerminal();
  }

  function addTab() {
    const proj = activeProject();
    if (!proj || (host.isDetached && host.isDetached(proj.id))) return;
    ensureProjectTabs(proj);
    const t = tabsByProj.get(proj.id);
    const sid = createSession(proj, tt('Терминал {0}', t.sessions.length + 1));
    if (isProjSplit(t)) {
      const idx = t.splitPair[1] === t.active ? 1 : 0;
      t.splitPair[idx] = sid;
    }
    t.active = sid;
    if (host.onTabsChanged) host.onTabsChanged(proj.id);
    showActiveTerminal();
  }

  function doCloseTab(projId, sid) {
    const t = tabsByProj.get(projId);
    if (!t || t.sessions.length <= 1 || !t.sessions.includes(sid)) return;
    if (Array.isArray(t.splitPair) && t.splitPair.includes(sid)) {
      const other = t.splitPair[0] === sid ? t.splitPair[1] : t.splitPair[0];
      t.splitPair = null;
      if (t.active === sid && other && other !== sid) t.active = other;
    }
    disposeSession(sid, { killPty: true });
    const i = t.sessions.indexOf(sid);
    t.sessions.splice(i, 1);
    if (t.active === sid) t.active = t.sessions[Math.max(0, i - 1)];
    if (projId === host.getActiveId() && t.active) materializeSession(t.active);
    if (host.onTabsChanged) host.onTabsChanged(projId);
    if (projId === host.getActiveId()) showActiveTerminal();
    if (host.onStatusChange) host.onStatusChange(projId, sid);
  }

  async function closeTab(sid) {
    const rec = terms.get(sid);
    const meta = rec || lazyTabs.get(sid);
    const projId = meta ? meta.projId : host.getActiveId();
    const t = tabsByProj.get(projId);
    if (!t || t.sessions.length <= 1 || !t.sessions.includes(sid)) return;
    if (!rec || rec.exited) { doCloseTab(projId, sid); return; }
    const rep = await agentReport(sid);
    if (!terms.has(sid)) return;
    const agent = sessionAgent(sid) || (rep && rep.claude ? 'claude' : null);
    const st = projState.get(sid);
    const activeProc = !!(agent || (rep && (rep.fg === 'running' || rep.fg === 'waiting')) || (!rep && (st === 'busy' || st === 'waiting')));
    if (!activeProc) { doCloseTab(projId, sid); return; }
    showConfirm(
      `Закрыть вкладку «${rec.name}»?`,
      agent
        ? `В этой вкладке работает агент ${agent} — процесс будет остановлен.`
        : 'В этой вкладке выполняется команда — процесс будет оставлен и закрыт.',
      'Закрыть вкладку',
      () => doCloseTab(projId, sid),
    );
  }

  function cycleTab(dir) {
    const t = tabsByProj.get(host.getActiveId()); if (!t || t.sessions.length < 2) return;
    let i = t.sessions.indexOf(t.active) + dir;
    if (i < 0) i = t.sessions.length - 1;
    if (i >= t.sessions.length) i = 0;
    switchTab(t.sessions[i]);
  }

  function renameTab(sid) {
    const rec = tabMeta(sid); if (!rec) return;
    showPrompt('Переименовать вкладку', 'Название', rec.name, (v) => {
      rec.name = v;
      rec.customName = true;
      rec.autoTitled = false;
      if (host.onTabsChanged) host.onTabsChanged(rec.projId);
      renderTabBar();
      syncTermSearchUI();
    });
  }

  function updateTabName(sid) {
    const rec = terms.get(sid);
    const aid = host.getActiveId();
    const t = tabsByProj.get(aid);
    if (!rec || !t || !t.sessions.includes(sid)) return;
    const tab = [...document.querySelectorAll('#term-tabs .tab')].find((x) => x instanceof HTMLElement && x.dataset.sid === sid);
    if (!tab) { renderTabBar(); return; }
    tab.classList.toggle('wide', !!rec.autoTitled);
    const span = tab.querySelector('.tab-name');
    if (span && span.textContent !== rec.name) span.textContent = rec.name;
    if (sid === t.active) syncTermSearchUI();
    scheduleTabScroll();
  }

  function adoptTermTitle(id, raw) {
    const rec = terms.get(id); if (!rec || rec.customName) return;
    let name = String(raw || '').replace(/[\x00-\x1f\x7f]/g, '').trim().replace(/\s+/g, ' ');
    name = name.replace(CLAUDE_TITLE_RE, '');
    if (!name || looksLikeShellTitle(name)) return;
    if (name.length > 200) name = name.slice(0, 200);
    if (name === rec.name && rec.autoTitled) return;
    rec.name = name;
    rec.autoTitled = true;
    updateTabName(id);
    if (host.onTabsChanged) host.onTabsChanged(rec.projId);
  }

  function clearTerminal(id) {
    if (isExtTerm(id)) { const r = extTerms.get(id); if (r) { try { r.term.clear(); } catch (_) {} try { r.timeline.reset(); } catch (_) {} r.term.focus(); } return; }
    const sid = (id && terms.has(id)) ? id : activeSessionId();
    const rec = terms.get(sid);
    if (rec) { try { rec.term.clear(); } catch (_) {} try { rec.timeline.reset(); } catch (_) {} rec.term.focus(); }
  }

  function restartTerminal(id) {
    if (isExtTerm(id) && host.restartExtTerminal) { host.restartExtTerminal(id); return; }
    const sid = (id && terms.has(id)) ? id : activeSessionId();
    const rec = terms.get(sid);
    const proj = rec && host.getProjects().find((p) => p.id === rec.projId);
    if (!proj || !rec) return;
    try { rec.term.reset(); } catch (_) {}
    try { rec.timeline.reset(); } catch (_) {}
    dropPtyAck(sid);
    rec.sawBell = false; rec.tail = ''; rec.busyStart = Date.now();
    clearTimeout(rec.idleTimer);
    rec.claude = null; rec.exited = false; stopClaudeProbe(rec);
    setProjState(sid, 'busy');
    lite.pty.restart({ id: sid, cwd: proj.path, cols: rec.term.cols, rows: rec.term.rows });
    rec.term.focus();
  }

  // ---- поиск в терминале ----
  function isTermSearchOpen() {
    const box = $('#term-search');
    return !!(box && box.classList.contains('show'));
  }
  function clearAllTermSearchDecorations(exceptSid = null) {
    for (const [sid, r] of terms) {
      if (exceptSid && sid === exceptSid) continue;
      try { r.search.clearDecorations(); } catch (_) {}
    }
  }
  function syncTermSearchUI() {
    const input = /** @type {HTMLInputElement | null} */ ($('#term-search-input'));
    const t = tabsByProj.get(host.getActiveId());
    const asid = activeSessionId();
    const rec = asid ? terms.get(asid) : null;
    if (input) {
      if (isProjSplit(t) && rec) {
        input.setAttribute('data-no-i18n', '');
        input.placeholder = `${tt('Поиск в терминале…').replace(/…$/, '')} · ${rec.name}`;
      } else {
        input.removeAttribute('data-no-i18n');
        input.placeholder = tt('Поиск в терминале…');
      }
    }
    if (!isTermSearchOpen()) return;
    if (!rec) {
      const box = $('#term-search');
      if (box) box.classList.remove('show');
      clearAllTermSearchDecorations();
      return;
    }
    clearAllTermSearchDecorations(asid);
  }
  function openTermSearch() {
    const rec = terms.get(activeSessionId());
    if (!rec) return;
    const box = $('#term-search');
    if (!box) return;
    box.classList.add('show');
    syncTermSearchUI();
    const input = /** @type {HTMLInputElement | null} */ ($('#term-search-input'));
    if (input) { input.focus(); input.select(); }
  }
  function closeTermSearch() {
    const box = $('#term-search');
    if (box) box.classList.remove('show');
    clearAllTermSearchDecorations();
    const rec = terms.get(activeSessionId());
    if (rec) rec.term.focus();
  }
  function runTermSearch(dir) {
    const asid = activeSessionId();
    const rec = terms.get(asid);
    const input = /** @type {HTMLInputElement | null} */ ($('#term-search-input'));
    const q = input ? input.value : '';
    if (!rec || !q) return;
    clearAllTermSearchDecorations(asid);
    const css = getComputedStyle(document.documentElement);
    const opts = { decorations: {
      matchOverviewRuler: (css.getPropertyValue('--warn') || '#e0af68').trim() || '#e0af68',
      activeMatchColorOverviewRuler: (css.getPropertyValue('--add') || '#3ddc84').trim() || '#3ddc84',
    } };
    if (dir < 0) rec.search.findPrevious(q, opts); else rec.search.findNext(q, opts);
  }

  // ---- настройки шрифта, темы, шкалы времени ----
  function applyTimeline() {
    const on = host.getSettings().termTimeline === true;
    const tl = $('#term-timeline');
    if (tl) { tl.classList.toggle('on', on); tl.title = on ? 'Скрыть шкалу времени' : 'Шкала времени слева'; }
    for (const rec of terms.values()) { try { rec.timeline.setEnabled(on); } catch (_) {} }
    for (const rec of extTerms.values()) { try { rec.timeline.setEnabled(on); } catch (_) {} }
    refitActiveTerminal();
  }

  function applyFontSize() {
    const fsPx = host.getSettings().fontSize;
    for (const [sid, rec] of terms) {
      rec.term.options.fontSize = fsPx;
      try { rec.timeline.setFontSize(fsPx); } catch (_) {}
      if (!isSessionVisible(sid)) rec.needsFit = true;
    }
    for (const rec of extTerms.values()) {
      rec.term.options.fontSize = fsPx;
      try { rec.timeline.setFontSize(fsPx); } catch (_) {}
      rec.needsFit = true;
    }
    document.documentElement.style.setProperty('--editor-fs', fsPx + 'px');
    refitActiveTerminal();
  }

  function applyThemeAll() {
    const theme = host.termTheme();
    for (const rec of terms.values()) rec.term.options.theme = theme;
    for (const rec of extTerms.values()) rec.term.options.theme = theme;
  }

  // ---- обработка потока PTY ----
  function handlePtyData(id, data) {
    if (isExtTerm(id)) {
      const r = extTerms.get(id);
      if (r) writeTermWithAck(r.term, id, data); else creditPtyAck(id, data ? data.length : 0);
      return;
    }
    const rec = terms.get(id);
    if (!rec) { creditPtyAck(id, data ? data.length : 0); return; }
    if (rec.adoptPending) { rec.adoptPending.push(data); return; }
    writeTermWithAck(rec.term, id, data);
    if (rec.prefill) nudgePrefill(id);
    markActivity(id, data);
  }

  function handlePtyExit(id) {
    if (isExtTerm(id)) { const r = extTerms.get(id); if (r) r.term.write('\r\n\x1b[90m[шелл завершён]\x1b[0m\r\n'); return; }
    const rec = terms.get(id);
    if (!rec) return;
    cancelPrefill(id);
    rec.term.write('\r\n\x1b[90m' + tt('[процесс завершён — нажмите Enter или ↻ для перезапуска]') + '\x1b[0m\r\n');
    clearTimeout(rec.idleTimer);
    rec.claude = null;
    rec.exited = true;
    stopClaudeProbe(rec);
    setProjState(id, 'quiet');
    if (host.onSessionExit) host.onSessionExit(id, rec.projId);
  }

  // ---- привязка DOM-кнопок терминальной области ----
  function bindUiEvents() {
    const clearBtn = $('#term-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => clearTerminal());
    const restartBtn = $('#term-restart');
    if (restartBtn) restartBtn.addEventListener('click', () => restartTerminal());
    const tabAdd = $('#term-tab-add');
    if (tabAdd) tabAdd.addEventListener('click', () => addTab());
    const sb = $('#term-split-btn');
    if (sb) sb.addEventListener('click', () => toggleTermSplit());
    const prev = $('#term-tabs-prev');
    if (prev) prev.addEventListener('click', () => scrollTabs(-1));
    const next = $('#term-tabs-next');
    if (next) next.addEventListener('click', () => scrollTabs(1));
    const tabsEl = $('#term-tabs');
    if (tabsEl) {
      tabsEl.addEventListener('scroll', () => { updateTabScroll(); hideTabTip(); });
      tabsEl.addEventListener('dragover', (e) => { if (tabDragEl) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } });
      tabsEl.addEventListener('drop', (e) => { if (tabDragEl) e.preventDefault(); });
    }
    window.addEventListener('resize', updateTabScroll);

    const tl = $('#term-timeline');
    if (tl) {
      const markTl = () => {
        const on = host.getSettings().termTimeline === true;
        tl.classList.toggle('on', on);
        tl.title = on ? 'Скрыть шкалу времени' : 'Шкала времени слева';
      };
      markTl();
      tl.addEventListener('click', () => {
        const st = host.getSettings();
        st.termTimeline = st.termTimeline !== true;
        host.saveSettings();
        applyTimeline();
        markTl();
      });
    }
    const findBtn = $('#term-find');
    if (findBtn) findBtn.addEventListener('click', () => openTermSearch());

    const termSearchInput = /** @type {HTMLInputElement | null} */ ($('#term-search-input'));
    if (termSearchInput) {
      termSearchInput.addEventListener('input', () => {
        if (!termSearchInput.value) clearAllTermSearchDecorations();
      });
      termSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); runTermSearch(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); closeTermSearch(); }
      });
    }
    const tsNext = $('#term-search-next');
    if (tsNext) tsNext.addEventListener('click', () => runTermSearch(1));
    const tsPrev = $('#term-search-prev');
    if (tsPrev) tsPrev.addEventListener('click', () => runTermSearch(-1));
    const tsClose = $('#term-search-close');
    if (tsClose) tsClose.addEventListener('click', closeTermSearch);

    const sg = $('#term-split-gutter');
    if (sg) {
      sg.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const tb = $('#term-body');
        if (!tb) return;
        document.body.classList.add('resizing');
        const onMove = (ev) => {
          const rect = tb.getBoundingClientRect();
          if (rect.width <= 0) return;
          applySplitCss((ev.clientX - rect.left) / rect.width, false);
          refitActiveTerminal();
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.classList.remove('resizing');
          if (host.setSplitFrac && host.getSplitFrac) host.setSplitFrac(host.getSplitFrac(), true);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      sg.addEventListener('dblclick', () => {
        applySplitCss(0.5, true);
        refitActiveTerminal();
      });
    }
  }

  return {
    BOOT_ID,
    tabsByProj, terms, lazyTabs, projState, adoptPtys,
    getTabDragEl: () => tabDragEl,
    activeSessionId, projSessions, hasTabSession, tabMeta,
    isProjSplit, isSessionVisible,
    setProjState, markActivity, settleProject, agentReport,
    projAggState, sessionAgent, projHasAgent, projIdle,
    refreshAgents, scheduleAgentScan,
    buildXterm, writeAsPaste, pasteInto, cancelPrefill,
    createLazyTab, materializeSession, createSession, ensureProjectTabs,
    disposeSession, unloadProjectTerms,
    exportProjectSnapshot, teardownProjectForDetach, importProjectSnapshot,
    sendTextToProject,
    focusSplitSlot, toggleTermSplit, applySplitCss,
    renderTabBar, showActiveTerminal, refitActiveTerminal, updateTabScroll, scrollTabs,
    switchTab, addTab, doCloseTab, closeTab, cycleTab, renameTab,
    clearTerminal, restartTerminal,
    insertPrompt, openPromptsManager, showTermMenu,
    isTermSearchOpen, clearAllTermSearchDecorations, syncTermSearchUI,
    openTermSearch, closeTermSearch, runTermSearch,
    applyTimeline, applyFontSize, applyThemeAll,
    handlePtyData, handlePtyExit, bindUiEvents,
  };
}
