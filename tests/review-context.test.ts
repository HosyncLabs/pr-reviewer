import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { PullRequestFile } from '../src/github';
import { collectReviewContext } from '../src/review-context';

const firstAnchor = `diff-${'a'.repeat(64)}`;
const secondAnchor = `diff-${'b'.repeat(64)}`;
const file = (path: string, additions?: number, deletions?: number): PullRequestFile =>
  ({ path, anchor: firstAnchor, deleted: false, additions, deletions });

function page(html: string, files: PullRequestFile[]) {
  const metadata = { payload: { pullRequestsChangesRoute: {
    pullRequestUrl: 'https://github.com/acme/repo/pull/1',
    diffSummaries: files.map(file => ({
      path: file.path, pathDigest: file.anchor.slice(5), changeType: 'MODIFIED',
      linesAdded: file.additions, linesDeleted: file.deletions,
    })),
  } } };
  return new JSDOM(`
    <a id="prs-files-anchor-tab" href="/acme/repo/pull/1/changes">Files changed</a>
    <react-app app-name="repo" initial-path="/acme/repo/pull/1/changes"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(metadata)}</script></react-app>
    <main>${html}</main>`, { url: 'https://github.com/acme/repo/pull/1/changes' });
}

const classic = (file: PullRequestFile, rows: string) => `
  <div class="file" id="${file.anchor}" data-tagsearch-path="${file.path}">
    <div class="file-header" data-path="${file.path}"><a href="#${file.anchor}" title="${file.path}">${file.path}</a></div>
    <table class="diff-table"><tbody>${rows}</tbody></table>
  </div>`;
const row = (marker: string, number: number, source: string) => `
  <tr><td class="blob-num" data-line-number="${number}"></td><td class="blob-code">
    <span class="blob-code-inner" data-code-marker="${marker}">${source}</span>
  </td></tr>`;
const region = (file: PullRequestFile, rows: string) => `
  <div role="region" id="${file.anchor}" aria-labelledby="heading-${file.anchor}">
    <h3 id="heading-${file.anchor}"><a href="#${file.anchor}"><code>\u200e${file.path}\u200e</code></a></h3>
    <table class="diff-table"><tbody>${rows}</tbody></table>
  </div>`;

test('extracts classic code with actual line numbers and markers while excluding review comments and drafts', async t => {
  const selected = file('backend/src/feature.ts', 1, 1);
  const dom = page(classic(selected, `
    ${row(' ', 10, '<span class="pl-c">// source comment stays</span>')}
    ${row('-', 11, 'const previous = 0;')}
    ${row('+', 12, 'const next = 1;<textarea>PRIVATE_DRAFT</textarea><div class="review-thread">PRIVATE_NESTED_COMMENT</div>')}
    <tr><td><div id="review-thread-or-comment-id"><span class="blob-code-inner" data-code-marker="+">PRIVATE_REVIEW_COMMENT</span></div></td></tr>
  `) + '<textarea id="draft">PRIVATE_PAGE_DRAFT</textarea><p>PRIVATE_PAGE_TEXT</p>', [selected]);
  t.after(() => dom.window.close());
  const before = dom.window.document.body.innerHTML;
  const context = await collectReviewContext(selected, dom.window.document);
  assert.deepEqual(context, {
    path: selected.path,
    diff: '[line 10]  // source comment stays\n[line 11] -const previous = 0;\n[line 12] +const next = 1;',
    partial: false,
  });
  assert.equal(context.diff.includes('PRIVATE'), false);
  assert.equal(dom.window.document.body.innerHTML, before);
});

test('waits for the exact React virtualized diff to mount and excludes the previous file', async t => {
  const selected = file('backend/db/migrations/001_currency.sql', 2, 0);
  const previous = { ...file('docs/previous.md', 1, 0), anchor: secondAnchor };
  const dom = page(region(previous, '<tr><td data-line-number="1"></td><td><span class="diff-text-inner" data-code-marker="+">PREVIOUS_FILE</span></td></tr>'), [selected, previous]);
  t.after(() => dom.window.close());
  const pending = collectReviewContext(selected, dom.window.document);
  await new Promise(resolve => setTimeout(resolve, 20));
  dom.window.document.querySelector('main')!.innerHTML = region(selected, `
    <tr data-line-number="5"><td><span class="diff-text-inner" data-code-marker="+">ALTER TABLE currency ADD COLUMN rate numeric;</span></td></tr>
    <tr data-line-number="6"><td><span class="diff-text-inner" data-code-marker="+">CREATE INDEX currency_rate ON currency(rate);</span></td></tr>`);
  assert.deepEqual(await pending, {
    path: selected.path,
    diff: '[line 5] +ALTER TABLE currency ADD COLUMN rate numeric;\n[line 6] +CREATE INDEX currency_rate ON currency(rate);',
    partial: false,
  });
});

