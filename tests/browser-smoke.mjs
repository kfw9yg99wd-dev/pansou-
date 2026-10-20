import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const { chromium } = await import(process.env.PANSOU_PLAYWRIGHT_MODULE ?? 'playwright-core');
assert.ok(process.env.PANSOU_BROWSER_EXECUTABLE, 'Set PANSOU_BROWSER_EXECUTABLE to a local Chromium browser executable');
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'pansou-publish-qa-'));
const artifacts = path.join(root, 'test-results');
await mkdir(artifacts, { recursive: true });
const allocator = createServer();
await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
const port = allocator.address().port;
await new Promise(resolve => allocator.close(resolve));
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(24).toString('hex');
const secret = randomBytes(32).toString('hex');
const binary = process.env.PANSOU_TEST_BINARY ?? path.join(root, 'bin', process.platform === 'win32' ? 'pansou.exe' : 'pansou');
const server = spawn(binary, [], {
  cwd: temporary,
  env: {
    PATH: process.env.PATH ?? '', TZ: 'Asia/Shanghai', PORT: String(port),
    PANSOU_LISTEN_HOST: '127.0.0.1', AUTH_ENABLED: 'true',
    AUTH_USERS: `ci-user:${password}`, AUTH_JWT_SECRET: secret,
    ENABLED_PLUGINS: 'clmao,hunhepan,pansearch,yunso,btbtlb', CHANNELS: 'tgsearchers7',
    CONCURRENCY: '4', OUTBOUND_MAX_CONCURRENCY: '4', PLUGIN_TIMEOUT: '12',
    ASYNC_MAX_BACKGROUND_WORKERS: '8', ASYNC_MAX_BACKGROUND_TASKS: '40',
    ASYNC_LOG_ENABLED: 'false', CACHE_PATH: path.join(temporary, 'cache'),
    CACHE_MAX_SIZE: '64', GOMAXPROCS: '2', GOMEMLIMIT: '384MiB',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
let spawnError;
server.on('error', error => { spawnError = error; });
for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + data).slice(-16000); });
const closed = new Promise(resolve => server.once('close', resolve));
let browser;

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error('Test backend exited before becoming healthy');
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Startup poll, bounded to a short test window. */ }
    await delay(200);
  }
  assert.ok(ready, 'test backend must become healthy');
  console.log(JSON.stringify({ phase: 'test-server-ready', url: base }));
  assert.equal((await fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  browser = await chromium.launch({ executablePath: process.env.PANSOU_BROWSER_EXECUTABLE, headless: true, timeout: 15000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  // Exercise copy dispatch without reading or changing the user's OS clipboard.
  await context.addInitScript(() => {
    window.__qaCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__qaCopies.push(text); } } });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 });
  assert.match(await page.title(), /PanSou/);
  await page.locator('#login-dialog[open]').waitFor({ timeout: 15000 });
  await page.getByLabel('服务用户名', { exact: true }).fill('ci-user');
  await page.getByLabel('服务密码', { exact: true }).fill('wrong-password');
  await page.locator('#login-submit').click();
  await page.locator('#login-error').waitFor({ state: 'visible' });
  await page.getByLabel('服务密码', { exact: true }).fill(password);
  await page.locator('#login-submit').click();
  await page.locator('#login-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#login-password').inputValue(), '');

  const query = page.getByLabel('片名、原名或关键词', { exact: true });
  await query.fill('六龙飞天');
  await query.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.result-item').length > 0, undefined, { timeout: 45000 });
  await page.waitForFunction(() => !document.getElementById('query').disabled, undefined, { timeout: 45000 });
  const realCount = Number(await page.locator('#total-count').innerText());
  assert.ok(realCount > 0, 'live indexes must return candidates');
  assert.equal(await page.locator('#notice').isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('search-button')).opacity === '1');
  await page.screenshot({ path: path.join(artifacts, 'desktop.png') });

  await page.locator('#type-magnet').click();
  assert.ok(await page.locator('.result-item').count() > 0);
  assert.ok((await page.locator('.kind-label').allTextContents()).every(text => text === '磁力链接'));
  await page.getByRole('button', { name: '复制链接', exact: true }).first().click();
  assert.ok((await page.evaluate(() => window.__qaCopies[0])).startsWith('magnet:'));
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-results').click();
  const download = await downloadPromise;
  await download.saveAs(path.join(artifacts, 'export.csv'));
  assert.ok((await readFile(path.join(artifacts, 'export.csv'), 'utf8')).includes('磁力链接'));

  for (const width of [768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}px`);
  }
  await page.locator('#menu-toggle').click();
  await page.locator('[data-panel="sources"]').click();
  assert.equal(await page.locator('#panel-sources').isVisible(), true);
  assert.ok((await page.locator('#plugin-summary').innerText()).startsWith('5 '));
  await page.locator('#menu-toggle').click();
  await page.locator('[data-panel="search"]').click();
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('search-heading').getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom), true);
  await page.screenshot({ path: path.join(artifacts, 'mobile.png') });

  await page.setViewportSize({ width: 1440, height: 960 });
  let scenario = 'xss';
  await page.route('**/api/search', async route => {
    if (scenario === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Test server failure' }) });
    if (scenario === 'slow') { await delay(6000); return route.fulfill({ json: { total: 0 } }).catch(() => {}); }
    if (scenario === 'empty') return route.fulfill({ json: { total: 0 } });
    return route.fulfill({ json: { total: 2, merged_by_type: { quark: [
      { url: 'https://example.invalid/share/demo', note: '<img src=x onerror="window.__qaXss=1">', source: 'test:fixture' },
      { url: 'javascript:alert(1)', note: 'unsupported URL', source: 'test:fixture' },
    ] } } });
  });
  async function mockSearch(keyword) {
    await query.fill(keyword); await query.press('Enter');
    await page.waitForFunction(() => !document.getElementById('query').disabled, undefined, { timeout: 20000 });
  }
  await mockSearch('test fixture');
  assert.equal(await page.locator('#result-list img').count(), 0);
  assert.equal(await page.evaluate(() => window.__qaXss), undefined);
  assert.equal(await page.locator('.result-item').count(), 1);
  assert.ok((await page.locator('.result-title').innerText()).includes('<img'));
  scenario = 'empty'; await mockSearch('empty fixture');
  assert.equal(await page.locator('#empty-title').innerText(), '这次没有找到匹配结果');
  scenario = 'error'; await mockSearch('error fixture');
  assert.equal(await page.locator('#empty-title').innerText(), '这次搜索未完成');
  assert.equal(await page.locator('#notice').isVisible(), true);
  scenario = 'slow'; await query.fill('cancel fixture'); await query.press('Enter');
  await page.locator('#cancel-search').click();
  await page.waitForFunction(() => !document.getElementById('query').disabled);
  assert.equal(await page.locator('#empty-title').innerText(), '搜索已停止');
  await page.locator('#account-button').click();
  await page.waitForFunction(() => document.getElementById('query').disabled);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pansou-web-session-v1')), null);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    status: 'passed', real_search: { keyword: '六龙飞天', normalized_candidates: realCount },
    checks: ['login rejection/success', 'authenticated real search', 'magnet filter', 'copy dispatch (in-page stub)', 'CSV download', '1440/768/375 widths', 'mobile navigation', 'XSS-safe text', 'empty versus error', 'cancel', 'logout'],
    page_errors: pageErrors, screenshots: ['test-results/desktop.png', 'test-results/mobile.png'],
  }, null, 2));
} catch (error) {
  console.error(serverLog.replaceAll(password, '[redacted]').replaceAll(secret, '[redacted]'));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  const force = setTimeout(() => { if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); }, 15000);
  await closed;
  clearTimeout(force);
  await rm(temporary, { recursive: true, force: true });
}
