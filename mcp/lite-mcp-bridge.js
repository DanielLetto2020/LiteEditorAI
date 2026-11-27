#!/usr/bin/env node
// Нуль-зависимый stdio ↔ UDS/NamedPipe MCP-мост для Claude Code, Antigravity, Codex и Gemini CLI.
'use strict';

const net = require('net');
const os = require('os');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sock' && argv[i + 1]) out.sock = argv[++i];
    else if (a === '--token' && argv[i + 1]) out.token = argv[++i];
    else if (a === '--session' && argv[i + 1]) out.session = argv[++i];
    else if (a === '--agent' && argv[i + 1]) out.agent = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const defaultSock = process.platform === 'win32'
  ? ''
  : path.join(os.homedir(), '.LiteEditorAI', 'run', 'mcp.sock');

// Приоритет у PTY-окружения, чтобы внутри вкладки терминала всегда использовался токен её проекта.
const sockPath = process.env.LITEEDITOR_MCP_SOCK || args.sock || defaultSock;
const token = process.env.LITEEDITOR_MCP_TOKEN || args.token || '';
const sessionId = process.env.LITEEDITOR_MCP_SESSION || args.session || '';
const agentKind = process.env.LITEEDITOR_MCP_AGENT || args.agent || 'unknown';

const MAX_IN_BUFFER = 4 * 1024 * 1024;
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'lite-editor-mcp', version: '1.0.0' };
const INSTRUCTIONS = [
  'LiteEditor Zero-Trust MCP Hub.',
  'Вызовы ограничены ресурсами, привязанными к активному проекту.',
  'Начните с инструментов обнаружения (db_list_connections, srv_list, rh_scan_services, ctr_detect).',
].join(' ');

let client = null;
let authed = false;
let connecting = null;
let reqSeq = 0;
let sockBuf = Buffer.alloc(0);
let stdinBuf = Buffer.alloc(0);
let useContentLength = false;

/** @type {Map<string, { rpcId: any }>} */
const inflight = new Map();

function writeStdout(msg) {
  const json = JSON.stringify(msg);
  if (useContentLength) {
    const body = Buffer.from(json, 'utf8');
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  } else {
    process.stdout.write(json + '\n');
  }
}

function sendRpcResult(id, result) {
  writeStdout({ jsonrpc: '2.0', id, result });
}

function sendRpcError(id, code, message, data) {
  writeStdout({ jsonrpc: '2.0', id, error: data !== undefined ? { code, message, data } : { code, message } });
}

function sendToHub(obj) {
  if (!client || client.destroyed) return false;
  client.write(JSON.stringify(obj) + '\n');
  return true;
}

function failAllInflight(message) {
  for (const [hubId, entry] of inflight) {
    inflight.delete(hubId);
    sendRpcError(entry.rpcId, -32000, message);
  }
}

function connectHub() {
  if (authed && client && !client.destroyed) return Promise.resolve();
  if (connecting) return connecting;
  if (!sockPath) return Promise.reject(new Error('Не задан LITEEDITOR_MCP_SOCK'));
  if (!token) return Promise.reject(new Error('Не задан LITEEDITOR_MCP_TOKEN'));

  connecting = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      connecting = null;
      if (err) reject(err);
      else resolve();
    };

    const s = net.createConnection(sockPath);
    client = s;
    authed = false;
    sockBuf = Buffer.alloc(0);

    const timer = setTimeout(() => {
      try { s.destroy(); } catch (_) {}
      finish(new Error('Таймаут подключения к LiteEditor MCP Hub'));
    }, 8000);

    s.on('connect', () => {
      s.write(JSON.stringify({ type: 'auth', token, sessionId, agentKind }) + '\n');
    });

    s.on('data', (chunk) => {
      sockBuf = Buffer.concat([sockBuf, chunk]);
      if (sockBuf.length > MAX_IN_BUFFER) {
        s.destroy(new Error('Превышен размер буфера ответа Hub'));
        return;
      }
      let nl;
      while ((nl = sockBuf.indexOf(0x0a)) >= 0) {
        const line = sockBuf.subarray(0, nl).toString('utf8').trim();
        sockBuf = sockBuf.subarray(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.type === 'auth_ok') {
          clearTimeout(timer);
          authed = true;
          finish(null);
          continue;
        }
        if (msg.type === 'auth_err') {
          clearTimeout(timer);
          const err = new Error(msg.error || 'Ошибка авторизации MCP Hub');
          try { s.destroy(); } catch (_) {}
          finish(err);
          return;
        }
        if (msg.type === 'notification' && msg.method) {
          writeStdout({ jsonrpc: '2.0', method: msg.method, params: msg.params || {} });
          continue;
        }
        if (msg.type === 'response' && msg.id != null) {
          const pend = inflight.get(String(msg.id));
          if (!pend) continue;
          inflight.delete(String(msg.id));
          if (msg.error) sendRpcError(pend.rpcId, msg.error.code || -32000, msg.error.message || 'MCP error');
          else sendRpcResult(pend.rpcId, msg.result || {});
        }
      }
    });

    s.on('error', (err) => {
      clearTimeout(timer);
      authed = false;
      failAllInflight(err.message || 'Потеряна связь с MCP Hub');
      finish(err);
    });

    s.on('close', () => {
      clearTimeout(timer);
      authed = false;
      if (client === s) client = null;
      failAllInflight('Соединение с LiteEditor MCP Hub закрыто');
      finish(new Error('Соединение с LiteEditor MCP Hub закрыто'));
    });
  });

  return connecting;
}

