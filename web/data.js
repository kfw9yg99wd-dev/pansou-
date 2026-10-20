export const TYPE_NAMES = Object.freeze({
  baidu: '百度网盘', aliyun: '阿里云盘', quark: '夸克网盘', guangya: '光鸭云盘',
  tianyi: '天翼云盘', uc: 'UC 网盘', mobile: '移动云盘', '115': '115 网盘',
  pikpak: 'PikPak', xunlei: '迅雷网盘', '123': '123 网盘', magnet: '磁力链接',
  ed2k: '电驴链接', others: '其他链接',
});

export function safeResourceURL(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/^ed2k:\/\/\|file\|[^|]+\|\d+\|[a-f\d]{32}\|/i.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    if (url.protocol === 'magnet:') {
      const valid = url.searchParams.getAll('xt').some(xt =>
        /^urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})$/i.test(xt) || /^urn:btmh:1220[a-f\d]{64}$/i.test(xt));
      return valid ? url.href : null;
    }
  } catch { /* Malformed external results are not clickable. */ }
  return null;
}

function canonicalURL(url) {
  if (!url.startsWith('magnet:')) return url;
  return new URL(url).searchParams.getAll('xt').map(value => value.toLowerCase()).sort().join('|');
}

export function normalizeSearchResponse(payload) {
  const data = payload?.data ?? payload;
  // Go omits its empty map because merged_by_type is tagged omitempty.
  if (data && typeof data === 'object' && !Array.isArray(data) && data.total === 0 && data.merged_by_type == null) {
    return { records: [], ignored: 0, reportedTotal: 0 };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !data.merged_by_type || typeof data.merged_by_type !== 'object' || Array.isArray(data.merged_by_type)) {
    throw new Error('搜索服务返回了无法识别的数据，请检查后端版本后重试。');
  }
  const records = [];
  const seen = new Map();
  let ignored = 0;
  for (const [rawKind, entries] of Object.entries(data.merged_by_type)) {
    if (!Array.isArray(entries)) continue;
    const kind = Object.hasOwn(TYPE_NAMES, rawKind) ? rawKind : 'others';
    for (const entry of entries) {
      const url = safeResourceURL(entry?.url);
      if (!url) { ignored += 1; continue; }
      const password = typeof entry.password === 'string' ? entry.password : '';
      const source = typeof entry.source === 'string' && entry.source ? entry.source : '来源未标注';
      const key = `${kind}\n${canonicalURL(url)}\n${password}`;
      const existing = seen.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        continue;
      }
      const record = {
        kind, url, password, sources: [source],
        title: typeof entry.note === 'string' && entry.note.trim() ? entry.note.trim() : '未命名资源',
        datetime: typeof entry.datetime === 'string' ? entry.datetime : '',
      };
      records.push(record);
      seen.set(key, record);
    }
  }
  return { records, ignored, reportedTotal: Number.isFinite(data.total) ? data.total : records.length };
}

export function typeCounts(records) {
  return records.reduce((counts, record) => {
    counts[record.kind] = (counts[record.kind] ?? 0) + 1;
    return counts;
  }, Object.create(null));
}

export function filterRecords(records, kind) {
  return kind === 'all' ? records : records.filter(record => record.kind === kind);
}

export function csvCell(value) {
  let text = String(value ?? '').replaceAll('\0', '');
  // Avoid spreadsheet formula execution when opening untrusted resource titles.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportCSV(records) {
  const rows = [
    ['资源标题', '资源类型', '链接', '提取码', '来源', '来源标注日期'],
    ...records.map(record => [record.title, TYPE_NAMES[record.kind], record.url, record.password, record.sources.join('；'), record.datetime]),
  ];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
