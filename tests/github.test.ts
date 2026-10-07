import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { getPullRequest, isPullRequestView, navigateToFile, readExpectedCount, readFiles } from '../src/github';

const firstAnchor = `diff-${'a'.repeat(64)}`;
const secondAnchor = `diff-${'b'.repeat(32)}`;
const dom = (html: string) => new JSDOM(html, { url: 'https://github.com/owner/repo/pull/1/files' });
const metadata = (diffSummaries: unknown[], initialPath = '/owner/repo/pull/1/files', pullRequestUrl = 'https://github.com/owner/repo/pull/1') =>
  `<react-app app-name="repo" initial-path="${initialPath}"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { pullRequestsChangesRoute: { pullRequestUrl, diffSummaries } } })}</script></react-app>`;

test('recognizes github.com PR overview, tabs and file comparisons', () => {
  assert.deepEqual(getPullRequest('https://github.com/Owner/Repo/pull/12/files?diff=split#top'), {
    owner: 'Owner', repo: 'Repo', number: 12, key: 'owner/repo#12',
    filesUrl: 'https://github.com/Owner/Repo/pull/12/files', isFilesPage: true,
  });
  for (const suffix of ['', '/', '/commits', '/checks']) {
    assert.equal(getPullRequest(`https://github.com/owner/repo/pull/12${suffix}`)?.isFilesPage, false);
  }
  assert.equal(getPullRequest('https://github.com/owner/repo/pull/12/files/base..head')?.isFilesPage, true);
  assert.equal(getPullRequest('https://github.com/owner/repo/pull/12/changes/base..head')?.isFilesPage, true);
  assert.equal(getPullRequest('https://github.com/owner/repo/pull/12/changes')?.filesUrl, 'https://github.com/owner/repo/pull/12/changes');
  for (const url of [
    'invalid', 'http://github.com/owner/repo/pull/1', 'https://github.example.com/owner/repo/pull/1',
    'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/pull/0',
    'https://github.com/owner/repo/pull/9007199254740992', 'https://github.com/owner/repo/pull/1/unknown',
  ]) assert.equal(getPullRequest(url), null);
});

test('requires matching native DOM identity before assigning files to the URL PR', () => {
  const pr = getPullRequest('https://github.com/owner/repo/pull/1/files')!;
  assert.equal(isPullRequestView(dom('<a href="/owner/repo/pull/1/files"><span id="files_tab_counter">2</span></a>').window.document, pr), true);
  assert.equal(isPullRequestView(dom('<a class="tabnav-tab" href="/owner/repo/pull/1/files">Files</a>').window.document, pr), true);
  assert.equal(isPullRequestView(dom('<a role="tab" href="/owner/repo/pull/1/files?diff=split">Files</a>').window.document, pr), true);
  assert.equal(isPullRequestView(dom('<a id="prs-files-anchor-tab" href="/owner/repo/pull/1/changes">Files</a>').window.document, pr), true);
  assert.equal(isPullRequestView(dom('<meta property="og:url" content="https://github.com/owner/repo/pull/1">').window.document, pr), true);
  assert.equal(isPullRequestView(dom('').window.document, pr), false);
  assert.equal(isPullRequestView(dom('<meta property="og:url" content="https://github.com/owner/repo/pull/2">').window.document, pr), false);
  assert.equal(isPullRequestView(dom('<meta property="og:url" content="https://github.com/owner/repo/pull/1"><a href="/owner/repo/pull/2/files"><span id="files_tab_counter">2</span></a>').window.document, pr), false);
  assert.equal(isPullRequestView(dom('<a class="tabnav-tab" href="/owner/repo/pull/1/files">Files</a><a role="tab" href="/owner/repo/pull/2/files">Stale files</a>').window.document, pr), false);
  assert.equal(isPullRequestView(dom('<a id="prs-files-anchor-tab" href="/owner/repo/pull/2/changes">Files</a>').window.document, pr), false);
});

test('reads native file metadata once, including deleted files; ignores tree labels and line anchors', () => {
  const { window } = dom(`
    <span id="files_tab_counter" title="2">2</span>
    <div role="tree"><a>index.ts</a></div>
    <div class="file js-file" id="${firstAnchor}" data-tagsearch-path="src/index.ts" data-file-deleted="false">
      <div class="file-header" data-path="src/index.ts" data-anchor="${firstAnchor}">
        <a href="#${firstAnchor}" title="src/index.ts">src/index.ts</a>
      </div>
      <td id="${firstAnchor}R1" data-path="fake.ts" data-anchor="${firstAnchor}R1">1</td>
    </div>
    <div class="file" id="${secondAnchor}" data-file-deleted="true">
      <div class="file-header" data-path="README.md"></div>
    </div>`);
  assert.deepEqual(readFiles(window.document), [
    { path: 'src/index.ts', anchor: firstAnchor, deleted: false },
    { path: 'README.md', anchor: secondAnchor, deleted: true },
  ]);
  assert.equal(readExpectedCount(window.document), 2);
});

