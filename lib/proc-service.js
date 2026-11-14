// Фоновый сервис опроса /proc для индикаторов активности PTY и монитора ресурсов.
// Выносит синхронные чтения /proc/<pid>/{stat,cmdline,environ,task/*/children} из главного потока
// Electron в выделенный worker_threads (с коротким TTL-кэшем и прозрачным фолбэком).
// Кроме того, samplePtyTrees обходит только потомков каждого PTY через /proc/<pid>/task/*/children
// вместо чтения /proc/*/stat всех тысяч процессов системы.

const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const pt = require('./proctree');
const as = require('./agentstate');

const MONITOR_PAGE = 4096; // размер страницы памяти для rss в /proc/<pid>/stat

// /proc/<pid>/stat → { comm, ppid, jiffies (utime+stime), rssBytes }; null если процесс уже вышел.
function readPidStatFull(pid) {
  try {
    const data = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const r = data.lastIndexOf(')');
    const comm = data.slice(data.indexOf('(') + 1, r);
    const f = data.slice(r + 2).split(' '); // [0]=state [1]=ppid … [11]=utime [12]=stime [21]=rss(стр.)
    return {
      comm,
      ppid: +f[1] || 0,
      jiffies: (+f[11] || 0) + (+f[12] || 0),
      rssBytes: (+f[21] || 0) * MONITOR_PAGE,
    };
  } catch (_) {
    return null;
  }
}

// Суммарные «джиффи» процессора из /proc/stat (для нормировки CPU% деревьев PTY).
function readTotalJiffies() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
    return line.trim().split(/\s+/).slice(1).reduce((a, b) => a + (+b || 0), 0);
  } catch (_) {
    return 0;
  }
}

// Запасной снимок всего /proc на случай ядра без CONFIG_PROC_CHILDREN (descendants() === null).
function buildFullProcTree() {
  const all = new Map();
  try {
    for (const ent of fs.readdirSync('/proc')) {
      const c = ent.charCodeAt(0);
      if (c < 48 || c > 57) continue;
      const st = readPidStatFull(ent);
      if (st) all.set(+ent, st);
    }
  } catch (_) {}
  const kids = new Map();
  for (const [p, st] of all) {
    let arr = kids.get(st.ppid);
    if (!arr) { arr = []; kids.set(st.ppid, arr); }
    arr.push(p);
  }
  return { all, kids };
}

// Сырой снимок деревьев PTY без дельты CPU (её считает сервис поверх monPrev).
function computePtyTreesRaw(entries, platform = process.platform) {
  if (platform !== 'linux') {
    return { supported: false, total: 0, ncpu: 1, trees: [] };
  }
  const list = Array.isArray(entries) ? entries : [];
  const total = readTotalJiffies();
  const ncpu = (os.cpus() || []).length || 1;
  /** @type {{ all: Map<number, any>, kids: Map<number, number[]> } | null} */
  let fallback = null;
  const trees = [];

  for (const pair of list) {
    const sid = pair && pair[0];
    const root = pair && +pair[1];
    if (!sid || !root) continue;

    let rss = 0;
    let jif = 0;
    let n = 0;
    let topComm = '';

    const desc = pt.descendants(root);
    if (desc !== null) {
      const rootSt = readPidStatFull(root);
      if (rootSt) {
        topComm = rootSt.comm;
        rss += rootSt.rssBytes;
        jif += rootSt.jiffies;
        n++;
        for (const p of desc) {
          const st = readPidStatFull(p);
          if (!st) continue;
          rss += st.rssBytes;
          jif += st.jiffies;
          n++;
        }
      }
    } else {
      if (!fallback) fallback = buildFullProcTree();
      const seen = new Set();
      const stack = [root];
      while (stack.length) {
        const p = /** @type {number} */ (stack.pop());
        if (seen.has(p)) continue;
        seen.add(p);
        const st = fallback.all.get(p);
        if (!st) continue;
        rss += st.rssBytes;
        jif += st.jiffies;
        n++;
        if (p === root) topComm = st.comm;
        const ch = fallback.kids.get(p);
        if (ch) for (const c of ch) stack.push(c);
      }
    }

    trees.push({
      sid: String(sid),
      pid: root,
      comm: topComm,
      procs: n,
      state: pt.foregroundKind(root, platform),
      jiffies: jif,
      memBytes: rss,
    });
  }

  return { supported: true, total, ncpu, trees };
}

