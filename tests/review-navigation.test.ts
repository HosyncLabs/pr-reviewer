import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { AIReviewLine } from '../src/ai-protocol';
import type { PullRequestFile } from '../src/github';
import { navigateToReviewLine, reviewLineHash } from '../src/review-navigation';

const anchor = `diff-${'a'.repeat(64)}`;
const otherAnchor = `diff-${'b'.repeat(64)}`;
const file: PullRequestFile = { path: 'src/review.ts', anchor, deleted: false };
const row = (side: 'L' | 'R', line: number, pathAnchor = anchor) => `
  <tr><td class="blob-num ${side === 'R' ? 'js-blob-rnum' : ''}" id="${pathAnchor}${side}${line}" data-line-number="${line}"></td>
    <td class="blob-code"><span class="blob-code-inner" data-code-marker="${side === 'R' ? '+' : '-'}">${side === 'R' ? 'current()' : 'previous()'}</span></td></tr>`;
const classic = (rows: string, selected = file) => `
  <div class="file" id="${selected.anchor}" data-tagsearch-path="${selected.path}">
    <div class="file-header" data-path="${selected.path}"><a href="#${selected.anchor}" title="${selected.path}">${selected.path}</a></div>
    <table><tbody>${rows}</tbody></table><input type="checkbox" checked aria-label="Viewed"><textarea>Native draft stays</textarea>
  </div>`;
const tree = `<ul role="tree"><li role="treeitem" id="${file.path}" tabindex="-1"><a href="#${anchor}">review.ts</a></li></ul>`;

function page(html: string) {
  const dom = new JSDOM(`<a href="/acme/repo/pull/1/files"><span id="files_tab_counter">1</span></a>${html}`, {
    url: 'https://github.com/acme/repo/pull/1/files',
  });
  const scrolls: Array<{ target: HTMLElement; options?: boolean | ScrollIntoViewOptions }> = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolls.push({ target: this, options }); };
  dom.window.document.addEventListener('click', event => {
    if ((event.target as Element)?.closest('a')) event.preventDefault();
  });
  return { dom, document: dom.window.document, scrolls };
}

test('scrolls to the exact old or new classic line and preserves native controls and history state', async t => {
  const { dom, document, scrolls } = page(classic(row('L', 7) + row('R', 7)));
  t.after(() => dom.window.close());
  const before = document.body.innerHTML;
  let nativeClicks = 0;
  document.addEventListener('click', () => { nativeClicks += 1; });
  dom.window.history.replaceState({ native: 'kept' }, '', document.URL);
  for (const side of ['left', 'right'] as const) {
    const reference = { side, line: 7 };
    assert.equal(await navigateToReviewLine(file, reference, document), true);
    assert.equal(dom.window.location.hash, reviewLineHash(file, reference));
    assert.equal(scrolls.at(-1)!.target.id, `${anchor}${side === 'left' ? 'L' : 'R'}7`);
    assert.deepEqual(scrolls.at(-1)!.options, { block: 'center', behavior: 'auto' });
  }
  assert.equal(nativeClicks, 0);
  assert.equal(document.body.innerHTML, before);
  assert.equal(document.querySelector('input')!.checked, true);
  assert.equal(document.querySelector('textarea')!.value, 'Native draft stays');
  assert.deepEqual(dom.window.history.state, { native: 'kept' });
});

test('uses the verified React row when it has no synthesized line ID', async t => {
  const { dom, document, scrolls } = page(`
    <div role="region" id="${anchor}" aria-labelledby="heading-react">
      <h3 id="heading-react"><a href="#${anchor}"><code>\u200e${file.path}\u200e</code></a></h3>
      <table><tbody><tr data-line-number="19"><td><span class="diff-text-inner" data-code-marker="+">current()</span></td></tr></tbody></table>
    </div>`);
  t.after(() => dom.window.close());
  const before = document.body.innerHTML;
  assert.equal(await navigateToReviewLine(file, { side: 'right', line: 19 }, document), true);
  assert.equal(dom.window.location.hash, `#${anchor}R19`);
  assert.equal(scrolls[0].target.closest('tr')!.getAttribute('data-line-number'), '19');
  assert.equal(document.body.innerHTML, before);
});