test('uses explicit metadata fallback and rescans added, removed and replaced files', () => {
  const { window } = dom(`<section id="${firstAnchor}"><header data-path="src/a.ts" data-anchor="${firstAnchor}"></header></section>`);
  assert.equal(readFiles(window.document).length, 1);
  window.document.body.insertAdjacentHTML('beforeend',
    `<div id="${secondAnchor}" data-tagsearch-path="src/b.ts"></div>`);
  assert.equal(readFiles(window.document).length, 2);
  window.document.getElementById(firstAnchor)!.remove();
  assert.deepEqual(readFiles(window.document), [{ path: 'src/b.ts', anchor: secondAnchor, deleted: false }]);
  window.document.body.innerHTML = '<p>Different PR loading</p>';
  assert.deepEqual(readFiles(window.document), []);
});

test('reads complete route summaries with collapsed folders, validates entries and preserves deletions', () => {
  const { window } = dom(`${metadata([
    { path: 'backend/api/commission/sync.ts', pathDigest: firstAnchor.slice(5), changeType: 'ADDED' },
    { path: 'docs/removed.md', pathDigest: secondAnchor.slice(5), changeType: 'DELETED' },
    { path: '', pathDigest: 'c'.repeat(64) },
    { path: 3, pathDigest: 'c'.repeat(64) },
    { path: 'invalid.ts', pathDigest: 'c'.repeat(63) },
    { path: 'line.ts', pathDigest: `${'c'.repeat(64)}R1` },
    null,
  ])}
    <ul role="tree"><li role="treeitem" id="backend" aria-expanded="false"></li>
      <li role="treeitem" id="docs/removed.md"><a href="#${secondAnchor}">removed.md</a></li>
    </ul>
    <div id="${secondAnchor}" data-tagsearch-path="docs/removed.md"></div>`);
  assert.deepEqual(readFiles(window.document), [
    { path: 'backend/api/commission/sync.ts', anchor: firstAnchor, deleted: false },
    { path: 'docs/removed.md', anchor: secondAnchor, deleted: true },
  ]);
  window.document.querySelector('[role="tree"]')!.remove();
  assert.equal(readFiles(window.document).length, 2);
});

test('reads exact route line counts, preserves them across native sources, and leaves incomplete counts unknown', () => {
  const path = 'frontend/src/container.tsx';
  const { window } = dom(`${metadata([
    { path, pathDigest: firstAnchor.slice(5), changeType: 'MODIFIED', linesAdded: 25, linesDeleted: 17, linesChanged: 42 },
    { path: 'deleted.ts', pathDigest: secondAnchor.slice(5), changeType: 'DELETED', linesAdded: 0, linesDeleted: 4 },
  ])}
    <ul role="tree"><li role="treeitem" id="${path}"><a href="#${firstAnchor}">container.tsx</a></li></ul>
    <div id="${firstAnchor}" data-tagsearch-path="${path}"><header class="file-header" data-path="${path}"></header></div>`);
  assert.deepEqual(readFiles(window.document), [
    { path, anchor: firstAnchor, deleted: false, additions: 25, deletions: 17 },
    { path: 'deleted.ts', anchor: secondAnchor, deleted: true, additions: 0, deletions: 4 },
  ]);
  const script = window.document.querySelector('script')!;
  const payload = JSON.parse(script.textContent!);
  payload.payload.pullRequestsChangesRoute.diffSummaries[0].linesAdded = 26;
  script.textContent = JSON.stringify(payload);
  assert.equal(readFiles(window.document)[0].additions, 26);

  for (const [linesAdded, linesDeleted] of [
    [undefined, undefined], [3, undefined], [undefined, 3], [-1, 2], [2, -1],
    [1.5, 2], [2, 1.5], ['2', 3], [2, null], [Number.MAX_SAFE_INTEGER + 1, 2], [2, Number.MAX_SAFE_INTEGER + 1],
  ]) {
    script.textContent = JSON.stringify({ payload: { pullRequestsChangesRoute: {
      pullRequestUrl: 'https://github.com/owner/repo/pull/1',
      diffSummaries: [{ path, pathDigest: firstAnchor.slice(5), linesAdded, linesDeleted }],
    } } });
    assert.deepEqual(readFiles(window.document), [{ path, anchor: firstAnchor, deleted: false }]);
  }
});

