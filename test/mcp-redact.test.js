// Unit-тесты для lib/mcp/redact.js: секреты, пути, ANSI/BiDi и UTF-8 обрезка.
'use strict';

const assert = require('assert');
const {
  truncateUtf8,
  sanitizeText,
  redactText,
  redactEnv,
  redactValue,
  isSensitivePath,
} = require('../lib/mcp/redact');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

check('redactText masks Bearer, URI passwords, private keys, JWT and API keys', () => {
  assert.strictEqual(redactText('Authorization: Bearer super_secret_token_123'), 'Authorization: Bearer [REDACTED]');
  assert.strictEqual(redactText('Basic dXNlcjpwYXNzMTIzNA=='), 'Basic [REDACTED]');
  assert.strictEqual(redactText('postgres://app:MyP@ss!99@127.0.0.1:5432/db'), 'postgres://app:[REDACTED]@127.0.0.1:5432/db');
  assert.strictEqual(redactText('POSTGRES_PASSWORD="hello_world"'), 'POSTGRES_PASSWORD="[REDACTED]"');
  assert.strictEqual(redactText('API_KEY=sk-proj-abcdef1234567890abcdef1234567890'), 'API_KEY=[REDACTED]');
  assert.strictEqual(redactText('token=ghp_123456789012345678901234567890123456'), 'token=[REDACTED]');
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.strictEqual(redactText('jwt=' + jwt), 'jwt=[REDACTED]');
  const pk = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  assert.strictEqual(redactText(pk), '[PRIVATE KEY REDACTED]');
});

check('redactEnv redacts Docker/Podman KEY=VALUE arrays safely', () => {
  const out = redactEnv([
    'NODE_ENV=production',
    'POSTGRES_PASSWORD=secret-pass',
    'DATABASE_URL=postgres://u:pw@db:5432/app',
    'PGDATA=/var/lib/postgresql/data',
  ]);
  assert.deepStrictEqual(out, [
    'NODE_ENV=production',
    'POSTGRES_PASSWORD=[REDACTED]',
    'DATABASE_URL=[REDACTED]',
    'PGDATA=/var/lib/postgresql/data',
  ]);
});

check('redactValue handles nested objects, Config.Env and cycles', () => {
  const obj = { password: '123', nested: { safe: 'ok', token: 'abc' }, Config: { Env: ['DB_PASS=xyz', 'PORT=5432'] } };
  obj.self = obj;
  const clean = redactValue(obj);
  assert.strictEqual(clean.password, '[REDACTED]');
  assert.strictEqual(clean.nested.safe, 'ok');
  assert.strictEqual(clean.nested.token, '[REDACTED]');
  assert.deepStrictEqual(clean.Config.Env, ['DB_PASS=[REDACTED]', 'PORT=5432']);
  assert.strictEqual(clean.self, '[Circular]');
});

check('sanitizeText removes ANSI, OSC, control chars and BiDi overrides', () => {
  const dirty = '\x1b[31mRed\x1b[0m \x1b]0;Title\x07\u202Eabc\u0007ok';
  assert.strictEqual(sanitizeText(dirty), 'Red abcok');
});

check('truncateUtf8 splits safely on multi-byte characters', () => {
  const s = 'Привет мир 🎉🚀';
  const r = truncateUtf8(s, 8);
  assert.strictEqual(r.truncated, true);
  assert(!r.text.includes('\uFFFD'));
});

check('isSensitivePath blocks secrets while allowing .env.example and normal files', () => {
  for (const blocked of [
    '/etc/shadow',
    '/etc/sudoers.d/admin',
    '/app/.env',
    '/app/.env.production',
    '/home/user/../.ssh/id_ed25519',
    '/proc/self/environ',
    '/app/cert.pem',
    '/root/.pgpass',
    '/var/run/secrets/kubernetes.io/serviceaccount/token',
    'C:\\app\\.ssh\\id_ed25519',
    '/keys/id_rsa',
    '/infra/terraform.tfstate',
    '/infra/prod.tfvars',
    '/gcp/service-account-prod.json',
  ]) {
    assert.strictEqual(isSensitivePath(blocked).blocked, true, `expected blocked: ${blocked}`);
  }
  for (const allowed of [
    '/app/.env.example',
    '/app/.env.sample',
    '/etc/nginx/nginx.conf',
    '/var/log/app.log',
  ]) {
    assert.strictEqual(isSensitivePath(allowed).blocked, false, `expected allowed: ${allowed}`);
  }
});

console.log(`mcp-redact.test.js: ${passed} checks passed`);
