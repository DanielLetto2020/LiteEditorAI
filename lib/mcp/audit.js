// Журнал аудита MCP-вызовов (кольцевой буфер в памяти + NDJSON на диск с ротацией).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactValue, sanitizeText } = require('./redact');

const AUDIT_FILE_RE = /^mcp-audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** @param {number} [ts] */
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Создать хранилище аудита MCP.
 * @param {object} [opts]
 * @param {string | null} [opts.logsDir]
 * @param {boolean} [opts.persistToDisk]
 * @param {number} [opts.maxRam]
 * @param {number} [opts.maxDays]
 * @param {number} [opts.maxFileBytes]
 */
function createAuditLog(opts = {}) {
  const logsDir = opts.logsDir || null;
  let persistToDisk = opts.persistToDisk !== false && !!logsDir;
  const maxRam = Math.max(50, Number(opts.maxRam) || 1000);
  const maxDays = Math.max(1, Number(opts.maxDays) || 14);
  const maxFileBytes = Math.max(1024 * 1024, Number(opts.maxFileBytes) || (50 * 1024 * 1024));

  /** @type {any[]} */
  const entries = [];
  /** @type {Map<string, any>} */
  const byId = new Map();
  let lastPruneDay = '';

  function ensureDir() {
    if (!logsDir) return false;
    try { fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 }); return true; }
    catch (_) { return false; }
  }

  function pruneOldFiles() {
    if (!logsDir) return;
    const today = dayKey();
    if (today === lastPruneDay) return;
    lastPruneDay = today;
    const cutoff = Date.now() - maxDays * 86400000;
    try {
      for (const name of fs.readdirSync(logsDir)) {
        const m = AUDIT_FILE_RE.exec(name);
        if (!m) continue;
        const ts = Date.parse(m[1] + 'T00:00:00Z');
        if (Number.isFinite(ts) && ts < cutoff) {
          try { fs.unlinkSync(path.join(logsDir, name)); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  /** @param {any} rec */
  function appendDisk(rec) {
    if (!persistToDisk || !logsDir) return;
    if (!ensureDir()) return;
    pruneOldFiles();
    const fp = path.join(logsDir, `mcp-audit-${dayKey(rec.ts)}.jsonl`);
    try {
      try {
        const st = fs.statSync(fp);
        if (st.size >= maxFileBytes) {
          const rot = path.join(logsDir, `mcp-audit-${dayKey(rec.ts)}.${Date.now()}.jsonl`);
          fs.renameSync(fp, rot);
        }
      } catch (_) {}
      const line = JSON.stringify(rec) + '\n';
      fs.appendFileSync(fp, line, { encoding: 'utf8', mode: 0o600 });
    } catch (_) {}
  }

  /** @param {any} input */
  function createEntry(input) {
    const rec = {
      id: input.id || ('mcpe_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex')),
      ts: input.ts || Date.now(),
      sessionId: String(input.sessionId || ''),
      ptyId: String(input.ptyId || ''),
      agentKind: String(input.agentKind || 'unknown'),
      projectId: String(input.projectId || '__global__'),
      projectName: sanitizeText(input.projectName || '', 120),
      pack: String(input.pack || ''),
      tool: String(input.tool || ''),
      resourceType: String(input.resourceType || 'none'),
      resourceId: input.resourceId != null ? String(input.resourceId) : null,
      resourceName: sanitizeText(input.resourceName || '', 160),
      status: String(input.status || 'running'),
      durationMs: Number(input.durationMs || 0),
      bytesIn: Number(input.bytesIn || 0),
      bytesOut: Number(input.bytesOut || 0),
      previewArgs: redactValue(input.previewArgs || {}, { maxStringBytes: 1024 }),
      previewOut: input.previewOut != null ? sanitizeText(String(input.previewOut), 2048) : '',
      sql: input.sql ? sanitizeText(String(input.sql), 4096) : null,
      error: input.error ? sanitizeText(String(input.error), 1024) : null,
      approvalId: input.approvalId || null,
      policyNote: input.policyNote ? sanitizeText(String(input.policyNote), 256) : null,
    };
    entries.push(rec);
    byId.set(rec.id, rec);
    while (entries.length > maxRam) {
      const dropped = entries.shift();
      if (dropped) byId.delete(dropped.id);
    }
    if (rec.status !== 'pending_approval' && rec.status !== 'running') {
      appendDisk(rec);
    }
    return rec;
  }

  /** @param {string} id @param {Record<string, any>} patch */
  function updateEntry(id, patch) {
    const rec = byId.get(id);
    if (!rec) return null;
    if (patch.status != null) rec.status = String(patch.status);
    if (patch.durationMs != null) rec.durationMs = Number(patch.durationMs);
    if (patch.bytesOut != null) rec.bytesOut = Number(patch.bytesOut);
    if (patch.previewOut != null) rec.previewOut = sanitizeText(String(patch.previewOut), 2048);
    if (patch.error !== undefined) rec.error = patch.error ? sanitizeText(String(patch.error), 1024) : null;
    if (patch.resourceName != null) rec.resourceName = sanitizeText(patch.resourceName, 160);
    if (patch.policyNote !== undefined) rec.policyNote = patch.policyNote ? sanitizeText(String(patch.policyNote), 256) : null;
    if (patch.approvalId !== undefined) rec.approvalId = patch.approvalId || null;
    if (rec.status !== 'pending_approval' && rec.status !== 'running') {
      appendDisk(rec);
    }
    return rec;
  }

  /**
   * Выбрать записи журнала с фильтрацией (новые сверху).
   * @param {{ projectId?: string, sessionId?: string, pack?: string, tool?: string, status?: string, limit?: number }} [filter]
   */
  function query(filter = {}) {
    const lim = Math.max(1, Math.min(maxRam, Number(filter.limit) || 200));
    const out = [];
    for (let i = entries.length - 1; i >= 0 && out.length < lim; i--) {
      const e = entries[i];
      if (filter.projectId && e.projectId !== filter.projectId) continue;
      if (filter.sessionId && e.sessionId !== filter.sessionId) continue;
      if (filter.pack && e.pack !== filter.pack) continue;
      if (filter.tool && e.tool !== filter.tool) continue;
      if (filter.status && e.status !== filter.status) continue;
      out.push(e);
    }
    return out;
  }

  function stats() {
    let ok = 0, err = 0, denied = 0, pending = 0;
    for (const e of entries) {
      if (e.status === 'ok') ok++;
      else if (e.status === 'denied') denied++;
      else if (e.status === 'pending_approval') pending++;
      else if (e.status === 'error' || e.status === 'timeout') err++;
    }
    return { total: entries.length, ok, err, denied, pending };
  }

  function clear() {
    entries.length = 0;
    byId.clear();
  }

  /** @param {boolean} on */
  function setPersist(on) {
    persistToDisk = !!on && !!logsDir;
  }

  return {
    createEntry,
    updateEntry,
    query,
    stats,
    clear,
    setPersist,
  };
}

module.exports = {
  createAuditLog,
  dayKey,
};
