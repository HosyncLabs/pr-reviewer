import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { openReviewComment } from '../src/review-comment';
import { collectReviewContext } from '../src/review-context';

const anchor = `diff-${'a'.repeat(64)}`;
const file = { path: 'src/service.ts', anchor, deleted: false };
const classicRow = (side: 'L' | 'R') => `<tr><td class="blob-num" id="${anchor}${side}7" data-line-number="7"><button aria-label="Add a comment on line ${side}7"></button></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="${side === 'L' ? '-' : '+'}">currency = input.currency;</span></td></tr>`;
const composer = (target: string, value = '') => `<div class="js-inline-comments-container"><h4>Add a comment on ${target}</h4><textarea aria-label="Markdown value">${value}</textarea><button>Comment</button><button>Start a review</button></div>`;

function page(rows: string) {
  const dom = new JSDOM(`<a href="/acme/repo/pull/1/files"><span id="files_tab_counter">1</span></a><div class="file" id="${anchor}" data-tagsearch-path="${file.path}"><div class="file-header" data-path="${file.path}"><a href="#${anchor}" title="${file.path}">${file.path}</a><button>Comment on this file</button><input aria-label="Viewed" type="checkbox" checked></div><table>${rows}</table></div>`, { url: 'https://github.com/acme/repo/pull/1/files' });
  const { document } = dom.window;
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  document.addEventListener('click', event => { if ((event.target as Element).closest('a')) event.preventDefault(); });
  return { dom, document, target: document.getElementById(anchor)! };
}

test('opens an editable draft at the exact original or new line without posting or changing Viewed', async t => {
  const { dom, document, target } = page(classicRow('L') + classicRow('R'));
  t.after(() => dom.window.close());
  let posts = 0, inputEvents = 0;
  document.addEventListener('click', event => { if (['Comment', 'Start a review'].includes((event.target as Element).textContent!)) posts++; });
  document.addEventListener('input', () => inputEvents++);
  for (const side of ['L', 'R'] as const) {
    const gutter = document.getElementById(`${anchor}${side}7`)!;
    gutter.querySelector('button')!.onclick = () => {
      if (side === 'L') gutter.closest('tr')!.insertAdjacentHTML('afterend', '<tr class="js-inline-comments-container"><td colspan="2"><form><input type="hidden" name="pull_request_review_comment[line]" value="7"><input type="hidden" name="pull_request_review_comment[side]" value="LEFT"><textarea name="pull_request_review_comment[body]"></textarea><button>Comment</button></form></td></tr>');
      else gutter.closest('tr')!.lastElementChild!.insertAdjacentHTML('beforeend', composer(`line ${side}7`));
    };
    const draft = side === 'L' ? '¿Podemos comprobar la compatibilidad anterior?' : 'Could we test missing currency input?';
    assert.equal(await openReviewComment(file, { side: side === 'L' ? 'left' : 'right', line: 7 }, draft, document), 'filled');
    const editor = target.querySelector('textarea')!;
    assert.equal(editor.value, draft);
    assert.strictEqual(document.activeElement, editor);
    assert.equal(dom.window.location.hash, `#${anchor}${side}7`);
    assert.equal(await openReviewComment(file, { side: side === 'L' ? 'left' : 'right', line: 7 }, 'Replacement', document), 'preserved');
    assert.equal(editor.value, draft);
    editor.closest('.js-inline-comments-container')!.remove();
  }
  assert.equal(inputEvents, 2);
  assert.equal(posts, 0);
  assert.equal(target.querySelector('input')!.checked, true);
});