async function forwardHubRequest(rpcId, method, params) {
  try {
    await connectHub();
  } catch (e) {
    sendRpcError(rpcId, -32000, String((e && e.message) || e));
    return;
  }
  const hubId = String(++reqSeq);
  inflight.set(hubId, { rpcId });
  const ok = sendToHub({ type: 'request', id: hubId, method, params: params || {} });
  if (!ok) {
    inflight.delete(hubId);
    sendRpcError(rpcId, -32000, 'Не удалось отправить запрос в MCP Hub');
  }
}

function handleRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (!method) return;

  // Уведомления без id ответа не требуют
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized' && sockPath && token) {
      connectHub().catch(() => {});
    }
    return;
  }

  if (method === 'initialize') {
    const clientInfo = params && params.clientInfo ? params.clientInfo : null;
    sendRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: true } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
    if (sockPath && token) {
      connectHub()
        .then(() => {
          if (clientInfo) sendToHub({ type: 'client_info', clientInfo });
        })
        .catch(() => {});
    }
    return;
  }

  if (method === 'ping') {
    sendRpcResult(id, {});
    return;
  }

  if (method === 'tools/list' || method === 'tools/call') {
    forwardHubRequest(id, method, params || {});
    return;
  }

  sendRpcError(id, -32601, `Метод "${method}" не поддерживается`);
}

function drainStdinBuffer() {
  while (stdinBuf.length > 0) {
    // Поддержка опционального Content-Length (LSP framing) и стандартного newline-delimited JSON
    const headPreview = stdinBuf.subarray(0, Math.min(stdinBuf.length, 64)).toString('ascii');
    if (/^Content-Length:\s*\d+/i.test(headPreview)) {
      const sep = stdinBuf.indexOf('\r\n\r\n');
      const sepLen = sep >= 0 ? 4 : 0;
      const altSep = sep >= 0 ? sep : stdinBuf.indexOf('\n\n');
      const hdrEnd = sep >= 0 ? sep : altSep;
      const delimLen = sepLen || (altSep >= 0 ? 2 : 0);
      if (hdrEnd < 0) return;
      const header = stdinBuf.subarray(0, hdrEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { stdinBuf = stdinBuf.subarray(hdrEnd + delimLen); continue; }
      const len = parseInt(m[1], 10);
      const frameEnd = hdrEnd + delimLen + len;
      if (stdinBuf.length < frameEnd) return;
      useContentLength = true;
      const bodyStr = stdinBuf.subarray(hdrEnd + delimLen, frameEnd).toString('utf8');
      stdinBuf = stdinBuf.subarray(frameEnd);
      try { handleRpcMessage(JSON.parse(bodyStr)); } catch (_) {}
      continue;
    }

    const nl = stdinBuf.indexOf(0x0a);
    if (nl < 0) return;
    const line = stdinBuf.subarray(0, nl).toString('utf8').trim();
    stdinBuf = stdinBuf.subarray(nl + 1);
    if (!line) continue;
    try { handleRpcMessage(JSON.parse(line)); } catch (_) {}
  }
}

process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  if (stdinBuf.length > MAX_IN_BUFFER) {
    process.stderr.write('MCP bridge: stdin buffer overflow\n');
    process.exit(1);
  }
  drainStdinBuffer();
});

process.stdin.on('end', () => {
  try { if (client && !client.destroyed) client.end(); } catch (_) {}
  setTimeout(() => process.exit(0), 50);
});

process.on('SIGTERM', () => {
  try { if (client && !client.destroyed) client.end(); } catch (_) {}
  process.exit(0);
});
