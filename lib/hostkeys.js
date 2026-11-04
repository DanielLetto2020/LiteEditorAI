// Проверка ключа SSH-хоста (TOFU — «доверие при первом подключении») для всех ssh2-подключений
// редактора: «Удалённые хосты» (сессии, SFTP, exec, пул, туннели) и SSH-туннели «Баз данных».
//
// Без проверки (как было до этого) человек посередине получал пароль или сессию с ключом. Правило:
//   1. ключ хоста уже закреплён у нас (STORE.sshHostKeys) — пускаем только с тем же отпечатком;
//   2. не закреплён — сверяемся с ~/.ssh/known_hosts (обычные и хешированные записи): там другой ключ
//      того же типа → отказ, как у OpenSSH; иначе закрепляем ключ и сообщаем окнам отпечаток;
//   3. отказ превращает невнятное «Host denied (verification failed)» ssh2 в понятный текст, а окна
//      получают событие с прежним и новым отпечатком — «Удалённые хосты» предлагают принять новый ключ.
// Ключ «host:port» — как адресует OpenSSH ([host]:port для нестандартного порта).
//
// main.js: hostkeys.init({ get, set, onEvent }) до первого подключения.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let _get = () => ({}), _set = () => {}, _onEvent = () => {};
// Последний ОТКЛОНЁННЫЙ ключ по хосту: принять его можно только отсюда — рендерер называет хост,
// но не присылает ключ (иначе окно могло бы закрепить что угодно).
const rejected = new Map(); // hp -> { key: Buffer, type, fp, expected, source, at }
const lastMismatchEvent = new Map(); // hp -> { fp, at } — не заваливать окна событиями от фонового опроса

function init({ get, set, onEvent } = {}) {
  if (typeof get === 'function') _get = get;
  if (typeof set === 'function') _set = set;
  if (typeof onEvent === 'function') _onEvent = onEvent;
}

const hpOf = (host, port) => `${String(host || '').trim().toLowerCase()}:${+port || 22}`;
function load() { const o = _get(); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; }
function save(o) { try { _set(o); } catch (_) {} }

// Отпечаток в формате OpenSSH: SHA256:<base64 без '='>
function fingerprint(key) { return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); }
// Тип ключа — первая строка wire-формата (uint32 длина + имя): ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa…
function keyType(key) {
  try { const n = key.readUInt32BE(0); if (n > 0 && n < 64 && key.length >= 4 + n) return key.subarray(4, 4 + n).toString('ascii'); } catch (_) {}
  return '';
}

// ---------------------------------------------------------------- ~/.ssh/known_hosts
// Имя хоста в записи: host (порт 22) или [host]:port. Хешированная запись |1|salt|hash —
// HMAC-SHA1(salt, имя). Маски с * и ? поддерживаем, отрицания (!) — пропускаем запись целиком.
function knownName(host, port) { return (+port || 22) === 22 ? host : `[${host}]:${+port}`; }
function globMatch(pat, s) {
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(s);
}
function hostFieldMatches(field, name) {
  if (field.startsWith('|1|')) {
    const [, , salt, hash] = field.split('|');
    if (!salt || !hash) return false;
    try { return crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash; } catch (_) { return false; }
  }
  const pats = field.split(',');
  if (pats.some((p) => p.startsWith('!') && globMatch(p.slice(1), name))) return false;
  return pats.some((p) => !p.startsWith('!') && globMatch(p, name));
}
// → 'match' | 'mismatch' | 'revoked' | 'unknown'
function checkKnownHosts(host, port, key) {
  const file = path.join(os.homedir(), '.ssh', 'known_hosts');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return 'unknown'; }
  const name = knownName(host, port);
  const type = keyType(key);
  const b64 = key.toString('base64');
  let sameTypeOther = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let marker = null;
    if (parts[0].startsWith('@')) marker = parts.shift();
    if (parts.length < 3 || marker === '@cert-authority') continue;
    if (!hostFieldMatches(parts[0], name)) continue;
    if (marker === '@revoked') { if (parts[2] === b64) return 'revoked'; continue; }
    if (parts[2] === b64) return 'match';
    if (parts[1] === type) sameTypeOther = true;
  }
  return sameTypeOther ? 'mismatch' : 'unknown';
}