test('ignores malformed, stale PR and comparison-route metadata while retaining native fallback', () => {
  const summaries = [{ path: 'stale.ts', pathDigest: secondAnchor.slice(5) }];
  const invalid = [
    metadata(summaries, '/owner/repo/pull/2/files'),
    metadata(summaries, '/owner/repo/pull/1/files', 'https://github.com/owner/repo/pull/2'),
    metadata(summaries, '/owner/repo/pull/1/files/base..head'),
    metadata(summaries, '/owner/repo/pull/1/files?base=old'),
    '<react-app app-name="repo" initial-path="/owner/repo/pull/1/files"><script type="application/json" data-target="react-app.embeddedData">{invalid}</script></react-app>',
  ];
  for (const html of invalid) {
    const { window } = dom(`${html}<div id="${firstAnchor}" data-tagsearch-path="native.ts"></div>`);
    assert.deepEqual(readFiles(window.document), [{ path: 'native.ts', anchor: firstAnchor, deleted: false }]);
  }
  const valid = dom(metadata(summaries));
  valid.reconfigure({ url: 'https://github.com/owner/repo/pull/1/files#changed-hash' });
  assert.equal(readFiles(valid.window.document).length, 1);
  valid.reconfigure({ url: 'https://github.com/owner/repo/pull/1/files?base=old' });
  assert.deepEqual(readFiles(valid.window.document), []);
});

test('expands only exact ancestor folders asynchronously before native file navigation and stops on a route change', async () => {
  const path = 'backend/api/commission/sync.ts';
  const summaries = [{ path, pathDigest: firstAnchor.slice(5) }];
  const makeDom = () => dom(`${metadata(summaries)}
    <input id="native-focus" value="Review stays">
    <textarea>A native comment</textarea><input id="viewed" type="checkbox" checked>
    <ul role="tree">
      <li role="treeitem" id="backend" aria-expanded="false"><div class="PRIVATE_TreeView-item-toggle"></div></li>
      <li role="treeitem" id="back" aria-expanded="false"><div class="PRIVATE_TreeView-item-toggle"></div></li>
      <li role="treeitem" id="frontend" aria-expanded="false"><div class="PRIVATE_TreeView-item-toggle"></div></li>
    </ul>`);
  const page = makeDom();
  const document = page.window.document;
  const expanded: string[] = [];
  let fileClicks = 0;
  const tree = document.querySelector('[role="tree"]')!;
  tree.addEventListener('click', event => {
    const target = event.target as Element;
    if (target.matches('a')) { event.preventDefault(); fileClicks += 1; return; }
    if (!target.matches('.PRIVATE_TreeView-item-toggle')) return;
    const item = target.closest('[role="treeitem"]')!;
    expanded.push(item.id);
    page.window.setTimeout(() => {
      item.setAttribute('aria-expanded', 'true');
      const next = item.id === 'backend' ? 'backend/api' : item.id === 'backend/api' ? 'backend/api/commission' : path;
      item.insertAdjacentHTML('beforeend', `<ul role="group"><li role="treeitem" id="${next}" ${next === path ? 'tabindex="-1"' : 'aria-expanded="false"'}>${next === path ? `<a href="#${firstAnchor}">sync.ts</a>` : '<div class="PRIVATE_TreeView-item-toggle"></div>'}</li></ul>`);
    }, 0);
  });
  assert.equal(await navigateToFile(readFiles(document)[0], document), true);
  assert.deepEqual(expanded, ['backend', 'backend/api', 'backend/api/commission']);
  assert.equal(fileClicks, 1);
  assert.equal(document.activeElement?.id, path);
  assert.equal(document.getElementById('frontend')!.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('textarea')!.value, 'A native comment');
  assert.equal((document.getElementById('viewed') as HTMLInputElement).checked, true);

  const changed = makeDom();
  let navigations = 0;
  changed.window.document.querySelector('.PRIVATE_TreeView-item-toggle')!.addEventListener('click', () => {
    navigations += 1;
    changed.reconfigure({ url: 'https://github.com/owner/repo/pull/2/files' });
  });
  assert.equal(await navigateToFile(readFiles(changed.window.document)[0], changed.window.document), false);
  assert.equal(navigations, 1);
});