test('rejects malformed references, stale DOM identity and a file absent from the current PR', async t => {
  const { dom, document, scrolls } = page(classic(row('R', 7)));
  t.after(() => dom.window.close());
  for (const reference of [
    { side: 'right', line: 0 }, { side: 'right', line: -1 }, { side: 'right', line: 1.5 },
    { side: 'right', line: Number.MAX_SAFE_INTEGER + 1 }, { side: 'unknown', line: 7 },
  ] as AIReviewLine[]) {
    assert.throws(() => reviewLineHash(file, reference), RangeError);
    assert.equal(await navigateToReviewLine(file, reference, document), false);
  }
  assert.equal(await navigateToReviewLine({ ...file, anchor: otherAnchor }, { side: 'right', line: 7 }, document), false);
  assert.equal(await navigateToReviewLine({ ...file, path: 'src/wrong.ts' }, { side: 'right', line: 7 }, document), false);
  document.querySelector('#files_tab_counter')!.closest('a')!.href = '/acme/repo/pull/2/files';
  assert.equal(await navigateToReviewLine(file, { side: 'right', line: 7 }, document), false);
  assert.equal(scrolls.length, 0);
  assert.equal(dom.window.location.hash, '');
});

test('waits for a native tree click to mount the selected file and exact row', async t => {
  const { dom, document, scrolls } = page(`${tree}<main></main>${classic(row('R', 8, otherAnchor), { ...file, path: 'src/other.ts', anchor: otherAnchor })}`);
  t.after(() => dom.window.close());
  document.querySelector('[role="tree"] a')!.addEventListener('click', () => {
    setTimeout(() => { document.querySelector('main')!.innerHTML = classic(row('R', 8)); }, 15);
  });
  assert.equal(await navigateToReviewLine(file, { side: 'right', line: 8 }, document), true);
  assert.equal(dom.window.location.hash, `#${anchor}R8`);
  assert.equal(scrolls.at(-1)!.target.id, `${anchor}R8`);
});

test('never borrows the opposite side or an invalid gutter and can abort while waiting', async t => {
  const { dom, document, scrolls } = page(classic(row('R', 7) +
    `<tr><td class="blob-num" id="${anchor}L9" data-line-number="10"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="-">conflict()</span></td></tr>`));
  t.after(() => dom.window.close());
  for (const reference of [{ side: 'left', line: 7 }, { side: 'left', line: 9 }] as AIReviewLine[]) {
    const controller = new AbortController();
    const pending = navigateToReviewLine(file, reference, document, controller.signal);
    setTimeout(() => controller.abort(), 15);
    assert.equal(await pending, false);
  }
  assert.equal(scrolls.length, 0);
  assert.equal(dom.window.location.hash, '');
});

test('abandons a pending mount after changing PR or comparison instead of writing a stale line hash', async t => {
  for (const route of ['/acme/repo/pull/2/files', '/acme/repo/pull/1/files?base=another']) {
    const { dom, document, scrolls } = page(`${tree}<main></main>`);
    t.after(() => dom.window.close());
    const pending = navigateToReviewLine(file, { side: 'right', line: 8 }, document);
    setTimeout(() => {
      dom.window.history.replaceState({}, '', route);
      document.querySelector('main')!.innerHTML = classic(row('R', 8));
    }, 15);
    assert.equal(await pending, false);
    assert.equal(scrolls.length, 0);
    assert.equal(dom.window.location.hash, '');
  }
});

test('returns false within the bounded wait when the requested line never appears', { timeout: 6_500 }, async t => {
  const { dom, document, scrolls } = page(classic(row('R', 7)));
  t.after(() => dom.window.close());
  const started = Date.now();
  assert.equal(await navigateToReviewLine(file, { side: 'right', line: 999 }, document), false);
  assert.ok(Date.now() - started < 6_000);
  assert.equal(scrolls.length, 0);
  assert.equal(dom.window.location.hash, '');
});
