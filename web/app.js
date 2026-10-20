import { TYPE_NAMES, normalizeSearchResponse, filterRecords, typeCounts, exportCSV } from './data.js';

const $ = id => document.getElementById(id);
const AUTH_KEY = 'pansou-web-session-v1';
const state = { health: null, auth: null, connected: false, records: [], kind: 'all', query: '', limit: 80, controller: null, searched: false, outcome: 'idle' };
let toastTimer;
let checking = false;

try {
  const stored = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null');
  if (typeof stored?.token === 'string' && stored.expires_at > Date.now() / 1000) state.auth = stored;
  else sessionStorage.removeItem(AUTH_KEY);
} catch { /* Storage may be disabled; in-memory authentication remains usable. */ }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3200);
}

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function empty(title, description) {
  $('empty-title').textContent = title;
  $('empty-description').textContent = description;
  $('empty-state').hidden = false;
}

function clearAuth() {
  state.auth = null;
  try { sessionStorage.removeItem(AUTH_KEY); } catch { /* No persistent token. */ }
  updateControls();
}

function updateControls() {
  const authorized = state.connected && (!state.health?.auth_enabled || !!state.auth);
  const busy = !!state.controller;
  $('query').disabled = !authorized || busy;
  $('source-mode').disabled = !authorized || busy;
  $('search-button').disabled = !authorized || busy;
  $('search-button').firstElementChild.textContent = busy ? '正在搜索' : '搜索资源';
  $('cancel-search').hidden = !busy;
  $('results-panel').setAttribute('aria-busy', String(busy));
  $('account-button').hidden = !state.health?.auth_enabled;
  $('account-button').textContent = state.auth ? '退出登录' : '登录服务';
  $('export-results').disabled = filterRecords(state.records, state.kind).length === 0;
}

