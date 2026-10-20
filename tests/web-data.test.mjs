import test from 'node:test';
import assert from 'node:assert/strict';
import { safeResourceURL, normalizeSearchResponse, filterRecords, typeCounts, csvCell, exportCSV } from '../web/data.js';

const hash = 'A'.repeat(40);
const magnet = `magnet:?xt=urn:btih:${hash}`;
const data = { total: 5, merged_by_type: {
  magnet: [
    { url: magnet, note: '<script>untrusted title</script>', source: 'plugin:one' },
    { url: magnet.toLowerCase(), note: 'same hash', source: 'plugin:two' },
  ],
  quark: [
    { url: 'https://example.invalid/share/demo', note: '=1+2', password: '1234', source: 'tg:example' },
    { url: 'javascript:alert(1)', note: 'invalid' },
    { url: 'data:text/html,unsafe', note: 'invalid' },
  ],
} };

test('resource links admit only supported safe schemes', () => {
  assert.equal(safeResourceURL('javascript:alert(1)'), null);
  assert.equal(safeResourceURL('file:///etc/passwd'), null);
  assert.equal(safeResourceURL('//example.invalid/foo'), null);
  assert.equal(safeResourceURL('https://user:secret@example.invalid/'), null);
  assert.equal(safeResourceURL('https://example.invalid/\nfoo'), null);
  assert.equal(safeResourceURL('magnet:?xt=urn:btih:bad'), null);
  assert.equal(safeResourceURL(magnet), magnet);
  assert.equal(safeResourceURL('https://example.invalid/share'), 'https://example.invalid/share');
  assert.ok(safeResourceURL(`ed2k://|file|example.txt|12|${'a'.repeat(32)}|/`));
});

test('wrapped and unwrapped replies normalize consistently', () => {
  const a = normalizeSearchResponse(data);
  assert.deepEqual(a, normalizeSearchResponse({ code: 200, data }));
  assert.equal(a.records.length, 2);
  assert.equal(a.ignored, 2);
  assert.equal(a.reportedTotal, 5);
  assert.deepEqual(a.records[0].sources, ['plugin:one', 'plugin:two']);
  assert.equal(a.records[0].title, '<script>untrusted title</script>');
  assert.equal(a.records[1].password, '1234');
});

test('empty response is distinct from malformed response', () => {
  assert.deepEqual(normalizeSearchResponse({ total: 0, merged_by_type: {} }).records, []);
  assert.deepEqual(normalizeSearchResponse({ total: 0 }).records, []);
  assert.deepEqual(normalizeSearchResponse({ data: { total: 0, merged_by_type: null } }).records, []);
  for (const value of [null, 'html', [], {}, { data: {} }, { merged_by_type: [] }]) {
    assert.throws(() => normalizeSearchResponse(value));
  }
});

test('unknown and prototype-like category names remain ordinary data', () => {
  const payload = JSON.parse('{"total":1,"merged_by_type":{"__proto__":[{"url":"https://example.invalid/file","note":"hello"}]}}');
  const result = normalizeSearchResponse(payload);
  assert.equal(result.records[0].kind, 'others');
  const counts = typeCounts(result.records);
  assert.equal(Object.getPrototypeOf(counts), null);
  assert.equal(counts.others, 1);
});

test('filtering preserves the underlying records', () => {
  const { records } = normalizeSearchResponse(data);
  assert.equal(filterRecords(records, 'magnet').length, 1);
  assert.equal(filterRecords(records, 'all').length, 2);
  assert.equal(filterRecords(records, 'baidu').length, 0);
  assert.deepEqual({ ...typeCounts(records) }, { magnet: 1, quark: 1 });
  assert.equal(records.length, 2);
});

test('CSV safely quotes untrusted text and neutralizes formulas', () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  for (const value of ['=1+2', '+cmd', '-1+2', '@SUM(A1)', '  =HYPERLINK("x")', '\tunsafe']) {
    assert.ok(csvCell(value).startsWith('"\''));
  }
  const csv = exportCSV(normalizeSearchResponse(data).records);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('"\'=1+2"'));
  assert.ok(csv.includes('plugin:one；plugin:two'));
  assert.ok(csv.includes('提取码'));
});
