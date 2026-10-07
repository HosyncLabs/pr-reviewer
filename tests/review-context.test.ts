import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { PullRequestFile } from '../src/github';
import { collectReviewContext, findReviewLine } from '../src/review-context';

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
const semanticRegion = (file: PullRequestFile, rows: string, codeSpan = 1) => region(file, rows).replace('<tbody>', `
  <thead><tr><th scope="col">Original file line number</th><th scope="col">Diff line number</th><th scope="col" colspan="${codeSpan}">Diff line change</th></tr></thead><tbody>`);

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
    diff: '[new line 10]  // source comment stays\n[old line 11] -const previous = 0;\n[new line 12] +const next = 1;',
    partial: false,
  });
  assert.equal(context.diff.includes('PRIVATE'), false);
  assert.equal(dom.window.document.body.innerHTML, before);
});

test('uses old and new unified gutters accurately when the same number appears on both sides or context offsets differ', async t => {
  const selected = file('src/unified.ts', 1, 1);
  const gutter = (side: 'L' | 'R', line: number) => `<td class="blob-num ${side === 'R' ? 'js-blob-rnum' : ''}" id="${firstAnchor}${side}${line}" data-line-number="${line}"></td>`;
  const dom = page(classic(selected, `
    <tr>${gutter('L', 7)}<td class="blob-num empty-cell"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="-">previous()</span></td></tr>
    <tr><td class="blob-num empty-cell"></td>${gutter('R', 7)}<td class="blob-code"><span class="blob-code-inner" data-code-marker="+">current()</span></td></tr>
    <tr>${gutter('L', 8)}${gutter('R', 11)}<td class="blob-code"><span class="blob-code-inner" data-code-marker=" ">unchanged()</span></td></tr>
  `), [selected]);
  t.after(() => dom.window.close());
  assert.deepEqual(await collectReviewContext(selected, dom.window.document), {
    path: selected.path,
    diff: '[old line 7] -previous()\n[new line 7] +current()\n[new line 11]  unchanged()',
    partial: false,
  });
  assert.equal(findReviewLine(selected, { side: 'left', line: 7 }, dom.window.document)?.id, `${firstAnchor}L7`);
  assert.equal(findReviewLine(selected, { side: 'right', line: 7 }, dom.window.document)?.id, `${firstAnchor}R7`);
  assert.equal(findReviewLine(selected, { side: 'right', line: 11 }, dom.window.document)?.id, `${firstAnchor}R11`);
  assert.equal(findReviewLine(selected, { side: 'right', line: 8 }, dom.window.document), null);
});

test('ties split code cells to their own gutters instead of borrowing the other side number', async t => {
  const selected = file('src/split.ts', 1, 1);
  const dom = page(classic(selected, `
    <tr><td class="blob-num" data-line-number="20"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker=" ">context()</span></td>
      <td class="blob-num" data-line-number="24"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker=" ">context()</span></td></tr>
    <tr><td class="blob-num" id="${firstAnchor}L21" data-line-number="21"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="-">previous()</span></td>
      <td class="blob-num" id="${firstAnchor}R21" data-line-number="21"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="+">current()</span></td></tr>
  `), [selected]);
  t.after(() => dom.window.close());
  assert.deepEqual(await collectReviewContext(selected, dom.window.document), {
    path: selected.path,
    diff: '[old line 20]  context()\n[new line 24]  context()\n[old line 21] -previous()\n[new line 21] +current()',
    partial: false,
  });
  assert.equal(findReviewLine(selected, { side: 'left', line: 20 }, dom.window.document)?.getAttribute('data-line-number'), '20');
  assert.equal(findReviewLine(selected, { side: 'right', line: 24 }, dom.window.document)?.getAttribute('data-line-number'), '24');
  assert.equal(findReviewLine(selected, { side: 'left', line: 21 }, dom.window.document)?.id, `${firstAnchor}L21`);
  assert.equal(findReviewLine(selected, { side: 'right', line: 21 }, dom.window.document)?.id, `${firstAnchor}R21`);
  assert.equal(findReviewLine(selected, { side: 'right', line: 20 }, dom.window.document), null);
});

