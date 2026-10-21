const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('real collection renderer orders inbox rows, escapes multiline text and updates empty state', () => {
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', hidden: false, value: '', addEventListener() {}, querySelectorAll() { return []; } });
  const root = { ...element(), classList: { add() {} }, querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  } };
  const DCC = { esc: value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'public/js/collection.js'), 'utf8'), {
    window: { DCC }, location: { search: '' }, URLSearchParams,
  });
  const collection = DCC.collection.mount(root, {
    rows: [{ id: 1, message: 'older', rank: 1 }, { id: 2, message: 'line one\n<script>literal</script>', rank: 2 }],
    defaultSortKey: 'rank', defaultSortDirection: 'desc', columnOrder: ['message', 'id'],
    multilineColumns: ['message'], emptyMessage: 'No feedback yet.',
  });
  const body = elements.get('tbody').innerHTML;
  assert.ok(body.indexOf('line one') < body.indexOf('older'));
  assert.match(body, /class="dcc-collection-multiline" data-label="Message">line one\n&lt;script&gt;literal&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>/);
  const head = elements.get('thead').innerHTML;
  assert.ok(head.indexOf('data-sort="message"') < head.indexOf('data-sort="id"'));
  assert.doesNotMatch(head, /data-sort="rank"/);
  assert.equal(elements.get('.dcc-collection-empty').hidden, true);
  collection.update([]);
  assert.equal(elements.get('tbody').innerHTML, '');
  assert.equal(elements.get('.dcc-collection-empty').textContent, 'No feedback yet.');
  assert.equal(elements.get('.dcc-collection-empty').hidden, false);
  assert.equal(elements.get('.dcc-collection-scroll').hidden, true);
});
