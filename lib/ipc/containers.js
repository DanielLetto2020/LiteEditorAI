// Доменный модуль «Контейнеры» (Docker / Podman CLI + удалённый SSH-контекст + стриминг логов/exec).

'use strict';

const { execFile, spawn } = require('child_process');
const {
  guessDbKind, dbPrefillFromInspect,
  guessMqKind, rmqPrefillFromInspect, kafkaPrefillFromInspect,
  guessWebKind, webPrefillFromInspect,
  guessStorageKind, storagePrefillFromInspect,
} = require('../dbdetect');

const CONTAINERS_HANDLES = [
  'containers:remoteSet', 'containers:remoteStatus', 'containers:remoteFix',
  'containers:detect', 'containers:list', 'containers:bulk',
  'containers:logsStart', 'containers:execStart', 'containers:action',
  'containers:inspectDb', 'containers:inspectStorage', 'containers:inspectMq',
  'containers:inspectKafka', 'containers:inspectWeb',
  'containers:fsList', 'containers:fsOpenInViewer',
];
const CONTAINERS_ONS = [
  'containers:logsStop', 'containers:execWrite', 'containers:execResize', 'containers:execKill',
];

const C_FIX_SCRIPTS = {
  'docker-group': 'usermod -aG docker "$SUDO_USER"',
  'podman-socket-group': 'g=$(id -gn "$SUDO_USER"); mkdir -p /etc/systemd/system/podman.socket.d && printf "[Socket]\\nSocketMode=0660\\nSocketGroup=%s\\n" "$g" > /etc/systemd/system/podman.socket.d/50-liteeditor.conf && systemctl daemon-reload && { systemctl stop podman.service 2>/dev/null || true; } && systemctl restart podman.socket',
};
const C_PROJECT = 'com.docker.compose.project', C_SERVICE = 'com.docker.compose.service';
const cBadId = (id) => typeof id !== 'string' || !/^[A-Za-z0-9][\w.:/@-]{0,255}$/.test(id);
const cFirstLine = (s) => String(s || '').split('\n')[0].trim();