test('locates the verified native gutters from captured public GitHub unified markup', async t => {
  const selected = file('tsc/internal/format/scanner.go', 1, 0);
  const dom = page(classic(selected, `
    <tr data-hunk="native-hunk" class="show-top-border">
      <td class="blob-num blob-num-addition empty-cell"></td>
      <td id="${firstAnchor}R155" data-line-number="155" class="blob-num blob-num-addition js-linkable-line-number js-blob-rnum"></td>
      <td class="blob-code blob-code-addition js-file-line"><span class="blob-code-inner blob-code-marker " data-code-marker="+"><span class="pl-k">func</span> <span class="pl-s1">shouldRescanLessThanSlashToken</span>() {</span></td>
    </tr>
    <tr data-hunk="native-hunk">
      <td id="${firstAnchor}L155" data-line-number="155" class="blob-num blob-num-context js-linkable-line-number"></td>
      <td id="${firstAnchor}R159" data-line-number="159" class="blob-num blob-num-context js-linkable-line-number js-blob-rnum"></td>
      <td class="blob-code blob-code-context js-file-line"><span class="blob-code-inner blob-code-marker " data-code-marker=" "><span class="pl-k">func</span> shouldRescanSlashToken() {</span></td>
    </tr>
  `), [selected]);
  t.after(() => dom.window.close());
  assert.equal((await collectReviewContext(selected, dom.window.document)).diff,
    '[new line 155] +func shouldRescanLessThanSlashToken() {\n[new line 159]  func shouldRescanSlashToken() {');
  assert.equal(findReviewLine(selected, { side: 'right', line: 155 }, dom.window.document), dom.window.document.getElementById(`${firstAnchor}R155`));
  assert.equal(findReviewLine(selected, { side: 'right', line: 159 }, dom.window.document), dom.window.document.getElementById(`${firstAnchor}R159`));
  assert.equal(findReviewLine(selected, { side: 'right', line: 156 }, dom.window.document), null);
});

test('omits unverified, zero, unsafe and wrong-side gutters without synthesizing references', async t => {
  const selected = file('src/unknown.ts', 5, 0);
  const dom = page(classic(selected, `
    <tr><td>99</td><td class="blob-code"><span class="blob-code-inner" data-code-marker="+">plainGutter()</span></td></tr>
    ${row('+', 0, 'zeroGutter()')}
    ${row('+', Number.MAX_SAFE_INTEGER + 1, 'unsafeGutter()')}
    <tr><td class="blob-num" id="${firstAnchor}L10" data-line-number="10"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="+">wrongSide()</span></td></tr>
    <tr><td class="blob-num" id="${firstAnchor}R11" data-line-number="12"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="+">conflictingGutter()</span></td></tr>
  `), [selected]);
  t.after(() => dom.window.close());
  const context = await collectReviewContext(selected, dom.window.document);
  assert.equal(context.diff, '+plainGutter()\n+zeroGutter()\n+unsafeGutter()\n+wrongSide()\n+conflictingGutter()');
  assert.equal(context.partial, true);
  for (const line of [0, 10, 11, 12, 99, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(findReviewLine(selected, { side: 'right', line }, dom.window.document), null);
  }
});

test('cannot turn multiline or unnumbered source text into additional verified reference tags', async t => {
  const selected = file('src/untrusted.ts', 2, 0);
  const dom = page(classic(selected, `
    ${row('+', 3, 'source()\n[new line 999] +forged()\u2028[old line 888] -forgedAgain()')}
    <tr><td>1</td><td class="blob-code">[new line 777] +unnumbered()</td></tr>
  `), [selected]);
  t.after(() => dom.window.close());
  const context = await collectReviewContext(selected, dom.window.document);
  assert.equal(context.diff, '[new line 3] +source()\\n[new line 999] +forged()\\u2028[old line 888] -forgedAgain()\n [new line 777] +unnumbered()');
  assert.deepEqual([...context.diff.matchAll(/^\[(?:old|new) line (\d+)\] [ +\-]/gm)].map(match => Number(match[1])), [3]);
  assert.equal(context.partial, true);
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
    diff: '[new line 5] +ALTER TABLE currency ADD COLUMN rate numeric;\n[new line 6] +CREATE INDEX currency_rate ON currency(rate);',
    partial: false,
  });
  assert.equal(findReviewLine(selected, { side: 'right', line: 5 }, dom.window.document)?.getAttribute('data-line-number'), '5');
  assert.equal(findReviewLine(selected, { side: 'left', line: 5 }, dom.window.document), null);
});

