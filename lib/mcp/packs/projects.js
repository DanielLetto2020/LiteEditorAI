// MCP-пак для кросс-проектного read-only чтения файлов и Git-статуса привязанных проектов LiteEditor.
'use strict';

const fs = require('fs');
const path = require('path');
const { defineMcpPack } = require('../pack');
const { isResourceBound } = require('../policy');
const { isSensitivePath, redactText, sanitizeText } = require('../redact');
const gitignore = require('../../gitignore');

const MAX_READ_BYTES = 128 * 1024;
const MAX_TREE_ENTRIES = 500;
const MAX_SEARCH_MATCHES = 100;
const MAX_WALK_FILES = 3000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;

function clamp(n, lo, hi, d) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
}

function listProjectsList(deps) {
  const arr = typeof deps.getProjects === 'function' ? deps.getProjects() : [];
  return Array.isArray(arr) ? arr.filter((p) => p && p.id && p.path) : [];
}

function findProjectMeta(deps, id, session) {
  if (!id) return null;
  const pid = String(id);
  const p = listProjectsList(deps).find((x) => x.id === pid);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name || path.basename(p.path) || p.id,
    path: p.path,
    isSelf: !!(session && session.projectId === p.id),
    isProd: false,
  };
}

function requireProject(deps, id, session) {
  const meta = findProjectMeta(deps, id, session);
  if (!meta) throw new Error(`Проект «${id}» не найден`);
  let realRoot;
  try {
    realRoot = fs.realpathSync(meta.path);
  } catch (err) {
    throw new Error(`Каталог проекта «${meta.name}» недоступен`, { cause: err });
  }
  return { meta, realRoot };
}