function runOpSync(op, payload) {
  const p = payload || {};
  const platform = p.platform || process.platform;
  switch (op) {
    case 'foregroundKind':
      return p.pid ? pt.foregroundKind(+p.pid, platform) : null;
    case 'agentState':
      return p.pid ? as.agentState(+p.pid, platform) : null;
    case 'agents': {
      /** @type {Record<string, any>} */
      const out = {};
      const entries = Array.isArray(p.entries) ? p.entries.slice(0, 500) : [];
      for (const item of entries) {
        const sid = item && item[0];
        const pid = item && +item[1];
        if (!sid || !pid) continue;
        const r = as.agentOf(pid, platform);
        if (r) out[String(sid)] = r;
      }
      return out;
    }
    case 'samplePtyTrees':
      return computePtyTreesRaw(p.entries, platform);
    default:
      throw new Error(`Неизвестная операция proc-service: ${String(op)}`);
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    try {
      const result = runOpSync(msg.op, msg.payload);
      port.postMessage({ id: msg.id, ok: true, result });
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  });
}

/**
 * Создаёт клиент фонового сервиса опроса /proc.
 * @param {{ cacheTtlMs?: number, useWorker?: boolean, platform?: string }} [opts]
 */
function createProcService(opts = {}) {
  const cacheTtlMs = opts.cacheTtlMs == null ? 200 : Math.max(0, +opts.cacheTtlMs || 0);
  const useWorker = opts.useWorker !== false;
  const defaultPlatform = opts.platform || process.platform;

  /** @type {Worker | null} */
  let worker = null;
  let stopped = false;
  let seq = 0;
  /** @type {Map<number, { op: string, payload: any, resolve: (v: any) => void }>} */
  const pending = new Map();
  /** @type {Map<string, { value: any, expiresAt: number }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();
  /** @type {{ total: number, perSid: Map<string, number> } | null} */
  let monPrev = null;

  function flushPendingWithFallback() {
    if (!pending.size) return;
    const jobs = [...pending.values()];
    pending.clear();
    for (const j of jobs) {
      try { j.resolve(runOpSync(j.op, j.payload)); } catch (_) { j.resolve(null); }
    }
  }

  function ensureWorker() {
    if (stopped || !useWorker) return null;
    if (worker) return worker;
    try {
      const w = new Worker(__filename);
      w.unref();
      w.on('message', (msg) => {
        if (!msg || typeof msg.id !== 'number') return;
        const job = pending.get(msg.id);
        if (!job) return;
        pending.delete(msg.id);
        if (msg.ok) job.resolve(msg.result);
        else {
          try { job.resolve(runOpSync(job.op, job.payload)); } catch (_) { job.resolve(null); }
        }
      });
      w.on('error', () => {
        if (worker === w) worker = null;
        flushPendingWithFallback();
      });
      w.on('exit', () => {
        if (worker === w) worker = null;
        flushPendingWithFallback();
      });
      worker = w;
      return w;
    } catch (_) {
      worker = null;
      return null;
    }
  }

  function dispatch(op, payload) {
    const w = ensureWorker();
    if (!w) {
      return Promise.resolve().then(() => runOpSync(op, payload));
    }
    return new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, { op, payload, resolve });
      try {
        w.postMessage({ id, op, payload });
      } catch (_) {
        pending.delete(id);
        resolve(runOpSync(op, payload));
      }
    });
  }

  function cachedCall(key, op, payload) {
    if (cacheTtlMs > 0) {
      const hit = cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);
    }
    const running = inflight.get(key);
    if (running) return running;
    const p = dispatch(op, payload).then((val) => {
      inflight.delete(key);
      if (cacheTtlMs > 0) {
        if (cache.size > 1024) cache.clear();
        cache.set(key, { value: val, expiresAt: Date.now() + cacheTtlMs });
      }
      return val;
    }, (err) => {
      inflight.delete(key);
      throw err;
    });
    inflight.set(key, p);
    return p;
  }

  return {
    foregroundKind(pid, platform = defaultPlatform) {
      if (!pid) return Promise.resolve(null);
      return cachedCall(`fg:${platform}:${pid}`, 'foregroundKind', { pid: +pid, platform });
    },

    agentState(pid, platform = defaultPlatform) {
      if (!pid) return Promise.resolve(null);
      return cachedCall(`as:${platform}:${pid}`, 'agentState', { pid: +pid, platform });
    },

    /**
     * Пакетный опрос терминалов для pty:agents.
     * @param {Array<[string, number]>} entries пары [sessionId, shellPid]
     */
    agents(entries, platform = defaultPlatform) {
      const clean = Array.isArray(entries) ? entries.filter((e) => e && e[0] && e[1]).slice(0, 500) : [];
      if (!clean.length) return Promise.resolve({});
      return dispatch('agents', { entries: clean, platform });
    },

    /**
     * Снимок деревьев процессов PTY для monitor:sample (с расчётом CPU% по дельте jiffies).
     * @param {Array<[string, number]>} entries пары [sessionId, shellPid]
     * @param {(sid: string) => string} [labelOf]
     */
    async samplePtyTrees(entries, labelOf, platform = defaultPlatform) {
      const clean = Array.isArray(entries) ? entries.filter((e) => e && e[0] && e[1]) : [];
      const raw = await dispatch('samplePtyTrees', { entries: clean, platform });
      if (!raw || !raw.supported) {
        return {
          procs: [],
          totalMem: 0,
          totalCpu: 0,
          note: 'Детализация процессов терминалов доступна только на Linux.',
        };
      }
      const dTotal = monPrev ? Math.max(0, raw.total - monPrev.total) : 0;
      const ncpu = raw.ncpu || 1;
      /** @type {Map<string, number>} */
      const nowPer = new Map();
      const procs = [];
      for (const t of raw.trees) {
        nowPer.set(t.sid, t.jiffies);
        let cpu = 0;
        if (monPrev && monPrev.perSid.has(t.sid) && dTotal > 0) {
          const prevJif = monPrev.perSid.get(t.sid) || 0;
          cpu = Math.max(0, Math.round(((t.jiffies - prevJif) / dTotal) * ncpu * 100 * 10) / 10);
        }
        procs.push({
          sid: t.sid,
          pid: t.pid,
          label: labelOf ? labelOf(t.sid) : t.sid,
          comm: t.comm,
          procs: t.procs,
          state: t.state,
          cpu,
          memBytes: t.memBytes,
        });
      }
      procs.sort((a, b) => b.memBytes - a.memBytes);
      monPrev = { total: raw.total, perSid: nowPer };
      const totalMem = procs.reduce((s, p) => s + p.memBytes, 0);
      const totalCpu = Math.round(procs.reduce((s, p) => s + p.cpu, 0) * 10) / 10;
      return { procs, totalMem, totalCpu, note: null };
    },

    resetMonitorPrev() {
      monPrev = null;
    },

    async shutdown() {
      stopped = true;
      cache.clear();
      const w = worker;
      worker = null;
      flushPendingWithFallback();
      if (w) {
        try { await w.terminate(); } catch (_) {}
      }
    },
  };
}

module.exports = {
  createProcService,
  readPidStatFull,
  readTotalJiffies,
  computePtyTreesRaw,
  runOpSync,
};