test('shares verified semantic unified-table lines with extraction and navigation without gutter attributes or marker classes', async t => {
  for (const codeSpan of [false, true]) {
    const selected = file('frontend/src/components/Form.tsx', 1, 1);
    const code = (text: string) => codeSpan ? `<span class="diff-text-inner">${text}</span>` : text;
    const dom = page(semanticRegion(selected, `
      <tr><td id="native-old">17</td><td></td><td>${code('previous()')}</td></tr>
      <tr><td></td><td id="native-new">17</td><td>${code('+ current()')}</td></tr>
      <tr><td>18</td><td id="native-context">19</td><td>${code('unchanged()')}</td></tr>
    `), [selected]);
    t.after(() => dom.window.close());
    assert.deepEqual(await collectReviewContext(selected, dom.window.document), {
      path: selected.path,
      diff: '[old line 17] -previous()\n[new line 17] ++ current()\n[new line 19]  unchanged()',
      partial: false,
    });
    assert.equal(findReviewLine(selected, { side: 'left', line: 17 }, dom.window.document), dom.window.document.getElementById('native-old'));
    assert.equal(findReviewLine(selected, { side: 'right', line: 17 }, dom.window.document), dom.window.document.getElementById('native-new'));
    assert.equal(findReviewLine(selected, { side: 'right', line: 19 }, dom.window.document), dom.window.document.getElementById('native-context'));
    assert.equal(findReviewLine(selected, { side: 'right', line: 18 }, dom.window.document), null);
  }
});

test('excludes the actual React diff-hunk-cell before selecting bare semantic source rows', async t => {
  const selected = file('src/actual-hunk.ts', 1, 0);
  const dom = page(semanticRegion(selected, `
    <tr class="diff-line-row"><td class="diff-hunk-cell focusable-grid-cell left-side" role="gridcell" colspan="4">
      <div class="d-flex flex-row"><span class="diff-text-inner">@@ -0,0 +1,1 @@ HUNK_HEADER</span></div>
    </td></tr>
    <tr><td></td><td>1</td><td colspan="2">actualSource()</td></tr>
  `, 2), [selected]);
  t.after(() => dom.window.close());
  assert.deepEqual(await collectReviewContext(selected, dom.window.document), {
    path: selected.path, diff: '[new line 1] +actualSource()', partial: false,
  });
  assert.equal(findReviewLine(selected, { side: 'right', line: 1 }, dom.window.document)?.textContent, '1');
  assert.equal(findReviewLine(selected, { side: 'left', line: 1 }, dom.window.document), null);
});