test('cancels pending ancestor expansion so an earlier file cannot override a later navigation', async t => {
  const firstPath = 'backend/a.ts';
  const secondPath = 'src/b.ts';
  const page = dom(`${metadata([
    { path: firstPath, pathDigest: firstAnchor.slice(5) },
    { path: secondPath, pathDigest: secondAnchor.slice(5) },
  ])}
    <ul role="tree">
      <li role="treeitem" id="backend" aria-expanded="false"><div class="PRIVATE_TreeView-item-toggle"></div></li>
      <li role="treeitem" id="${secondPath}" tabindex="-1"><a href="#${secondAnchor}">b.ts</a></li>
    </ul>`);
  t.after(() => page.window.close());
  const document = page.window.document;
  const nativeClicks: string[] = [];
  document.querySelector('[role="tree"]')!.addEventListener('click', event => {
    const target = event.target as Element;
    if (target.matches('a')) {
      event.preventDefault();
      nativeClicks.push(target.closest('[role="treeitem"]')!.id);
    } else if (target.matches('.PRIVATE_TreeView-item-toggle')) {
      page.window.setTimeout(() => {
        const folder = target.closest('[role="treeitem"]')!;
        folder.setAttribute('aria-expanded', 'true');
        folder.insertAdjacentHTML('beforeend', `<ul role="group"><li role="treeitem" id="${firstPath}" tabindex="-1"><a href="#${firstAnchor}">a.ts</a></li></ul>`);
      }, 0);
    }
  });
  const files = readFiles(document);
  const controller = new AbortController();
  const earlier = navigateToFile(files[0], document, controller.signal);
  controller.abort();
  assert.equal(await navigateToFile(files[1], document), true);
  assert.equal(await earlier, false);
  assert.deepEqual(nativeClicks, [secondPath]);
  assert.equal(document.activeElement?.id, secondPath);
});

test('reads full tree paths with duplicate basenames and navigates an unmounted diff through its native tree link', async () => {
  const { window } = dom(`
    <ul role="tree" aria-label="File Tree">
      <li role="treeitem" id="src" aria-expanded="false">
        <ul role="group" hidden>
          <li role="treeitem" id="src/index.ts" tabindex="-1"><a role="presentation" tabindex="-1" href="#${firstAnchor}">index.ts</a></li>
        </ul>
      </li>
      <li role="treeitem" id="tests/index.ts" tabindex="-1"><a role="presentation" tabindex="-1" href="#${secondAnchor}">index.ts</a></li>
      <li role="treeitem" id="folder" aria-expanded="true"><a href="#diff-${'c'.repeat(64)}">folder</a></li>
      <li role="treeitem"><a href="#${firstAnchor}">Ambiguous path</a></li>
      <li role="treeitem" id="wrong.ts"><a href="#${firstAnchor}R1">Wrong line anchor</a></li>
    </ul>
    <div id="${firstAnchor}" data-tagsearch-path="src/index.ts" data-file-deleted="true"></div>`);
  const document = window.document;
  const files = readFiles(document);
  assert.deepEqual(files, [
    { path: 'src/index.ts', anchor: firstAnchor, deleted: true },
    { path: 'tests/index.ts', anchor: secondAnchor, deleted: false },
  ]);
  const row = document.getElementById('tests/index.ts')!;
  let clicks = 0;
  row.addEventListener('click', event => { event.preventDefault(); clicks += 1; });
  const before = document.body.innerHTML;
  assert.equal(document.getElementById(secondAnchor), null);
  assert.equal(await navigateToFile(files[1], document), true);
  assert.equal(clicks, 1);
  assert.equal(document.activeElement, row);
  assert.equal(document.body.innerHTML, before);
  assert.equal(await navigateToFile({ ...files[1], path: 'index.ts' }, document), false);
  assert.equal(await navigateToFile({ ...files[1], anchor: firstAnchor }, document), false);
});

test('reads observed React regions with exact heading paths, preserves filename spaces and uses native navigation', async () => {
  const { window } = dom(`
    <a id="prs-files-anchor-tab" href="/owner/repo/pull/1/changes">Files changed<span data-component="CounterLabel" aria-hidden="true">6</span><span> (6)</span></a>
    <div role="region" aria-labelledby="heading-react" id="${firstAnchor}" data-estimated-height="1817">
      <h3 id="heading-react"><a data-component="Link" href="#${firstAnchor}"><code>\u200e<!-- -->tsc/internal/format/scanner.go<!-- -->\u200e</code></a></h3>
      <input type="checkbox" checked><textarea>Comment stays</textarea>
    </div>
    <div role="region" aria-labelledby="heading-spaces" id="${secondAnchor}">
      <h3 id="heading-spaces"><a href="#${secondAnchor}"><code>\u200e src/file with spaces.ts \u200e</code></a></h3>
    </div>
    <div role="region" aria-labelledby="wrong-heading" id="diff-${'c'.repeat(64)}">
      <h3 id="wrong-heading"><a href="#${firstAnchor}"><code>wrong.ts</code></a></h3>
    </div>`);
  const document = window.document;
  assert.deepEqual(readFiles(document), [
    { path: 'tsc/internal/format/scanner.go', anchor: firstAnchor, deleted: false },
    { path: ' src/file with spaces.ts ', anchor: secondAnchor, deleted: false },
  ]);
  assert.equal(readExpectedCount(document), 6);
  const link = document.querySelector<HTMLAnchorElement>('#heading-react a')!;
  let clicks = 0;
  link.addEventListener('click', (event) => { event.preventDefault(); clicks += 1; });
  const before = document.body.innerHTML;
  assert.equal(await navigateToFile(readFiles(document)[0], document), true);
  assert.equal(clicks, 1);
  assert.equal(document.activeElement, link);
  assert.equal(document.body.innerHTML, before);
});

