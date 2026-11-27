// Unit-тесты для lib/rest-formats.js: интерполяция, cURL, .http и OpenAPI/Swagger.
'use strict';

const assert = require('assert');
const {
  interpolate,
  parseCurl,
  toCurl,
  parseHttpFile,
  toHttpFile,
  parseOpenApiSpec,
} = require('../lib/rest-formats');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

check('interpolate replaces known {{vars}} non-recursively and preserves unknown', () => {
  const vars = { host: 'http://localhost:3000', token: 'abc{{other}}', other: 'NOPE' };
  assert.strictEqual(interpolate('{{host}}/api/{{missing}}?t={{token}}', vars), 'http://localhost:3000/api/{{missing}}?t=abc{{other}}');
});

check('parseCurl and toCurl roundtrip method, headers, basic auth and JSON body', () => {
  const cmd = `curl -X POST 'https://api.example.com/users' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Trace: 123' \\\n  -u admin:secret \\\n  -d '{"name":"Ann"}'`;
  const parsed = parseCurl(cmd);
  assert.strictEqual(parsed.method, 'POST');
  assert.strictEqual(parsed.url, 'https://api.example.com/users');
  assert.strictEqual(parsed.bodyMode, 'json');
  assert.strictEqual(parsed.body, '{"name":"Ann"}');
  assert.deepStrictEqual(parsed.auth, { type: 'basic', user: 'admin', pass: 'secret' });
  assert.strictEqual(parsed.headers.length, 2);

  const regen = toCurl({ ...parsed, url: '{{base}}/users' }, { base: 'https://api.example.com' });
  assert(regen.includes('curl -X POST'));
  assert(regen.includes('https://api.example.com/users'));
  assert(regen.includes('X-Trace: 123'));
});

check('parseHttpFile and toHttpFile parse multiple requests and file variables', () => {
  const src = `
@host = http://127.0.0.1:8080

### List items
GET {{host}}/items?limit=10
Accept: application/json

### Create item
POST {{host}}/items
Content-Type: application/json

{"title":"Hello"}
`;
  const parsed = parseHttpFile(src);
  assert.strictEqual(parsed.vars.host, 'http://127.0.0.1:8080');
  assert.strictEqual(parsed.requests.length, 2);
  assert.strictEqual(parsed.requests[0].method, 'GET');
  assert.strictEqual(parsed.requests[1].method, 'POST');
  assert.strictEqual(parsed.requests[1].bodyMode, 'json');
  assert(parsed.requests[1].body.includes('"Hello"'));

  const out = toHttpFile(parsed.requests);
  assert(out.includes('### List items'));
  assert(out.includes('POST {{host}}/items'));
});

check('parseOpenApiSpec supports OpenAPI 3 JSON and Swagger 2 YAML with $ref', () => {
  const oas3 = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Shop API' },
    servers: [{ url: 'http://localhost:4000/v1' }],
    paths: {
      '/orders': {
        get: { summary: 'List orders', parameters: [{ name: 'status', in: 'query', example: 'open' }] },
        post: {
          summary: 'Create order',
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Order' },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Order: { type: 'object', properties: { sku: { type: 'string', example: 'SKU-1' }, qty: { type: 'integer', default: 2 } } },
      },
    },
  });
  const col = parseOpenApiSpec(oas3);
  assert.strictEqual(col.name, 'Shop API');
  assert.strictEqual(col.requests.length, 2);
  assert.strictEqual(col.requests[0].url, 'http://localhost:4000/v1/orders?status=open');
  assert.strictEqual(col.requests[1].bodyMode, 'json');
  assert(col.requests[1].body.includes('SKU-1'));

  const sw2 = `
swagger: "2.0"
info:
  title: Legacy YAML
host: 127.0.0.1:5000
basePath: /api
schemes: [http]
paths:
  /ping:
    get:
      summary: Healthcheck
`;
  const col2 = parseOpenApiSpec(sw2);
  assert.strictEqual(col2.name, 'Legacy YAML');
  assert.strictEqual(col2.requests[0].url, 'http://127.0.0.1:5000/api/ping');
});

console.log(`rest-formats.test.js: ${passed} checks passed`);