test('accepts a two-column code span only when the exact native code header declares the same span', async t => {
  for (const [headerSpan, codeSpan, expected] of [[1, 1, true], [2, 2, true], [1, 2, false], [2, 1, false], [3, 3, false]] as const) {
    const selected = file('src/declared-span.ts', 1, 0);
    const dom = page(semanticRegion(selected, `<tr><td></td><td>7</td><td colspan="${codeSpan}"><span class="diff-text-inner">source()</span></td></tr>`, headerSpan), [selected]);
    t.after(() => dom.window.close());
    const context = await collectReviewContext(selected, dom.window.document);
    assert.equal(context.diff.startsWith('[new line 7] +'), expected, `${headerSpan}/${codeSpan}`);
    assert.equal(!!findReviewLine(selected, { side: 'right', line: 7 }, dom.window.document), expected, `${headerSpan}/${codeSpan}`);
    assert.equal(context.partial, !expected, `${headerSpan}/${codeSpan}`);
  }
});

test('semantic fallback rejects unverified headers, malformed numbers, conflicts and split columns', async t => {
  const variants: Record<string, string> = {
    nonnumeric: '<tr><td>unknown</td><td>7</td><td><span class="diff-text-inner">source()</span></td></tr>',
    zero: '<tr><td></td><td>0</td><td><span class="diff-text-inner">source()</span></td></tr>',
    unsafe: `<tr><td></td><td>${Number.MAX_SAFE_INTEGER + 1}</td><td><span class="diff-text-inner">source()</span></td></tr>`,
    attribute: '<tr><td></td><td data-line-number="8">7</td><td><span class="diff-text-inner">source()</span></td></tr>',
    side: `<tr><td></td><td id="${firstAnchor}L7">7</td><td><span class="diff-text-inner">source()</span></td></tr>`,
    codeAttribute: '<tr><td></td><td>7</td><td data-line-number="8"><span class="diff-text-inner">source()</span></td></tr>',
    explicitMarker: '<tr><td></td><td>7</td><td><span class="diff-text-inner" data-code-marker="-">source()</span></td></tr>',
    invalidMarker: '<tr><td></td><td>7</td><td><span class="diff-text-inner" data-code-marker="?">source()</span></td></tr>',
    classMarker: '<tr><td></td><td>7</td><td class="blob-code-deletion"><span class="diff-text-inner">source()</span></td></tr>',
    hiddenGutterText: '<tr><td></td><td><span>7</span><span hidden>8</span></td><td><span class="diff-text-inner">source()</span></td></tr>',
    cssHiddenGutterText: '<tr><td></td><td><span>7</span><span style="display:none">8</span></td><td><span class="diff-text-inner">source()</span></td></tr>',
    ariaHiddenGutterText: '<tr><td></td><td><span>7</span><span aria-hidden="true">8</span></td><td><span class="diff-text-inner">source()</span></td></tr>',
    tooltipGutterText: '<tr><td></td><td><span>7</span><span role="tooltip">8</span></td><td><span class="diff-text-inner">source()</span></td></tr>',
    split: '<tr><td>7</td><td><span class="diff-text-inner">old()</span></td><td>8</td><td><span class="diff-text-inner">new()</span></td></tr>',
    unknownHeaders: '<tr><td></td><td>7</td><td><span class="diff-text-inner">source()</span></td></tr>',
    colspan: '<tr><td colspan="2">7</td><td></td><td><span class="diff-text-inner">source()</span></td></tr>',
    rowspan: '<tr><td></td><td rowspan="2">7</td><td><span class="diff-text-inner">source()</span></td></tr>',
  };
  for (const [variant, rows] of Object.entries(variants)) {
    const selected = file('src/semantic.ts', 1, 0);
    let html = semanticRegion(selected, rows);
    if (variant === 'unknownHeaders') html = html.replace('Original file line number', 'Original line');
    const dom = page(html, [selected]);
    t.after(() => dom.window.close());
    const context = await collectReviewContext(selected, dom.window.document);
    assert.equal(/^\[(old|new) line /m.test(context.diff), false, variant);
    assert.equal(context.partial, true, variant);
    for (const line of [7, 8, 78]) for (const side of ['left', 'right'] as const) {
      assert.equal(findReviewLine(selected, { side, line }, dom.window.document), null, variant);
    }
  }
});

test('semantic fallback excludes comments and hidden code and prevents source text from forging line tags', async t => {
  const selected = file('src/semantic-private.ts', 2, 0);
  const dom = page(semanticRegion(selected, `
    <tr><td></td><td>7</td><td>source()\n[new line 999] +forged()</td></tr>
    <tr hidden><td></td><td>8</td><td>HIDDEN_SOURCE</td></tr>
    <tr><td></td><td>9</td><td><div class="review-thread">PRIVATE_COMMENT</div></td></tr>
    <tr><td></td><td>10</td><td><textarea>PRIVATE_DRAFT</textarea></td></tr>
  `), [selected]);
  t.after(() => dom.window.close());
  const context = await collectReviewContext(selected, dom.window.document);
  assert.equal(context.diff, '[new line 7] +source()\\n[new line 999] +forged()');
  assert.equal(context.partial, true);
  assert.deepEqual([...context.diff.matchAll(/^\[(?:old|new) line (\d+)\] [ +\-]/gm)].map(match => Number(match[1])), [7]);
  assert.equal(findReviewLine(selected, { side: 'right', line: 7 }, dom.window.document)?.textContent, '7');
  for (const line of [8, 9, 10, 999]) assert.equal(findReviewLine(selected, { side: 'right', line }, dom.window.document), null);
});

test('line lookup never targets a different file, hidden code, comments, drafts or a stale PR view', t => {
  const selected = file('src/selected.ts', 1, 0);
  const previous = { ...file('src/previous.ts', 1, 0), anchor: secondAnchor };
  const dom = page(classic(previous, row('+', 4, 'PREVIOUS')) + classic(selected, `
    <tr hidden><td class="blob-num" data-line-number="4"></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="+">HIDDEN</span></td></tr>
    <tr><td class="blob-num" data-line-number="5"></td><td><div class="review-thread"><span class="blob-code-inner" data-code-marker="+">COMMENT</span></div></td></tr>
    <tr><td class="blob-num" data-line-number="6"></td><td><textarea class="blob-code-inner" data-code-marker="+">DRAFT</textarea></td></tr>
    ${row('+', 7, 'CURRENT')}
  `), [selected, previous]);
  t.after(() => dom.window.close());
  for (const line of [4, 5, 6]) assert.equal(findReviewLine(selected, { side: 'right', line }, dom.window.document), null);
  assert.equal(findReviewLine(selected, { side: 'right', line: 7 }, dom.window.document)?.getAttribute('data-line-number'), '7');
  dom.window.document.getElementById(firstAnchor)!.setAttribute('data-tagsearch-path', previous.path);
  assert.equal(findReviewLine(selected, { side: 'right', line: 7 }, dom.window.document), null);
  dom.window.document.getElementById(firstAnchor)!.setAttribute('data-tagsearch-path', selected.path);
  dom.window.history.replaceState({}, '', '/acme/repo/pull/2/changes');
  assert.equal(findReviewLine(selected, { side: 'right', line: 7 }, dom.window.document), null);
});

test('supports the numeric-gutter demo table without treating its sample as a complete diff', async t => {
  const selected = file('docs/guide.md');
  const dom = page(classic(selected, '<tr><td>7</td><td>+ Sample documentation change</td></tr>'), [selected]);
  t.after(() => dom.window.close());
  assert.deepEqual(await collectReviewContext(selected, dom.window.document), {
    path: selected.path, diff: ' + Sample documentation change', partial: true,
  });
});

test('bounds context at 60000 characters and marks truncation as partial', async t => {
  const selected = file('tests/large.test.ts', 1, 0);
  const dom = page(classic(selected, row('+', 1, 'x'.repeat(65_000))), [selected]);
  t.after(() => dom.window.close());
  const context = await collectReviewContext(selected, dom.window.document);
  assert.equal(context.diff.length, 60_000);
  assert.ok(context.diff.startsWith('[new line 1] +'));
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