// ---------------------------------------------------------------- проверка
function pin(hp, key, source) {
  const all = load();
  all[hp] = { fp: fingerprint(key), type: keyType(key), at: Date.now(), source };
  save(all);
  rejected.delete(hp);
  return all[hp];
}
function reject(hp, key, expected, source) {
  const fp = fingerprint(key);
  rejected.set(hp, { key, type: keyType(key), fp, expected, source, at: Date.now() });
  const prev = lastMismatchEvent.get(hp);
  if (!prev || prev.fp !== fp || Date.now() - prev.at > 10 * 60 * 1000) {
    lastMismatchEvent.set(hp, { fp, at: Date.now() });
    try { _onEvent({ kind: 'mismatch', hp, fp, expected, source }); } catch (_) {}
  }
  return false;
}
function verify(host, port, key) {
  const hp = hpOf(host, port);
  if (!Buffer.isBuffer(key)) return false;
  const fp = fingerprint(key);
  const pinned = load()[hp];
  if (pinned && pinned.fp) return pinned.fp === fp ? true : reject(hp, key, pinned.fp, 'pinned');
  const kh = checkKnownHosts(host, port, key);
  if (kh === 'revoked') return reject(hp, key, null, 'revoked');
  if (kh === 'mismatch') return reject(hp, key, null, 'known_hosts');
  const rec = pin(hp, key, kh === 'match' ? 'known_hosts' : 'first');
  try { _onEvent({ kind: 'pinned', hp, fp: rec.fp, type: rec.type, source: rec.source }); } catch (_) {}
  return true;
}

// Текст отказа для человека (ssh2 сам пишет только «Host denied (verification failed)»).
function deniedText(hp) {
  const r = rejected.get(hp);
  if (!r) return `Ключ SSH-хоста ${hp} не прошёл проверку — подключение отклонено.`;
  if (r.source === 'revoked') return `Ключ SSH-хоста ${hp} отозван в ~/.ssh/known_hosts — подключение отклонено.`;
  // Каждый вариант — одной строкой-шаблоном: словарь локалей переводит сообщение целиком по шаблону.
  if (r.expected) return `Ключ SSH-хоста ${hp} изменился — подключение отклонено (возможен перехват). Был закреплён ${r.expected}, сервер прислал ${r.fp}. Если сервер переустанавливали, примите новый ключ в «Удалённых хостах».`;
  return `Ключ SSH-хоста ${hp} изменился — подключение отклонено (возможен перехват). В ~/.ssh/known_hosts для этого хоста записан другой ключ, сервер прислал ${r.fp}. Если сервер переустанавливали, примите новый ключ в «Удалённых хостах».`;
}

// Подготовить ssh2-клиент к подключению: вернуть hostVerifier для конфига и заменить текст отказа
// в событии 'error' (prependListener — раньше обработчиков вызывающего, объект ошибки тот же).
function guard(ssh, host, port) {
  const hp = hpOf(host, port);
  try {
    ssh.prependListener('error', (e) => {
      if (e && /Host denied \(verification failed\)/i.test(String(e.message || ''))) { e.message = deniedText(hp); e.hostKeyRejected = true; }
    });
  } catch (_) {}
  return (key) => verify(host, port, key);
}

// ---------------------------------------------------------------- управление (IPC «Удалённых хостов»)
// Все три — по ключу «host:port» (hpOf): его же несут события mismatch/pinned.
function info(hp) {
  const p = load()[hp] || null;
  const r = rejected.get(hp);
  return { hp, pinned: p ? { fp: p.fp, type: p.type, at: p.at, source: p.source } : null, rejected: r ? { fp: r.fp, type: r.type, expected: r.expected, source: r.source, at: r.at } : null };
}
// Принять последний отклонённый ключ хоста (человек подтвердил в окне).
function trustRejected(hp) {
  const r = rejected.get(hp);
  if (!r) return { ok: false, error: `Нет отклонённого ключа для ${hp} — подключитесь ещё раз, чтобы получить его` };
  const rec = pin(hp, r.key, 'confirmed');
  lastMismatchEvent.delete(hp);
  try { _onEvent({ kind: 'pinned', hp, fp: rec.fp, type: rec.type, source: 'confirmed' }); } catch (_) {}
  return { ok: true, fp: rec.fp };
}
// Забыть закреплённый ключ: следующее подключение закрепит ключ заново (с проверкой по known_hosts).
function forget(hp) {
  const all = load();
  if (!all[hp]) return { ok: true };
  delete all[hp]; save(all);
  return { ok: true };
}

module.exports = { init, guard, verify, info, trustRejected, forget, fingerprint, hpOf, checkKnownHosts };
