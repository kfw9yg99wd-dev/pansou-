import assert from 'node:assert/strict';

const base = process.env.PANSOU_TEST_BASE_URL ?? 'http://127.0.0.1:18888';
const password = process.env.PANSOU_TEST_PASSWORD;
assert.ok(password, 'PANSOU_TEST_PASSWORD is required for the disposable test account');

const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
assert.equal(health.status, 200);
assert.equal((await health.json()).auth_enabled, true);

for (const path of ['/', '/web/', '/nested/view/', '/styles.css', '/app.js', '/data.js', '/fonts/IBMPlexSans-Variable.ttf']) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}
assert.equal((await fetch(`${base}/missing.js`)).status, 404);
assert.equal((await fetch(`${base}/.env`)).status, 404);
assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
assert.equal((await fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'ci-user', password }),
});
assert.equal(login.status, 200);
const { token } = await login.json();
assert.equal(typeof token, 'string');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
assert.equal((await fetch(`${base}/api/auth/verify`, { method: 'POST', headers })).status, 200);
// Missing keyword tests authorization without contacting resource indexes.
assert.equal((await fetch(`${base}/api/search`, { method: 'POST', headers, body: '{}' })).status, 400);
console.log('HTTP smoke checks passed: static assets, origin guard, login, and protected API.');