test('supports the numeric-gutter demo table without treating its sample as a complete diff', async t => {
  const selected = file('docs/guide.md');
  const dom = page(classic(selected, '<tr><td>7</td><td>+ Sample documentation change</td></tr>'), [selected]);
  t.after(() => dom.window.close());
  assert.deepEqual(await collectReviewContext(selected, dom.window.document), {
    path: selected.path, diff: '[line 7] + Sample documentation change', partial: true,
  });
});

test('bounds context at 60000 characters and marks truncation as partial', async t => {
  const selected = file('tests/large.test.ts', 1, 0);
  const dom = page(classic(selected, row('+', 1, 'x'.repeat(65_000))), [selected]);
  t.after(() => dom.window.close());
  const context = await collectReviewContext(selected, dom.window.document);
  assert.equal(context.diff.length, 60_000);
  assert.ok(context.diff.startsWith('[line 1] +'));
  assert.equal(context.partial, true);
});

test('marks missing statistics, incomplete changes, lazy hunks, and hidden code as partial', async t => {
  for (const variant of ['unknown', 'mismatch', 'lazy', 'hidden']) {
    const selected = file('src/module.ts', variant === 'unknown' ? undefined : variant === 'mismatch' ? 2 : 1, variant === 'unknown' ? undefined : 0);
    const extra = variant === 'lazy' ? '<tr><td class="js-diff-load-container"><button aria-expanded="false">Load diff</button></td></tr>' :
      variant === 'hidden' ? `<tr hidden><td><span class="blob-code-inner" data-code-marker="+">HIDDEN_SOURCE</span></td></tr>` : '';
    const dom = page(classic(selected, row('+', 4, 'const visible = true;') + extra), [selected]);
    t.after(() => dom.window.close());
    const context = await collectReviewContext(selected, dom.window.document);
    assert.equal(context.partial, true, variant);
    assert.equal(context.diff.includes('HIDDEN_SOURCE'), false);
  }
});

test('does not mark a complete diff partial merely because its options menu is closed', async t => {
  const selected = file('src/module.ts', 1, 0);
  const dom = page(classic(selected, row('+', 4, 'const visible = true;')), [selected]);
  t.after(() => dom.window.close());
  dom.window.document.querySelector('.file-header')!.insertAdjacentHTML('beforeend',
    '<button aria-haspopup="menu" aria-expanded="false">Show options</button>');
  assert.equal((await collectReviewContext(selected, dom.window.document)).partial, false);
});

test('rejects a route change or mismatched rendered file and supports cancellation while waiting', async t => {
  const selected = file('src/pending.ts', 1, 0);
  const dom = page('', [selected]);
  t.after(() => dom.window.close());
  const pending = collectReviewContext(selected, dom.window.document);
  dom.window.history.replaceState({}, '', '/acme/repo/pull/2/changes');
  dom.window.document.querySelector('main')!.innerHTML = classic(selected, row('+', 1, 'STALE_SOURCE'));
  await assert.rejects(pending, /pull request or selected file changed/);

  const wrong = page(classic({ ...selected, path: 'src/other.ts' }, row('+', 1, 'OTHER_FILE')), [selected]);
  t.after(() => wrong.window.close());
  await assert.rejects(collectReviewContext(selected, wrong.window.document), /pull request or selected file changed/);

  const canceled = page('', [selected]);
  t.after(() => canceled.window.close());
  const controller = new AbortController();
  const canceledReview = collectReviewContext(selected, canceled.window.document, controller.signal);
  controller.abort();
  await assert.rejects(canceledReview, { name: 'AbortError' });
});

test('reports a missing or binary text diff with a load-and-retry action', async t => {
  const selected = file('assets/binary.png', 0, 0);
  const dom = page(classic(selected, '<tr><td>Binary file is not shown</td></tr>'), [selected]);
  t.after(() => dom.window.close());
  await assert.rejects(collectReviewContext(selected, dom.window.document), /No readable text diff.*Load or expand.*Retry/);
});