async function request(path, { method = 'GET', body, signal, auth = true, timeout = 35000 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const headers = new Headers({ Accept: 'application/json' });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (auth && state.auth) headers.set('Authorization', `Bearer ${state.auth.token}`);
  try {
    const response = await fetch(`/api/${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal, cache: 'no-store', credentials: 'omit',
    });
    const isJSON = response.headers.get('content-type')?.includes('application/json');
    const data = isJSON ? await response.json() : null;
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error : `服务返回 HTTP ${response.status}，请稍后重试。`);
      error.status = response.status;
      throw error;
    }
    if (!isJSON) throw new Error('未连接到 PanSou 搜索后端。请先部署 Go 服务，静态页面本身不能执行搜索。');
    return data;
  } catch (error) {
    if (timedOut) throw new Error('搜索服务响应超时。部分来源可能不可达，请稍后重试或缩小搜索范围。');
    if (error.name === 'AbortError') throw error;
    if (error instanceof SyntaxError) throw new Error('后端返回的数据格式异常，请检查服务后重试。');
    if (error instanceof TypeError) throw new Error('无法连接搜索后端，请检查服务与网络后点击「重新检查后端连接」。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function renderSources() {
  for (const [key, listID, summaryID, label] of [
    ['plugins', 'plugin-list', 'plugin-summary', '个已启用插件'],
    ['channels', 'channel-list', 'channel-summary', '个已配置频道'],
  ]) {
    const items = [...new Set((state.health?.[key] ?? []).filter(item => typeof item === 'string'))].sort();
    $(listID).replaceChildren(...items.map(item => node('span', 'source-tag', item)));
    $(summaryID).textContent = `${items.length} ${label}`;
  }
}

async function checkBackend(showLogin = false) {
  if (checking) return;
  checking = true;
  $('reconnect').disabled = true;
  $('service-status').className = 'service-status';
  $('service-status').textContent = '正在连接后端';
  try {
    const health = await request('health', { timeout: 12000 });
    if (health?.status !== 'ok') throw new Error('后端健康检查未通过，请检查服务配置。');
    state.health = health;
    state.connected = true;
    if (health.auth_enabled && state.auth) {
      try { await request('auth/verify', { method: 'POST', timeout: 10000 }); }
      catch { clearAuth(); }
    }
    $('service-status').textContent = health.auth_enabled && !state.auth ? '已连接，需登录' : '后端已连接';
    $('service-status').classList.add('is-ready');
    renderSources();
    notice();
    if (showLogin && health.auth_enabled && !state.auth) openLogin();
  } catch (error) {
    state.connected = false;
    $('service-status').textContent = '后端未连接';
    $('service-status').classList.add('is-error');
    notice(error.message);
  } finally {
    checking = false;
    $('reconnect').disabled = false;
    updateControls();
  }
}

function openLogin() {
  $('login-error').hidden = true;
  $('login-user').removeAttribute('aria-invalid');
  $('login-password').removeAttribute('aria-invalid');
  if (!$('login-dialog').open) $('login-dialog').showModal();
  $('login-user').focus();
}

function closeLogin() {
  $('login-dialog').close();
  $('login-password').value = '';
  $('account-button').focus();
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('login-submit').disabled) return;
  if (!$('login-form').reportValidity()) return;
  $('login-submit').disabled = true;
  $('login-submit').textContent = '正在登录';
  $('login-error').hidden = true;
  try {
    const auth = await request('auth/login', { method: 'POST', auth: false, timeout: 15000, body: {
      username: $('login-user').value.trim(), password: $('login-password').value,
    } });
    if (typeof auth.token !== 'string' || !Number.isFinite(auth.expires_at)) throw new Error('登录服务未返回有效会话，请检查后端配置。');
    state.auth = { token: auth.token, expires_at: auth.expires_at, username: auth.username };
    try { sessionStorage.setItem(AUTH_KEY, JSON.stringify(state.auth)); } catch { /* Session stays in memory. */ }
    closeLogin();
    updateControls();
    $('service-status').textContent = '后端已连接';
    $('query').focus();
    notice();
    toast('已登录搜索服务');
  } catch (error) {
    $('login-error').textContent = error.status === 401 ? '服务用户名或密码不正确，请检查部署时设置的账号。' : error.message;
    $('login-error').hidden = false;
    $('login-password').setAttribute('aria-invalid', 'true');
  } finally {
    $('login-submit').disabled = false;
    $('login-submit').textContent = '登录服务';
  }
});

$('close-login').addEventListener('click', closeLogin);
$('login-dialog').addEventListener('cancel', () => { $('login-password').value = ''; });
$('account-button').addEventListener('click', async () => {
  if (!state.auth) { openLogin(); return; }
  state.controller?.abort();
  try { await request('auth/logout', { method: 'POST', timeout: 10000 }); } catch { /* Client logout always clears the session. */ }
  clearAuth();
  $('service-status').textContent = '已连接，需登录';
  toast('已清除当前浏览器的登录会话');
});

function formatDate(value) {
  if (!value) return '来源未标注日期';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '来源日期格式未知' : `来源日期 ${date.toLocaleDateString('zh-CN')}`;
}

async function copyText(text, success) {
  try { await navigator.clipboard.writeText(text); toast(success); }
  catch { toast('浏览器未允许复制。请展开「查看链接」，选中文本后手动复制。'); }
}

function renderRecord(record) {
  const item = node('article', 'result-item');
  item.setAttribute('role', 'listitem');
  const main = node('div', 'result-main');
  main.append(node('h2', 'result-title', record.title));
  const meta = node('div', 'result-meta');
  meta.append(node('span', 'kind-label', TYPE_NAMES[record.kind]), node('span', '', record.sources.join('、')), node('span', '', formatDate(record.datetime)));
  if (record.password) meta.append(node('span', '', `提取码：${record.password}`));
  main.append(meta);
  const details = node('details', 'resource-url');
  details.append(node('summary', '', '查看链接'), node('code', '', record.url));
  main.append(details);
  const actions = node('div', 'result-actions');
  const copy = node('button', 'button button-secondary', '复制链接');
  copy.prepend(icon('copy'));
  copy.addEventListener('click', () => copyText(record.url + (record.password ? `\n提取码：${record.password}` : ''), record.password ? '已复制链接和提取码' : '已复制链接'));
  const open = node('a', 'button button-secondary', record.kind === 'magnet' ? '打开磁力' : '打开链接');
  open.href = record.url;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.append(icon('arrow'));
  actions.append(copy, open);
  item.append(main, actions);
  return item;
}

function renderTabs() {
  const counts = typeCounts(state.records);
  const kinds = ['all', ...Object.keys(TYPE_NAMES).filter(kind => counts[kind])];
  if (!kinds.includes(state.kind)) state.kind = 'all';
  const buttons = kinds.map(kind => {
    const count = kind === 'all' ? state.records.length : counts[kind];
    const button = node('button', 'type-tab', `${kind === 'all' ? '全部' : TYPE_NAMES[kind]} (${count})`);
    button.id = `type-${kind}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(kind === state.kind));
    button.setAttribute('aria-controls', 'results-panel');
    button.tabIndex = kind === state.kind ? 0 : -1;
    button.addEventListener('click', () => { state.kind = kind; state.limit = 80; renderResults(); $(button.id)?.focus(); });
    button.addEventListener('keydown', event => {
      let index = kinds.indexOf(kind);
      if (event.key === 'ArrowRight') index = (index + 1) % kinds.length;
      else if (event.key === 'ArrowLeft') index = (index - 1 + kinds.length) % kinds.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = kinds.length - 1;
      else return;
      event.preventDefault();
      state.kind = kinds[index]; state.limit = 80; renderResults(); $(`type-${state.kind}`).focus();
    });
    return button;
  });
  $('type-tabs').replaceChildren(...buttons);
  $('type-tabs').hidden = state.records.length === 0;
  $('type-count').textContent = String(Object.keys(counts).length);
  $('results-panel').setAttribute('role', 'tabpanel');
  $('results-panel').setAttribute('aria-labelledby', `type-${state.kind}`);
}

const loadMore = node('button', 'button button-secondary', '显示更多结果');
loadMore.id = 'load-more'; loadMore.hidden = true;
$('results-panel').append(loadMore);
loadMore.addEventListener('click', () => { state.limit += 80; renderResults(); });