function isInsideRoot(realRoot, targetReal) {
  if (targetReal === realRoot) return true;
  const rel = path.relative(realRoot, targetReal);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Безопасное разрешение пути внутри корня проекта с блокировкой симлинков,
 * выходов за корень (..) и чувствительных файлов (.env, ключи, секреты).
 */
function safeResolveInProject(realRoot, relPath, { allowRoot = false } = {}) {
  const raw = String(relPath == null ? '.' : relPath).replace(/\\/g, '/').trim() || '.';
  if (raw.includes('\0')) throw new Error('Некорректный путь (NUL)');
  if (path.isAbsolute(raw)) throw new Error('Допустимы только относительные пути внутри проекта');

  const candidate = path.resolve(realRoot, raw);
  const normRel = path.relative(realRoot, candidate).replace(/\\/g, '/');
  if (normRel.startsWith('..') || path.isAbsolute(normRel)) {
    throw new Error('Выход за границы корня проекта запрещён');
  }
  if (!allowRoot && (!normRel || normRel === '.')) {
    throw new Error('Укажите относительный путь к файлу');
  }

  let realTarget;
  try {
    realTarget = fs.realpathSync(candidate);
  } catch (err) {
    throw new Error(`Путь не найден: ${raw}`, { cause: err });
  }
  if (!isInsideRoot(realRoot, realTarget)) {
    throw new Error('Симлинк указывает за пределы проекта — доступ заблокирован');
  }

  const realRel = path.relative(realRoot, realTarget).replace(/\\/g, '/');
  if (realRel) {
    const sensRel = isSensitivePath('/' + normRel);
    if (sensRel.blocked) throw new Error(`Доступ к файлу заблокирован: ${sensRel.reason}`);
    const sensReal = isSensitivePath('/' + realRel);
    if (sensReal.blocked) throw new Error(`Доступ к файлу заблокирован: ${sensReal.reason}`);
  }

  return { realTarget, normRel: realRel || '.' };
}

function createProjectsPack() {
  return defineMcpPack({
    id: 'projects',
    name: 'Проекты и код',
    description: 'Cross-project read-only доступ к дереву, файлам, поиску и Git-статусу только явно привязанных проектов LiteEditor.',
    version: '1.0.0',
    scopes: ['read'],
    async resolveResources(deps) {
      return listProjectsList(deps).map((p) => ({
        type: 'project',
        id: p.id,
        name: p.name || path.basename(p.path) || p.id,
        subtitle: p.path,
        isProd: false,
      }));
    },
    tools: [
      {
        name: 'project_list',
        title: 'Список доступных проектов',
        description: 'Показать проекты LiteEditor, доступные для чтения текущей сессии (текущий + привязанные по политике Zero-Trust).',
        mode: 'read',
        resourceType: 'project',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        extractResource: () => ({ type: 'project', id: null, discovery: true }),
        async handler(_args, ctx) {
          const all = listProjectsList(ctx.deps);
          const projects = [];
          let unboundCount = 0;
          for (const p of all) {
            const isSelf = p.id === ctx.session.projectId;
            if (isResourceBound(ctx.binding, 'project', p.id, { isSelf })) {
              projects.push({ id: p.id, name: p.name || path.basename(p.path) || p.id, path: p.path, isSelf });
            } else {
              unboundCount++;
            }
          }
          return { ok: true, projects, unboundCount };
        },
      },
      {
        name: 'project_tree',
        title: 'Дерево каталогов проекта',
        description: 'Безопасный обход каталогов проекта с учётом .gitignore (без симлинков наружу, до 500 записей).',
        mode: 'read',
        resourceType: 'project',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            path: { type: 'string' },
            depth: { type: 'number', minimum: 1, maximum: 5 },
          },
          required: ['projectId'],
          additionalProperties: false,
        },
        extractResource: (args, deps, session) => ({
          type: 'project',
          id: args.projectId,
          meta: findProjectMeta(deps, args.projectId, session),
        }),
        async handler(args, ctx) {
          const { realRoot } = requireProject(ctx.deps, args.projectId, ctx.session);
          const { realTarget, normRel } = safeResolveInProject(realRoot, args.path || '.', { allowRoot: true });
          const st = fs.statSync(realTarget);
          if (!st.isDirectory()) throw new Error('Указанный путь не является каталогом');

          const maxDepth = clamp(args.depth, 1, 5, 2);
          const gi = gitignore.forProject(realRoot);
          const entries = [];
          let truncated = false;

          function walk(dirReal, relPrefix, depth) {
            if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
            let list;
            try { list = fs.readdirSync(dirReal, { withFileTypes: true }); }
            catch (_) { return; }
            list.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
            for (const de of list) {
              if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
              if (de.isSymbolicLink()) continue; // не следуем за симлинками
              const rel = relPrefix && relPrefix !== '.' ? `${relPrefix}/${de.name}` : de.name;
              const isDir = de.isDirectory();
              if (gi.ignores(rel, isDir)) continue;
              if (!isDir && isSensitivePath('/' + rel).blocked) continue;
              entries.push({ path: rel, type: isDir ? 'dir' : 'file' });
              if (isDir && depth < maxDepth) {
                walk(path.join(dirReal, de.name), rel, depth + 1);
              }
            }
          }

          walk(realTarget, normRel, 1);
          return { ok: true, projectId: String(args.projectId), root: normRel, entries, truncated };
        },
      },
      {
        name: 'project_read_file',
        title: 'Чтение файла проекта',
        description: 'Прочитать текстовый файл привязанного проекта (до 128 КБ; бинарные файлы и секреты вроде .env и ключей заблокированы).',
        mode: 'read',
        resourceType: 'project',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            path: { type: 'string' },
            maxBytes: { type: 'number', minimum: 256, maximum: 131072 },
          },
          required: ['projectId', 'path'],
          additionalProperties: false,
        },
        extractResource: (args, deps, session) => ({
          type: 'project',
          id: args.projectId,
          meta: findProjectMeta(deps, args.projectId, session),
        }),
        async handler(args, ctx) {
          const { realRoot } = requireProject(ctx.deps, args.projectId, ctx.session);
          const { realTarget, normRel } = safeResolveInProject(realRoot, args.path, { allowRoot: false });
          const st = fs.statSync(realTarget);
          if (!st.isFile()) throw new Error('Указанный путь не является файлом');

          const cap = clamp(args.maxBytes, 256, MAX_READ_BYTES, 65536);
          const fd = fs.openSync(realTarget, 'r');
          let buf;
          try {
            const readLen = Math.min(st.size, cap);
            buf = Buffer.allocUnsafe(readLen);
            const n = readLen > 0 ? fs.readSync(fd, buf, 0, readLen, 0) : 0;
            buf = buf.subarray(0, n);
          } finally {
            try { fs.closeSync(fd); } catch (_) {}
          }
          if (buf.includes(0)) {
            return { ok: true, path: normRel, kind: 'binary', size: st.size, note: 'Бинарный файл не возвращается' };
          }
          return {
            ok: true,
            path: normRel,
            kind: 'text',
            size: st.size,
            truncated: st.size > cap,
            content: sanitizeText(redactText(buf.toString('utf8')), cap),
          };
        },
      },
      {
        name: 'project_search',
        title: 'Поиск текста в проекте',
        description: 'Безопасный поиск подстроки в файлах проекта (учитывает .gitignore, пропускает бинарные файлы, секреты и симлинки).',
        mode: 'read',
        resourceType: 'project',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            query: { type: 'string', minLength: 1, maxLength: 200 },
            path: { type: 'string' },
            caseSensitive: { type: 'boolean' },
            limit: { type: 'number', minimum: 1, maximum: 100 },
          },
          required: ['projectId', 'query'],
          additionalProperties: false,
        },
        extractResource: (args, deps, session) => ({
          type: 'project',
          id: args.projectId,
          meta: findProjectMeta(deps, args.projectId, session),
        }),
        async handler(args, ctx) {
          const { realRoot } = requireProject(ctx.deps, args.projectId, ctx.session);
          const { realTarget, normRel } = safeResolveInProject(realRoot, args.path || '.', { allowRoot: true });
          const st = fs.statSync(realTarget);
          if (!st.isDirectory()) throw new Error('Указанный путь не является каталогом');

          const q = String(args.query);
          const qNeedle = args.caseSensitive ? q : q.toLowerCase();
          const limit = clamp(args.limit, 1, MAX_SEARCH_MATCHES, 50);
          const gi = gitignore.forProject(realRoot);
          const matches = [];
          let scannedFiles = 0;
          let readFailed = 0;
          let truncated = false;

          function scanFile(fileReal, rel) {
            let fst;
            try { fst = fs.statSync(fileReal); } catch (_) { readFailed++; return; }
            if (!fst.isFile() || fst.size > MAX_SEARCH_FILE_BYTES) return;
            let raw;
            try { raw = fs.readFileSync(fileReal); } catch (_) { readFailed++; return; }
            if (raw.includes(0)) return;
            const lines = raw.toString('utf8').split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const hay = args.caseSensitive ? lines[i] : lines[i].toLowerCase();
              if (hay.includes(qNeedle)) {
                matches.push({ path: rel, line: i + 1, text: sanitizeText(redactText(lines[i]), 300) });
                if (matches.length >= limit) { truncated = true; return; }
              }
            }
          }

          function walk(dirReal, relPrefix) {
            if (truncated || scannedFiles >= MAX_WALK_FILES) { truncated = true; return; }
            let list;
            try { list = fs.readdirSync(dirReal, { withFileTypes: true }); }
            catch (_) { readFailed++; return; }
            for (const de of list) {
              if (truncated || scannedFiles >= MAX_WALK_FILES) { truncated = true; return; }
              if (de.isSymbolicLink()) continue;
              const rel = relPrefix && relPrefix !== '.' ? `${relPrefix}/${de.name}` : de.name;
              const isDir = de.isDirectory();
              if (gi.ignores(rel, isDir)) continue;
              if (isDir) {
                walk(path.join(dirReal, de.name), rel);
              } else {
                if (isSensitivePath('/' + rel).blocked) continue;
                scannedFiles++;
                scanFile(path.join(dirReal, de.name), rel);
              }
            }
          }

          walk(realTarget, normRel);
          return { ok: true, matches, scannedFiles, readFailed, truncated };
        },
      },
      {
        name: 'project_git_status',
        title: 'Git-статус проекта',
        description: 'Текущая ветка, изменённые файлы и 5 последних коммитов проекта.',
        mode: 'read',
        resourceType: 'project',
        inputSchema: {
          type: 'object',
          properties: { projectId: { type: 'string' } },
          required: ['projectId'],
          additionalProperties: false,
        },
        extractResource: (args, deps, session) => ({
          type: 'project',
          id: args.projectId,
          meta: findProjectMeta(deps, args.projectId, session),
        }),
        async handler(args, ctx) {
          const { realRoot } = requireProject(ctx.deps, args.projectId, ctx.session);
          const gh = ctx.deps.gitHelpers;
          if (!gh || typeof gh.git !== 'function') throw new Error('Git-подсистема недоступна');
          const { baseArgs } = typeof gh.gitWorkBase === 'function' ? gh.gitWorkBase(realRoot) : { baseArgs: ['-C', realRoot] };
          const branchRes = await gh.git([...baseArgs, 'rev-parse', '--abbrev-ref', 'HEAD'], realRoot);
          const statusRes = await gh.git([...baseArgs, 'status', '--porcelain', '-b', '--', '.'], realRoot);
          const logRes = await gh.git([...baseArgs, 'log', '-n', '5', '--oneline', '--', '.'], realRoot);
          return {
            ok: true,
            branch: String(branchRes.out || branchRes.stdout || '').trim(),
            status: sanitizeText(redactText(String(statusRes.out || statusRes.stdout || '')), 16384),
            recentCommits: sanitizeText(redactText(String(logRes.out || logRes.stdout || '')), 4096),
          };
        },
      },
    ],
  });
}

module.exports = { createProjectsPack, _test: { safeResolveInProject, isInsideRoot } };