function cHumanSize(bytes) {
  const n = Number(bytes); if (!Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}
function cImgCreated(img) {
  const at = img.CreatedAt;
  if (typeof at === 'string' && /^\d{4}-\d\d-\d\d/.test(at)) return at.slice(0, 10);
  const n = Number(img.Created);
  if (Number.isFinite(n) && n > 0) { try { return new Date(n * 1000).toISOString().slice(0, 10); } catch (_) {} }
  return '';
}
function cParseLines(out) {
  const arr = [];
  for (const ln of String(out || '').split('\n')) { const s = ln.trim(); if (!s) continue; try { arr.push(JSON.parse(s)); } catch (_) {} }
  return arr;
}
function cParseJson(out) {
  const s = String(out || '').trim(); if (!s) return [];
  try { const j = JSON.parse(s); return (Array.isArray(j) ? j : [j]).filter((x) => x && typeof x === 'object'); } catch (_) { return cParseLines(out); }
}
function cLabelMap(str) {
  /** @type {Record<string, string>} */
  const m = {};
  for (const part of String(str || '').split(',')) { const i = part.indexOf('='); if (i > 0) m[part.slice(0, i)] = part.slice(i + 1); }
  return m;
}

/**
 * @param {object} deps
 * @param {{ handle: (ch: string, fn: (event: any, ...args: any[]) => any) => void, on: (ch: string, fn: (event: any, ...args: any[]) => any) => void }} deps.ipcMain
 * @param {any} deps.pty
 * @param {any} deps.rhApi
 * @param {(wc: any, ch: string, payload?: any) => void} deps.safeSend
 * @param {(extra?: Record<string, string>) => Record<string, string>} deps.userShellEnv
 * @param {number} deps.maxViewBytes
 * @param {(name: string, content: string) => string} deps.stageTextForViewer
 * @param {(payload: any) => void} deps.routeOpenInViewer
 */
function registerContainersIpc(deps) {
  const { ipcMain, pty, rhApi, safeSend, userShellEnv, maxViewBytes, stageTextForViewer, routeOpenInViewer } = deps;

  /** @type {{ rhId: string, name: string, tunId: string, port: number, cli: string, sockPath: string } | null} */
  let containersRemote = null;
  /** @type {Promise<any> | null} */
  let containersTunnelFix = null;
  const cLogProcs = new Map();
  const cExecPtys = new Map();

  function cRemoteCtx(cli, baseEnv) {
    if (!containersRemote) return { cli, env: undefined };
    const env = { ...(baseEnv || process.env) };
    if (containersRemote.cli === 'docker') env.DOCKER_HOST = 'tcp://127.0.0.1:' + containersRemote.port;
    else env.CONTAINER_HOST = 'tcp://127.0.0.1:' + containersRemote.port;
    return { cli: containersRemote.cli, env };
  }

  /**
   * @param {string} cli
   * @param {string[]} args
   * @param {{ timeout?: number, local?: boolean, env?: any, raw?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, out: string, error: string }>}
   */
  function containerRun(cli, args, opts = {}) {
    const ctx = opts.env ? { cli, env: opts.env } : (opts.local ? { cli } : cRemoteCtx(cli));
    return new Promise((resolve) => {
      execFile(ctx.cli, args, { timeout: opts.timeout || 15000, maxBuffer: 24 * 1024 * 1024, windowsHide: true, env: ctx.env },
        (err, stdout, stderr) => resolve({
          ok: !err, out: opts.raw ? (stdout || '') : (stdout || '').trim(),
          error: err ? ((stderr || '').trim() || String(err.message || err)) : '',
        }));
    });
  }

  ipcMain.handle('containers:remoteSet', async (_e, { rhId, engine } = {}) => {
    if (!rhId) {
      if (containersRemote) { try { rhApi.closeTunnel(containersRemote.tunId); } catch (_) {} containersRemote = null; }
      return { ok: true, rhId: null };
    }
    const conn = rhApi.findConn(rhId);
    if (!conn) return { ok: false, error: 'SSH-профиль не найден' };
    const scan = await rhApi.scan(rhId);
    if (!scan.ok) return { ok: false, error: 'Скан хоста не удался: ' + (scan.error || '') };
    const podmanHint = { ok: false, hint: 'podman-socket', error: 'Podman на хосте установлен, но API-сокет спит (systemctl --user enable --now podman.socket)' };
    const user = conn.user || '<user>';
    const denied = scan.denied || {};
    const deniedErr = async (eng) => {
      const s = await rhApi.exec(rhId, 'command -v sudo >/dev/null 2>&1 && { sudo -n true 2>/dev/null && echo sudo=free || echo sudo=need-pass; } || echo sudo=no', 12000);
      const mode = /sudo=free/.test(s.stdout || '') ? 'free' : (/sudo=need-pass/.test(s.stdout || '') ? 'need-pass' : 'no');
      const canFix = mode === 'free' || (mode === 'need-pass' && conn.auth !== 'key' && conn.auth !== 'agent' && !!conn.passEnc);
      if (eng === 'docker') return {
        ok: false, hint: 'sock-access', canFix, fix: 'docker-group',
        error: `Сокет Docker на хосте есть (${denied.docker}), но у пользователя «${user}» нет к нему доступа.` +
          (canFix ? ' Могу починить сам: добавлю пользователя в группу docker через sudo и сразу переподключусь.' : ' Добавьте его в группу docker (команда ниже) и повторите.'),
        cmd: `sudo sh -c '${C_FIX_SCRIPTS['docker-group']}'`,
      };
      return {
        ok: false, hint: 'sock-access', canFix, fix: 'podman-socket-group',
        error: `Сокет Podman на хосте есть (${denied.podman}), но у пользователя «${user}» нет к нему доступа — это рутовый podman.sock, по умолчанию он только для root.` +
          (canFix ? ' Могу починить сам: выдам группе пользователя право на этот сокет (drop-in systemd + перезапуск podman.socket; контейнеры не затрагиваются) и сразу переподключусь.' : ' Выдайте доступ командой ниже и повторите.'),
        cmd: `sudo sh -c '${C_FIX_SCRIPTS['podman-socket-group']}'`,
      };
    };
    const socks = scan.sockets || {};
    let sockPath;
    if (engine === 'docker' || engine === 'podman') {
      sockPath = socks[engine] || null;
      if (!sockPath && denied[engine]) return await deniedErr(engine);
      if (!sockPath) return (engine === 'podman' && scan.podmanCli) ? podmanHint : { ok: false, error: `На хосте нет сокета ${engine}` };
    } else if (socks.docker && socks.podman) {
      return { ok: true, needChoice: true };
    } else {
      sockPath = socks.docker || socks.podman || null;
      if (!sockPath && (denied.docker || denied.podman)) return await deniedErr(denied.docker ? 'docker' : 'podman');
      if (!sockPath) return scan.podmanCli ? podmanHint : { ok: false, error: 'На хосте нет docker/podman-сокета (docker.sock / podman.sock не найдены)' };
    }
    const isPodman = sockPath.includes('podman');
    const probe = (cli) => containerRun(cli, ['--version'], { timeout: 5000, local: true });
    let cli = null;
    if ((await probe('docker')).ok) cli = 'docker';
    else if (isPodman && (await probe('podman')).ok) cli = 'podman';
    if (!cli) return { ok: false, error: isPodman ? 'Нужен локальный docker или podman CLI' : 'Удалённый демон — Docker: нужен локальный docker CLI' };
    const t = await rhApi.sockTunnel(rhId, sockPath, 'containers: ' + (conn.name || conn.host));
    if (!t.ok) return { ok: false, error: 'Туннель до сокета не поднялся: ' + (t.error || '') };
    const env = { ...process.env };
    if (cli === 'docker') env.DOCKER_HOST = 'tcp://127.0.0.1:' + t.port; else env.CONTAINER_HOST = 'tcp://127.0.0.1:' + t.port;
    const check = await containerRun(cli, ['version'], { timeout: 12000, env });
    if (!check.ok) {
      const chanErr = rhApi.tunnelError(t.tunId);
      try { rhApi.closeTunnel(t.tunId); } catch (_) {}
      let msg = `Демон на хосте не ответил через туннель (${sockPath}): ` + cFirstLine(check.error);
      if (chanErr) msg += ` · SSH-канал: ${chanErr}`;
      if (chanErr && /administratively|prohibited/i.test(chanErr)) msg += '. Похоже, sshd на хосте запрещает проброс unix-сокетов (AllowStreamLocalForwarding/DisableForwarding в sshd_config).';
      else if (sockPath.includes('docker')) msg += `. Чаще всего это права на сокет: пользователь «${user}» не в группе docker.`;
      return { ok: false, hint: 'sock-probe', error: msg, cmd: sockPath.includes('docker') ? `sudo usermod -aG docker ${user}` : undefined };
    }
    if (containersRemote) { try { rhApi.closeTunnel(containersRemote.tunId); } catch (_) {} }
    containersRemote = { rhId, name: conn.name || conn.host, tunId: t.tunId, port: t.port, cli, sockPath };
    return { ok: true, rhId, name: containersRemote.name, engine: cli };
  });

  ipcMain.handle('containers:remoteStatus', () => (containersRemote
    ? { rhId: containersRemote.rhId, name: containersRemote.name, engine: containersRemote.cli }
    : { rhId: null }));

  ipcMain.handle('containers:remoteFix', async (_e, { rhId, fix } = {}) => {
    const conn = rhApi.findConn(rhId);
    if (!conn) return { ok: false, error: 'SSH-профиль не найден' };
    const script = C_FIX_SCRIPTS[fix];
    if (!script) return { ok: false, error: 'Неизвестный тип починки' };
    const r = await rhApi.sudoExec(rhId, script, 45000);
    if (!r.ok) return { ok: false, error: 'Починка не прошла: ' + (r.error || '') + `. Выполните на хосте вручную: sudo sh -c '${script}'` };
    return { ok: true };
  });

  ipcMain.handle('containers:detect', async () => {
    const probe = (cli, args) => containerRun(cli, args, { timeout: 6000, local: true });
    const [dcli, dleg, dplug, pcli, pleg, pplug] = await Promise.all([
      probe('docker', ['--version']), probe('docker-compose', ['--version']), probe('docker', ['compose', 'version']),
      probe('podman', ['--version']), probe('podman-compose', ['--version']), probe('podman', ['compose', 'version']),
    ]);
    const v = (r) => { const fl = cFirstLine(r.out); return r.ok && /v?\d+\.\d+/.test(fl) ? fl : null; };
    return {
      docker: { cli: v(dcli), compose: v(dleg), composePlugin: v(dplug) },
      podman: { cli: v(pcli), compose: v(pleg), composePlugin: v(pplug) },
    };
  });

  async function cListContainers(engine) {
    if (engine === 'docker') {
      const r = await containerRun('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 12000 });
      if (!r.ok) return { error: r.error };
      return { items: cParseLines(r.out).map((c) => { const L = cLabelMap(c.Labels);
        return { id: c.ID, name: c.Names, image: c.Image, state: String(c.State || '').toLowerCase(), status: c.Status, ports: c.Ports || '', project: L[C_PROJECT] || '', service: L[C_SERVICE] || '', dbKind: guessDbKind(c.Image, c.Ports), mqKind: guessMqKind(c.Image, c.Ports), webKind: guessWebKind(c.Image, c.Ports), storageKind: guessStorageKind(c.Image) }; }) };
    }
    const r = await containerRun('podman', ['ps', '-a', '--format', 'json'], { timeout: 12000 });
    if (!r.ok) return { error: r.error };
    return { items: cParseJson(r.out).map((c) => { const L = c.Labels || {};
      const name = Array.isArray(c.Names) ? c.Names[0] : (c.Names || c.Name || '');
      const ports = Array.isArray(c.Ports) ? c.Ports.map((p) => `${p.host_port || p.hostPort || ''}${(p.host_port || p.hostPort) ? ':' : ''}${p.container_port || p.containerPort || ''}`).filter((s) => s && s !== ':').join(', ') : '';
      return { id: c.Id || c.ID, name, image: c.Image, state: String(c.State || '').toLowerCase(), status: c.Status || c.State, ports, project: L[C_PROJECT] || L['io.podman.compose.project'] || '', service: L[C_SERVICE] || '', dbKind: guessDbKind(c.Image, ports), mqKind: guessMqKind(c.Image, ports), webKind: guessWebKind(c.Image, ports), storageKind: guessStorageKind(c.Image) }; }) };
  }

  async function cListPods() {
    const r = await containerRun('podman', ['pod', 'ps', '--format', 'json'], { timeout: 10000 });
    if (!r.ok) return { error: r.error };
    return { items: cParseJson(r.out).map((p) => ({ id: p.Id || p.ID, name: p.Name, status: String(p.Status || '').toLowerCase(), containers: Array.isArray(p.Containers) ? p.Containers.length : (p.NumberOfContainers || 0) })) };
  }

  async function cListImages(engine) {
    const fmt = engine === 'docker' ? '{{json .}}' : 'json';
    const r = await containerRun(engine, ['images', '--format', fmt], { timeout: 12000 });
    if (!r.ok) return { error: r.error };
    if (engine === 'docker') return { items: cParseLines(r.out).map((i) => ({ id: i.ID, repo: i.Repository, tag: i.Tag, size: i.Size, created: i.CreatedSince })) };
    const seen = new Set(), items = [];
    for (const i of cParseJson(r.out)) {
      const names = Array.isArray(i.Names) ? i.Names : (Array.isArray(i.RepoTags) ? i.RepoTags : []);
      const id = String(i.Id || i.ID || '');
      for (const full of (names.length ? names : ['<none>:<none>'])) {
        const key = id + '|' + full; if (seen.has(key)) continue; seen.add(key);
        const ci = full.lastIndexOf(':'); const repo = ci > 0 ? full.slice(0, ci) : full; const tag = ci > 0 ? full.slice(ci + 1) : '';
        items.push({ id: id.slice(0, 12), repo, tag, size: cHumanSize(i.Size), created: cImgCreated(i) });
      }
    }
    return { items };
  }

  async function cListVolumes(engine) {
    const fmt = engine === 'docker' ? '{{json .}}' : 'json';
    const r = await containerRun(engine, ['volume', 'ls', '--format', fmt], { timeout: 10000 });
    if (!r.ok) return { error: r.error };
    const raw = engine === 'docker' ? cParseLines(r.out) : cParseJson(r.out);
    return { items: raw.map((vo) => ({ name: vo.Name, driver: vo.Driver || '' })) };
  }

  async function cListDf(engine) {
    const fmt = engine === 'docker' ? '{{json .}}' : 'json';
    const r = await containerRun(engine, ['system', 'df', '--format', fmt], { timeout: 12000 });
    if (!r.ok) return { error: r.error };
    const raw = engine === 'docker' ? cParseLines(r.out) : cParseJson(r.out);
    /** @type {Record<string, any>} */
    const out = {};
    for (const row of raw) {
      const t = String(row.Type || '').toLowerCase();
      if (t.includes('image')) out.images = row.Size;
      else if (t.includes('container')) out.containers = row.Size;
      else if (t.includes('volume')) out.volumes = row.Size;
      else if (t.includes('build') || t.includes('cache')) out.cache = row.Size;
    }
    return out;
  }

  ipcMain.handle('containers:list', async (_e, { engine, light } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
    if (containersRemote && !rhApi.tunnelAlive(containersRemote.tunId)) {
      const rc = containersRemote;
      if (!containersTunnelFix) {
        containersTunnelFix = rhApi.sockTunnel(rc.rhId, rc.sockPath, 'containers: ' + rc.name)
          .then((t) => {
            if (t.ok && containersRemote === rc) { rc.tunId = t.tunId; rc.port = t.port; }
            else if (t.ok) { try { rhApi.closeTunnel(t.tunId); } catch (_) {} }
            return t;
          })
          .finally(() => { containersTunnelFix = null; });
      }
      const t = await containersTunnelFix;
      if (!t.ok) return { containers: { error: `SSH-туннель к «${rc.name}» оборвался и не восстановился: ` + (t.error || '') } };
    }
    if (light) {
      if (engine === 'podman') {
        const [containers, pods] = await Promise.all([cListContainers(engine), cListPods()]);
        return { containers, pods };
      }
      return { containers: await cListContainers(engine) };
    }
    const [containers, images, volumes, pods, df] = await Promise.all([
      cListContainers(engine), cListImages(engine), cListVolumes(engine),
      engine === 'podman' ? cListPods() : Promise.resolve({ items: [] }),
      cListDf(engine),
    ]);
    return { containers, images, volumes, pods, df };
  });

  ipcMain.handle('containers:bulk', async (_e, { engine, action, ids } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (!Array.isArray(ids) || !ids.length) return { ok: false, error: 'no ids' };
    const verb = ({ start: ['start'], stop: ['stop'], pause: ['pause'], unpause: ['unpause'], restart: ['restart'], remove: ['rm', '-f'] })[action];
    if (!verb) return { ok: false, error: 'bad action' };
    const failed = [];
    for (const id of ids) { if (cBadId(id)) continue; const r = await containerRun(engine, [...verb, id], { timeout: 60000 }); if (!r.ok) failed.push(r.error); }
    return failed.length ? { ok: false, error: failed.join('; ') } : { ok: true };
  });

  ipcMain.handle('containers:logsStart', (e, { engine, id, streamId, tail } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
    if (cBadId(id) || !streamId) return { error: 'bad args' };
    let cp;
    const lctx = cRemoteCtx(engine);
    try { cp = spawn(lctx.cli, ['logs', '-f', '--tail', String(Math.max(1, Math.min(5000, parseInt(tail, 10) || 500))), id], { windowsHide: true, env: lctx.env }); }
    catch (e2) { return { error: String((e2 && e2.message) || e2) }; }
    const sender = e.sender;
    const send = (d) => safeSend(sender, 'containers:logsData', { streamId, data: d.toString('utf8') });
    cp.stdout.setEncoding('utf8'); cp.stderr.setEncoding('utf8');
    cp.stdout.on('data', send); cp.stderr.on('data', send);
    cp.on('error', (err) => send('\n[ошибка logs: ' + (err.message || err) + ']\n'));
    cp.on('close', () => { cLogProcs.delete(streamId); safeSend(sender, 'containers:logsExit', { streamId }); });
    cLogProcs.set(streamId, cp);
    return { ok: true };
  });
  ipcMain.on('containers:logsStop', (_e, { streamId } = {}) => { const cp = cLogProcs.get(streamId); if (cp) { try { cp.kill(); } catch (_) {} cLogProcs.delete(streamId); } });

  ipcMain.handle('containers:execStart', (e, { engine, id, execId, cols, rows } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { error: 'bad engine' };
    if (cBadId(id) || !execId) return { error: 'bad args' };
    let proc;
    const xctx = cRemoteCtx(engine, userShellEnv());
    try {
      proc = pty.spawn(xctx.cli, ['exec', '-it', id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
        { name: 'xterm-color', cols: cols || 80, rows: rows || 24, env: xctx.env || userShellEnv() });
    } catch (e2) { return { error: String((e2 && e2.message) || e2) }; }
    const sender = e.sender;
    proc.onData((d) => safeSend(sender, 'containers:execData', { execId, data: d }));
    proc.onExit(() => { cExecPtys.delete(execId); safeSend(sender, 'containers:execExit', { execId }); });
    cExecPtys.set(execId, proc);
    return { ok: true };
  });
  ipcMain.on('containers:execWrite', (_e, { execId, data } = {}) => { const p = cExecPtys.get(execId); if (p) p.write(data); });
  ipcMain.on('containers:execResize', (_e, { execId, cols, rows } = {}) => { const p = cExecPtys.get(execId); if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch (_) {} } });
  ipcMain.on('containers:execKill', (_e, { execId } = {}) => { const p = cExecPtys.get(execId); if (p) { try { p.kill(); } catch (_) {} cExecPtys.delete(execId); } });

  ipcMain.handle('containers:action', async (_e, { engine, kind, action, id } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id)) return { ok: false, error: 'no id' };
    let args = null;
    if (kind === 'container') args = ({ start: ['start', id], stop: ['stop', id], pause: ['pause', id], unpause: ['unpause', id], restart: ['restart', id], remove: ['rm', '-f', id] })[action];
    else if (kind === 'pod') args = ({ start: ['pod', 'start', id], stop: ['pod', 'stop', id], remove: ['pod', 'rm', '-f', id] })[action];
    else if (kind === 'image' && action === 'remove') args = ['rmi', '-f', id];
    else if (kind === 'volume' && action === 'remove') args = ['volume', 'rm', id];
    if (!args) return { ok: false, error: 'bad action' };
    const r = await containerRun(engine, args, { timeout: 60000 });
    return { ok: r.ok, error: r.error };
  });

  ipcMain.handle('containers:inspectDb', async (_e, { engine, id } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id)) return { ok: false, error: 'no id' };
    const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
    if (!r.ok) return { ok: false, error: r.error };
    const info = cParseJson(r.out)[0];
    if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
    const res = dbPrefillFromInspect(info, engine);
    if (!res) return { ok: false, error: 'В контейнере не распознана поддерживаемая БД (PostgreSQL / MySQL / MariaDB)' };
    if (containersRemote) {
      const conn = rhApi.findConn(containersRemote.rhId);
      if (conn) {
        /** @type {any} */
        const p = res.prefill;
        p.name += ' @ ' + (conn.name || conn.host);
        p.source = 'rh:' + containersRemote.rhId + ':' + p.source;
        p.sshEnabled = true; p.sshHost = conn.host; p.sshPort = +conn.port || 22; p.sshUser = conn.user || '';
        if (conn.auth === 'key') { p.sshKeyEnc = conn.keyEnc || ''; p.sshPassEnc = conn.passphraseEnc || ''; }
        else if (conn.auth !== 'agent') p.sshPassEnc = conn.passEnc || '';
      }
    }
    return { ok: true, ...res };
  });

  ipcMain.handle('containers:inspectStorage', async (_e, { engine, id } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id)) return { ok: false, error: 'no id' };
    const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
    if (!r.ok) return { ok: false, error: r.error };
    const info = cParseJson(r.out)[0];
    if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
    const res = storagePrefillFromInspect(info, engine);
    if (!res) return { ok: false, error: 'В контейнере не распознано S3-хранилище (MinIO)' };
    return { ok: true, ...res };
  });

  ipcMain.handle('containers:inspectMq', async (_e, { engine, id } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id)) return { ok: false, error: 'no id' };
    const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
    if (!r.ok) return { ok: false, error: r.error };
    const info = cParseJson(r.out)[0];
    if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
    const res = rmqPrefillFromInspect(info, engine);
    if (!res) return { ok: false, error: 'В контейнере не распознан RabbitMQ' };
    return { ok: true, ...res };
  });

  ipcMain.handle('containers:inspectKafka', async (_e, { engine, id } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id)) return { ok: false, error: 'no id' };
    const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
    if (!r.ok) return { ok: false, error: r.error };
    const info = cParseJson(r.out)[0];
    if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
    const res = kafkaPrefillFromInspect(info, engine);
    if (!res) return { ok: false, error: 'В контейнере не распознан Kafka' };
    return { ok: true, ...res };
  });

  ipcMain.handle('containers:inspectWeb', async (_e, { engine, id } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id)) return { ok: false, error: 'no id' };
    const r = await containerRun(engine, ['inspect', id], { timeout: 12000 });
    if (!r.ok) return { ok: false, error: r.error };
    const info = cParseJson(r.out)[0];
    if (!info) return { ok: false, error: 'inspect вернул пустой ответ' };
    const res = webPrefillFromInspect(info, engine);
    if (!res) return { ok: false, error: 'В контейнере не распознан веб-сервис' };
    return { ok: true, ...res };
  });

  ipcMain.handle('containers:fsList', async (_e, { engine, id, path: p } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id)) return { ok: false, error: 'no id' };
    const dir = '/' + String(p || '/').replace(/^\/+/, '');
    const r = await containerRun(engine, ['exec', id, 'ls', '-1Ap', dir], { timeout: 12000 });
    if (!r.ok && !r.out) return { ok: false, error: r.error || 'ls не выполнился (контейнер запущен?)' };
    const entries = [];
    for (const ln of r.out.split('\n')) {
      const name = ln.trim(); if (!name) continue;
      const isDir = name.endsWith('/');
      entries.push({ name: isDir ? name.slice(0, -1) : name, dir: isDir });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)));
    return { ok: true, path: dir, entries };
  });

  ipcMain.handle('containers:fsOpenInViewer', async (_e, { engine, id, path: p } = {}) => {
    if (engine !== 'docker' && engine !== 'podman') return { ok: false, error: 'bad engine' };
    if (cBadId(id) || !p) return { ok: false, error: 'no id/path' };
    const file = '/' + String(p).replace(/^\/+/, '');
    const r = await containerRun(engine, ['exec', id, 'cat', file], { timeout: 15000, raw: true });
    if (!r.ok && /is a directory/i.test(r.error || '')) return { ok: false, dir: true, error: r.error };
    if (!r.ok) return { ok: false, error: r.error || 'cat не выполнился (контейнер запущен?)' };
    if (r.out.length > maxViewBytes) return { ok: false, error: 'Файл слишком большой для просмотра (> 2 МБ)' };
    if (r.out.slice(0, 8192).includes('\0')) return { ok: false, error: 'Бинарный файл — просмотр не поддерживается' };
    try {
      const staged = stageTextForViewer(file.split('/').filter(Boolean).pop() || 'container.txt', r.out);
      routeOpenInViewer({ path: staged });
      return { ok: true, file: staged };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  function closeStreams() {
    for (const cp of cLogProcs.values()) { try { cp.kill(); } catch (_) {} }
    cLogProcs.clear();
    for (const proc of cExecPtys.values()) { try { proc.kill(); } catch (_) {} }
    cExecPtys.clear();
  }

  return { closeStreams };
}

module.exports = { registerContainersIpc, CONTAINERS_HANDLES, CONTAINERS_ONS };