function renderResults() {
  renderTabs();
  const filtered = filterRecords(state.records, state.kind);
  $('total-count').textContent = String(state.records.length);
  $('result-list').replaceChildren(...filtered.slice(0, state.limit).map(renderRecord));
  $('empty-state').hidden = filtered.length > 0;
  loadMore.hidden = filtered.length <= state.limit;
  loadMore.textContent = `显示更多结果（已展示 ${Math.min(state.limit, filtered.length)} / ${filtered.length}）`;
  if (!filtered.length && state.searched && !state.controller) {
    if (state.outcome === 'error') empty('这次搜索未完成', '请检查上方的错误提示后重试。请求失败不代表没有相关资源。');
    else if (state.outcome === 'cancelled') empty('搜索已停止', '可以重新搜索这个片名，或换一个关键词继续查找。');
    else empty('这次没有找到匹配结果', '试试其他译名、更短的关键词，或切换搜索范围后重新搜索。');
  }
  updateControls();
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}

$('search-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.controller || !state.connected) return;
  if (state.health?.auth_enabled && !state.auth) { openLogin(); return; }
  const query = $('query').value.trim();
  if (!query) { $('query').setAttribute('aria-invalid', 'true'); notice('请填写片名、原名或搜索关键词。'); return; }
  $('query').removeAttribute('aria-invalid');
  state.query = query; state.kind = 'all'; state.records = []; state.limit = 80; state.searched = true; state.outcome = 'loading';
  const controller = new AbortController(); state.controller = controller;
  const mode = $('source-mode').value;
  const started = performance.now();
  notice(); renderResults();
  empty('正在检索公开来源', '不同来源的响应速度不同。你可以停止本轮搜索，或等待候选链接返回。');
  $('search-progress').textContent = '正在查询公开网盘分享与磁力索引…';
  let response = null;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await abortableDelay(attempt * 2000, controller.signal);
      const payload = await request('search', { method: 'POST', signal: controller.signal, body: { kw: query, src: mode, res: 'merge' } });
      if (controller.signal.aborted) break;
      const next = normalizeSearchResponse(payload);
      // Background indexing can fill the cache after the first partial response.
      if (!response || next.records.length >= state.records.length) { response = next; state.records = next.records; }
      $('search-duration').textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`;
      renderResults();
      $('search-progress').textContent = state.records.length ? `已整理 ${state.records.length} 条候选链接，正在补充较慢来源…` : '当前来源尚未返回结果，正在检查后台补充结果…';
    }
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    state.outcome = 'done';
    $('search-progress').textContent = `本轮整理了 ${state.records.length} 条候选链接。结果已去重，仍需核验资源内容。${response?.ignored ? `另有 ${response.ignored} 条格式不支持的链接未显示。` : ''}`;
  } catch (error) {
    if (error.name === 'AbortError') { state.outcome = 'cancelled'; $('search-progress').textContent = '已停止搜索，已返回的结果仍可查看或导出。'; }
    else {
      state.outcome = 'error';
      notice(error.message);
      $('search-progress').textContent = state.records.length ? '部分请求未完成，已返回的结果仍然保留。' : '搜索未完成，请检查连接后重试。';
      if (error.status === 401) { clearAuth(); openLogin(); }
    }
  } finally {
    if (state.controller === controller) state.controller = null;
    renderResults();
  }
});

$('cancel-search').addEventListener('click', () => state.controller?.abort());
$('reconnect').addEventListener('click', () => checkBackend(true));
$('query').addEventListener('input', () => $('query').removeAttribute('aria-invalid'));
$('export-results').addEventListener('click', () => {
  const records = filterRecords(state.records, state.kind);
  if (!records.length) return;
  const blob = new Blob([exportCSV(records)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = node('a'); link.href = url;
  const filename = state.query.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'results';
  link.download = `pansou-${filename}.csv`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${records.length} 条候选结果`);
});

function setDrawer(open) {
  $('sidebar').classList.toggle('is-open', open);
  $('menu-toggle').setAttribute('aria-expanded', String(open));
  $('menu-toggle').setAttribute('aria-label', open ? '收起导航' : '展开导航');
  $('drawer-backdrop').hidden = !open;
}
$('menu-toggle').addEventListener('click', () => setDrawer(!$('sidebar').classList.contains('is-open')));
$('drawer-backdrop').addEventListener('click', () => setDrawer(false));
document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => {
  const panel = button.dataset.panel;
  document.querySelectorAll('.panel').forEach(element => { element.hidden = element.id !== `panel-${panel}`; });
  document.querySelectorAll('[data-panel]').forEach(element => {
    const active = element === button; element.classList.toggle('is-active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  });
  $('panel-title').textContent = button.textContent;
  setDrawer(false);
  $('workspace').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'auto' });
}));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') setDrawer(false);
  if (event.key === '/' && !$('login-dialog').open && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    event.preventDefault(); document.querySelector('[data-panel="search"]').click(); $('query').focus();
  }
});

checkBackend(true);