test('waits for a hover-mounted React control and composer, and excludes the draft from AI context', async t => {
  const { dom, document } = page(`<thead><tr><th>Original file line number</th><th>Diff line number</th><th>Diff line change</th></tr></thead><tbody><tr><td></td><td>7</td><td><span class="diff-text-inner">currency = input.currency;</span></td></tr></tbody>`);
  t.after(() => dom.window.close());
  const row = document.querySelector('tbody tr')!;
  row.addEventListener('mouseover', () => {
    setTimeout(() => {
      const button = document.createElement('button'); button.setAttribute('aria-label', 'Add a comment');
      button.onclick = () => setTimeout(() => row.lastElementChild!.insertAdjacentHTML('beforeend', composer('line R7')), 15);
      row.children[1].append(button);
    }, 15);
  }, { once: true });
  assert.equal(await openReviewComment(file, { side: 'right', line: 7 }, 'PRIVATE_EDITABLE_SUGGESTION', document), 'filled');
  assert.equal(document.querySelector('textarea')!.value, 'PRIVATE_EDITABLE_SUGGESTION');
  const context = await collectReviewContext(file, document);
  assert.match(context.diff, /\[new line 7\]/);
  assert.equal(context.diff.includes('PRIVATE_EDITABLE_SUGGESTION'), false);
});

test('opens Summary as a file comment and preserves another existing draft instead of replacing it', async t => {
  const { dom, document, target } = page(classicRow('R'));
  t.after(() => dom.window.close());
  const button = target.querySelector<HTMLButtonElement>('.file-header button')!;
  let clicks = 0;
  button.onclick = () => { clicks++; target.insertAdjacentHTML('beforeend', composer('this file')); };
  const existing = document.createElement('textarea'); existing.value = 'My existing draft'; document.body.append(existing);
  await assert.rejects(openReviewComment(file, undefined, 'Could we document rollback behavior?', document), /existing GitHub draft/);
  assert.equal(clicks, 0); assert.equal(existing.value, 'My existing draft');
  existing.remove();
  assert.equal(await openReviewComment(file, undefined, 'Could we document rollback behavior?', document), 'filled');
  assert.equal(target.querySelector('textarea')!.value, 'Could we document rollback behavior?');
  assert.equal(await openReviewComment(file, undefined, 'New draft', document), 'preserved');
  assert.equal(clicks, 1);
});

test('does not fill a late composer after cancellation or comparison changes', async t => {
  for (const changeRoute of [false, true]) {
    const { dom, document } = page(classicRow('R'));
    t.after(() => dom.window.close());
    const row = document.querySelector('tr')!;
    const controller = new AbortController();
    row.querySelector<HTMLButtonElement>('button')!.onclick = () => setTimeout(() => {
      if (changeRoute) dom.window.history.replaceState({}, '', '/acme/repo/pull/1/files?base=other');
      else controller.abort();
      row.lastElementChild!.insertAdjacentHTML('beforeend', composer('line R7'));
    }, 15);
    await assert.rejects(openReviewComment(file, { side: 'right', line: 7 }, 'Must not appear', document, controller.signal), /selected file changed/);
    assert.equal(document.querySelector('textarea')!.value, '');
  }
});

test('never clicks publishing buttons or an opposite-side control as a substitute', async t => {
  const { dom, document } = page(classicRow('R'));
  t.after(() => dom.window.close());
  const button = document.querySelector<HTMLButtonElement>('tr button')!;
  button.setAttribute('aria-label', 'Add a comment on line L7');
  document.querySelector('tr')!.insertAdjacentHTML('beforeend', '<td><button>Comment</button><button>Start a review</button></td>');
  let clicked = false;
  document.querySelectorAll<HTMLButtonElement>('tr button').forEach(button => { button.onclick = () => { clicked = true; }; });
  await assert.rejects(openReviewComment(file, { side: 'right', line: 7 }, 'Suggestion', document), /unavailable/);
  assert.equal(clicked, false);
  assert.equal(document.querySelector('textarea'), null);
});

test('rejects a composer whose native line identity disagrees with the requested reference', async t => {
  const { dom, document } = page(classicRow('R'));
  t.after(() => dom.window.close());
  const controller = new AbortController();
  const row = document.querySelector('tr')!;
  row.querySelector<HTMLButtonElement>('button')!.onclick = () => {
    row.lastElementChild!.insertAdjacentHTML('beforeend', composer('line L7'));
    setTimeout(() => controller.abort(), 15);
  };
  await assert.rejects(openReviewComment(file, { side: 'right', line: 7 }, 'Do not fill the wrong side', document, controller.signal), /selected file changed/);
  assert.equal(document.querySelector('textarea')!.value, '');
});