test('reports missing or ambiguous counters as unknown, including a legitimate zero', () => {
  assert.equal(readExpectedCount(dom('').window.document), null);
  assert.equal(readExpectedCount(dom('<span id="files_tab_counter">Loading…</span>').window.document), null);
  assert.equal(readExpectedCount(dom('<span id="files_tab_counter" title="changed files">0</span>').window.document), 0);
  assert.equal(readExpectedCount(dom('<span id="files_tab_counter">1,234</span>').window.document), 1234);
});

test('navigates through the exact native header link and leaves review controls unchanged', async () => {
  const { window } = dom(`
    <div class="file" id="${firstAnchor}" data-tagsearch-path="src/index.ts">
      <div class="file-header"><a href="#${firstAnchor}" title="src/index.ts">src/index.ts</a></div>
      <input type="checkbox" checked><textarea>A native comment</textarea><table><tr><td>diff</td></tr></table>
    </div>`);
  const document = window.document;
  const before = document.body.innerHTML;
  let clicks = 0;
  document.querySelector('a')!.addEventListener('click', (event) => { event.preventDefault(); clicks += 1; });
  assert.equal(await navigateToFile(readFiles(document)[0], document), true);
  assert.equal(clicks, 1);
  assert.equal(document.activeElement, document.querySelector('a'));
  assert.equal(document.body.innerHTML, before);
  assert.equal(document.querySelector('input')!.checked, true);
  assert.equal(await navigateToFile({ path: 'src/wrong.ts', anchor: firstAnchor, deleted: false }, document), false);
  document.getElementById(firstAnchor)!.remove();
  assert.equal(await navigateToFile({ path: 'src/index.ts', anchor: firstAnchor, deleted: false }, document), false);
});

test('scrolls only to the exact diff target when a header link is absent', async () => {
  const { window } = dom(`<div id="${firstAnchor}" data-tagsearch-path="src/index.ts"></div>`);
  let scrolled = false;
  window.document.getElementById(firstAnchor)!.scrollIntoView = () => { scrolled = true; };
  assert.equal(await navigateToFile(readFiles(window.document)[0], window.document), true);
  assert.equal(scrolled, true);
});

test('refuses filtered or hidden diffs without changing native review state or focus', async () => {
  for (const filter of ['hidden', 'ancestor', 'native-check']) {
    const { window } = dom(`
      <input id="native-focus" value="Review stays">
      <section ${filter === 'ancestor' ? 'style="display:none"' : ''}>
        <div class="file" id="${firstAnchor}" data-tagsearch-path="src/index.ts" ${filter === 'hidden' ? 'hidden' : ''}>
          <div class="file-header"><a href="#${firstAnchor}" title="src/index.ts">src/index.ts</a></div>
          <input type="checkbox" checked><textarea>A native comment</textarea>
        </div>
      </section>`);
    const document = window.document;
    const focused = document.getElementById('native-focus')!;
    focused.focus();
    const target = document.getElementById(firstAnchor)!;
    if (filter === 'native-check') target.checkVisibility = (options) => {
      assert.deepEqual(options, { visibilityProperty: true });
      return false;
    };
    let clicks = 0;
    let scrolls = 0;
    document.querySelector('a')!.addEventListener('click', (event) => { event.preventDefault(); clicks += 1; });
    target.scrollIntoView = () => { scrolls += 1; };
    const before = document.body.innerHTML;
    const files = readFiles(document);
    assert.equal(files.length, 1);
    assert.equal(await navigateToFile(files[0], document), false, filter);
    assert.equal(clicks, 0);
    assert.equal(scrolls, 0);
    assert.equal(document.activeElement, focused);
    assert.equal(document.body.innerHTML, before);
  }
});
