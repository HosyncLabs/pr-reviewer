import { webcrypto } from 'node:crypto';
import { DEFAULT_WORKFLOW, sameDiffRevision } from '../src/workflow';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { AI_PROVIDERS, AI_STATUS_NOTICE, DEFAULT_AI_MODEL, PREFERENCES_NOTICE, type AILanguage, type AIProvider, type ExtensionRequest, type ExtensionResponse } from '../src/ai-protocol';
import { isCategory, isImplementationGroup, type Category, type ClassificationRule, type ImplementationGroup } from '../src/classifier';
import type { RepositoryPreferences } from '../src/storage';

const bundle = await readFile(new URL('../dist/content.js', import.meta.url), 'utf8');
const initialPaths = ['README.md', 'src/client.ts', 'tests/client.test.ts'];
const anchor = (index: number) => `diff-${String(index + 1).padStart(64, '0')}`;
const filesHTML = (paths: string[]) => paths.map((path, index) => `
  <div class="js-file" data-tagsearch-path="${path}" id="${anchor(index)}">
    <div class="file-header" data-path="${path}" data-anchor="${anchor(index)}">
      <a href="#${anchor(index)}" title="${path}">${path}</a>
      <label><input type="checkbox" aria-label="Viewed"> Viewed</label>
    </div>
    <table><tbody><tr><td>Native diff for ${path}</td></tr></tbody></table>
    <textarea aria-label="Review comment"></textarea>
  </div>`).join('');

// Metadata observed in GitHub's React large-PR view: the tree keeps all paths
// while only the current diff regions are mounted.
const treeHTML = (paths: string[]) => `<ul role="tree" aria-label="File Tree" data-truncate-text="true">${paths.map((path, index) => `
  <li role="treeitem" id="${path}" aria-level="3" aria-label="${path.slice(path.lastIndexOf('/') + 1)}" aria-selected="false" tabindex="-1">
    <a data-component="Link" data-muted="true" href="#${anchor(index)}" role="presentation" tabindex="-1">${path.slice(path.lastIndexOf('/') + 1)}</a>
  </li>`).join('')}</ul>`;
const regionHTML = (path: string, index: number) => `
  <div role="region" aria-labelledby="heading-${index}" id="${anchor(index)}" data-estimated-height="1817">
    <h3 id="heading-${index}"><a data-component="Link" href="#${anchor(index)}"><code>\u200e${path}\u200e</code></a></h3>
    <table><tbody><tr><td>Native diff for ${path}</td></tr></tbody></table>
  </div>`;

type Storage = Record<string, unknown>;
type RuntimeHandler = (message: ExtensionRequest) => ExtensionResponse | void | Promise<ExtensionResponse | void>;

function page(url = 'https://github.com/acme/example/pull/12/files', stored: Storage = {}, html?: string, runtimeHandler?: RuntimeHandler, beforeEval?: (window: JSDOM['window']) => void) {
  const errors: Error[] = [];
  const listeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  const messages: ExtensionRequest[] = [];
  let nonce = 0;
  const notify = (key: string, value: Record<string, unknown>) => {
    for (const listener of listeners) listener({ [key]: { newValue: { ...value, nonce: String(++nonce) } } }, 'session');
  };
  const preferences = (repository: string): RepositoryPreferences => {
    const key = `pr-reviewer:repo:${repository.toLowerCase()}`;
    const overridePrefix = `${key}:file:`;
    const implementationPrefix = `${key}:implementation:`;
    const raw = stored[key] as { rules?: unknown } | undefined;
    const overrides: Record<string, Category> = {};
    const implementationOverrides: Record<string, ImplementationGroup> = {};
    for (const [name, value] of Object.entries(stored)) {
      if (name.startsWith(overridePrefix) && isCategory(value)) overrides[name.slice(overridePrefix.length)] = value;
      if (name.startsWith(implementationPrefix) && isImplementationGroup(value)) implementationOverrides[name.slice(implementationPrefix.length)] = value;
    }
    const rules = Array.isArray(raw?.rules) ? raw.rules.filter((rule: unknown): rule is ClassificationRule =>
      !!rule && typeof rule === 'object' && 'pattern' in rule && typeof rule.pattern === 'string' && 'category' in rule && isCategory(rule.category)) : [];
    return {
      overrides, implementationOverrides, rules: structuredClone(rules),
    };
  };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(`<html><body>${html ?? `
    <a class="tabnav-tab" href="${new URL(url).pathname}"><span id="files_tab_counter" title="${initialPaths.length}">${initialPaths.length}</span></a>
    <main id="native-files">${filesHTML(initialPaths)}</main>
  `}</body></html>`, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
  Object.assign(window, {
    TextEncoder, TextDecoder,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    chrome: {
      runtime: { sendMessage: async (message: ExtensionRequest): Promise<ExtensionResponse> => {
        messages.push(structuredClone(message));
        const response = await runtimeHandler?.(message);
        if (response) return response;
        if (message.type === 'ai-status') return { ok: true, status: { configured: false, enabled: false, model: DEFAULT_AI_MODEL, language: 'en' } };
        if (message.type === 'ai-open-settings' || message.type === 'ai-cancel') return { ok: true };
        if (message.type === 'ai-review') return { ok: false, error: 'AI review is not configured in this test.' };
        if (message.type === 'github-context') return { ok: false, error: 'API context is not configured in this fixture.' };
        const progressKey = 'test:progress:' + new URL(window.document.URL).pathname + new URL(window.document.URL).search;
        if (message.type === 'progress-load') return { ok: true, progress: structuredClone(stored[progressKey] ?? { files: {}, lastFile: '' }) as any };
        if (message.type === 'progress-save') {
          const progress: any = stored[progressKey] ?? { files: {}, lastFile: '' };
          let file = progress.files[message.path] ?? { revision: '', reviewed: false, note: '', blocks: {}, checks: {} };
          if (message.revision && message.revision !== file.revision) file = sameDiffRevision(file.revision, message.revision) ? { ...file, revision: message.revision } : { revision: message.revision, reviewed: false, note: file.note, blocks: {}, checks: {} };
          if (message.reviewed !== undefined) file.reviewed = message.reviewed;
          if (message.note !== undefined) file.note = message.note;
          if (message.block) { if (message.block.state) file.blocks[message.block.key] = message.block.state; else delete file.blocks[message.block.key]; }
          if (message.check) file.checks[message.check.key] = message.check.checked;
          if (message.lastFile) progress.lastFile = message.path;
          progress.files[message.path] = file; stored[progressKey] = progress;
          return { ok: true, progress: structuredClone(progress) };
        }
        if (message.type !== 'preferences-load') {
          const key = `pr-reviewer:repo:${message.repository.toLowerCase()}:${message.type === 'preferences-category' ? 'file' : 'implementation'}:${message.path}`;
          const value = message.type === 'preferences-category' ? message.category : message.group;
          if (value) stored[key] = value;
          else delete stored[key];
          notify(PREFERENCES_NOTICE, { repository: message.repository.toLowerCase() });
        }
        return { ok: true, preferences: preferences(message.repository) };
      } },
      storage: { local: { get: async () => { throw new Error('Content scripts cannot read protected local storage.'); } }, onChanged: {
        addListener: (listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => listeners.add(listener),
        removeListener: (listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => listeners.delete(listener),
      } },
    },
  });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  beforeEval?.(window);
  window.eval(bundle);
  return { dom, window, stored, errors, messages, notifyAI: () => notify(AI_STATUS_NOTICE, {}) };
}

async function until<T>(read: () => T | null | undefined | false, description: string, timeout = 4_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out: ${description}`);
}

async function openPanel(window: JSDOM['window']) {
  const shadow = await until(() => window.document.querySelector('#pr-reviewer-root')?.shadowRoot, 'extension host');
  const launcher = await until(() => shadow.querySelector<HTMLButtonElement>('button.launcher'), 'launcher');
  if (launcher.getAttribute('aria-expanded') !== 'true') launcher.click();
  await until(() => shadow.querySelector('aside[aria-label="Pull request organizer"]'), 'panel');
  return shadow;
}

const links = (root: ParentNode) => [...root.querySelectorAll<HTMLAnchorElement>('a.file-link')];
const paths = (root: ParentNode) => links(root).map(link => link.title).sort();
const reviewComment = (text: string, side: 'left' | 'right' = 'right') => ({ text, lines: [{ side, line: 1 }] });

test('adds AI comment drafts through native controls and collapses reviewed blocks without publishing', async t => {
  const path = 'src/service.ts';
  const html = `<a href="/acme/example/pull/12/files"><span id="files_tab_counter">1</span></a>
    <div class="file" id="${anchor(0)}" data-tagsearch-path="${path}">
      <div class="file-header" data-path="${path}"><a href="#${anchor(0)}" title="${path}">${path}</a><button>Comment on this file</button><input type="checkbox" aria-label="Viewed" checked></div>
      <table><tbody><tr><td class="blob-num" id="${anchor(0)}R1" data-line-number="1"><button aria-label="Add a comment on line R1"></button></td><td class="blob-code"><span class="blob-code-inner" data-code-marker="+">const currency = input.currency ?? 'USD';</span></td></tr></tbody></table>
    </div>`;
  const current = page(undefined, {}, html, message => {
    if (message.type === 'ai-status') return { ok: true, status: { configured: true, enabled: true, model: 'fixture', language: 'es' } };
    if (message.type === 'ai-review') return { ok: true, review: {
      summary: 'El cambio añade una moneda predeterminada.', summaryComment: '¿Podemos documentar cuándo se aplica la moneda predeterminada?',
      highlights: [{ text: 'Se usa USD si falta la moneda.', lines: [{ side: 'right', line: 1 }], suggestedComment: '¿Podemos probar una solicitud sin moneda y otra con moneda explícita?' }],
      focus: [{ text: 'Verifica la entrada vacía.', lines: [], suggestedComment: '¿Qué debe ocurrir cuando la moneda es una cadena vacía?' }],
    } };
  });
  t.after(() => current.dom.window.close());
  const { document } = current.window;
  const nativeFile = document.getElementById(anchor(0))!;
  let submitted = 0, nativeOpens = 0;
  const mountComposer = (scope: Element, line: string) => {
    scope.insertAdjacentHTML('beforeend', `<div class="js-inline-comments-container"><h4>Add a comment on ${line}</h4><textarea aria-label="Markdown value"></textarea><button>Comment</button><button>Start a review</button></div>`);
    scope.querySelectorAll<HTMLButtonElement>('.js-inline-comments-container button').forEach(button => { button.onclick = () => { submitted++; }; });
  };
  nativeFile.querySelector<HTMLButtonElement>('tr button')!.onclick = () => { nativeOpens++; mountComposer(nativeFile.querySelector('tr td:last-child')!, 'line R1'); };
  nativeFile.querySelector<HTMLButtonElement>('.file-header button')!.onclick = () => { nativeOpens++; mountComposer(nativeFile, 'this file'); };
  const shadow = await openPanel(current.window);
  (await until(() => links(shadow)[0], 'file link')).click();
  await until(() => shadow.querySelector('.ai-result'), 'AI blocks');
  assert.equal(shadow.querySelectorAll('.ai-block-actions button').length, 8, 'Both actions appear on Summary, Highlights and Review focus');
  const button = (block: Element, label: string) => [...block.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!;
  const summary = shadow.querySelector('.ai-summary-card')!;
  const highlight = shadow.querySelector('.ai-highlights .ai-comment')!;
  const focus = shadow.querySelector('.ai-focus .ai-comment')!;
  button(highlight, 'Reviewed').click();
  await until(() => highlight.classList.contains('is-collapsed'), 'Reviewed collapses');
  assert.equal(highlight.classList.contains('is-reviewed'), true);
  const disclosure = highlight.querySelector<HTMLButtonElement>('.ai-reviewed-toggle')!;
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(shadow.getElementById(disclosure.getAttribute('aria-controls')!)!.hidden, true);
  assert.strictEqual(shadow.activeElement, disclosure);
  assert.match(shadow.querySelector('style')!.textContent!, /\.ai-result \.is-reviewed \{ background:var\(--reviewed-bg\)/);
  disclosure.click();
  await until(() => !highlight.classList.contains('is-collapsed'), 'reopen Reviewed block');
  assert.equal(highlight.classList.contains('is-reviewed'), true);
  button(highlight, 'Add comment').click();
  const editor = await until(() => nativeFile.querySelector<HTMLTextAreaElement>('textarea')?.value ? nativeFile.querySelector<HTMLTextAreaElement>('textarea') : null, 'AI suggestion in native editor');
  assert.equal(editor.value, '¿Podemos probar una solicitud sin moneda y otra con moneda explícita?');
  assert.strictEqual(document.activeElement, editor);
  assert.equal(current.window.location.hash, `#${anchor(0)}R1`);
  await until(() => highlight.textContent?.includes('Draft added in GitHub'), 'successful draft notice');
  editor.value = 'My edited draft';
  button(highlight, 'Add comment').click();
  await until(() => highlight.textContent?.includes('Your existing draft was preserved'), 'existing draft preserved');
  assert.equal(editor.value, 'My edited draft');
  assert.equal(nativeOpens, 1);
  button(focus, 'Add comment').click();
  await until(() => focus.textContent?.includes('Finish or cancel your existing GitHub draft'), 'unrelated draft protection');
  assert.equal(focus.querySelector('textarea')!.value, '¿Qué debe ocurrir cuando la moneda es una cadena vacía?');
  assert.equal(editor.value, 'My edited draft');
  editor.closest('.js-inline-comments-container')!.remove();
  button(summary, 'Add comment').click();
  await until(() => nativeFile.querySelector<HTMLTextAreaElement>('textarea')?.value === '¿Podemos documentar cuándo se aplica la moneda predeterminada?', 'Summary file comment');
  await until(() => summary.textContent?.includes('Draft added in GitHub'), 'Summary draft notice');
  button(summary, 'Reviewed').click();
  await until(() => summary.classList.contains('is-reviewed') && summary.classList.contains('is-collapsed'), 'Summary Reviewed');
  const viewButton = (label: string) => [...shadow.querySelectorAll<HTMLButtonElement>('.panel-views button')].find(button => button.textContent === label)!;
  viewButton('Files').click();
  await until(() => shadow.querySelector<HTMLElement>('.ai-review')!.hidden, 'Files view');
  viewButton('AI review').click();
  await until(() => !shadow.querySelector<HTMLElement>('.ai-review')!.hidden, 'AI view returns');
  assert.equal(summary.classList.contains('is-collapsed'), true, 'Reviewed survives switching views');
  const analysis = shadow.querySelector('.ai-result')!;
  shadow.querySelector<HTMLButtonElement>('button[aria-label="Collapse panel"]')!.click();
  await until(() => shadow.querySelector<HTMLElement>('#pr-reviewer-panel-content')!.hidden, 'AI panel collapsed horizontally');
  assert.strictEqual(shadow.querySelector('.ai-result'), analysis);
  shadow.querySelector<HTMLButtonElement>('button[aria-label="Expand panel"]')!.click();
  await until(() => !shadow.querySelector<HTMLElement>('#pr-reviewer-panel-content')!.hidden, 'AI panel expanded');
  assert.strictEqual(shadow.querySelector('.ai-result'), analysis);
  assert.equal(summary.classList.contains('is-collapsed'), true, 'Reviewed survives collapsing the whole panel');
  assert.equal(nativeFile.querySelector('textarea')!.value, '¿Podemos documentar cuándo se aplica la moneda predeterminada?');
  button(highlight, 'Undo reviewed').click();
  await until(() => !highlight.classList.contains('is-reviewed'), 'undo Reviewed');
  assert.equal(nativeFile.querySelector('input')!.checked, true);
  assert.equal(submitted, 0, 'No posting or review submission controls were clicked');
  assert.equal(current.messages.filter(message => message.type === 'ai-review').length, 1, 'Drafts come from the original review, with no extra provider call');
  assert.equal(current.messages.some(message => JSON.stringify(message).includes('My edited draft')), false);
  assert.deepEqual(current.errors, []);
});

test('folds the panel into a side rail and restores search, groups, scroll, focus and native drafts', async t => {
  const current = page();
  t.after(() => current.dom.window.close());
  const { window } = current;
  const shadow = await openPanel(window);
  await until(() => links(shadow).length === initialPaths.length, 'file inventory');
  const panel = shadow.querySelector('aside')!;
  const content = shadow.getElementById('pr-reviewer-panel-content')!;
  const launcher = shadow.querySelector<HTMLButtonElement>('button.launcher')!;
  const collapse = shadow.querySelector<HTMLButtonElement>('button[aria-label="Collapse panel"]')!;
  const expand = shadow.querySelector<HTMLButtonElement>('button[aria-label="Expand panel"]')!;
  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const groups = shadow.querySelector<HTMLElement>('.groups')!;
  const implementation = shadow.querySelector<HTMLDetailsElement>('.group.implementation')!;
  const draft = window.document.querySelector('textarea')!;
  const viewed = window.document.querySelector('input')!;
  draft.value = 'Keep my native draft'; viewed.checked = true;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'client');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => links(shadow).length === 2, 'filtered files');
  implementation.open = false; groups.scrollTop = 127;
  collapse.click();
  await until(() => panel.classList.contains('is-collapsed') && content.hidden, 'side rail');
  assert.strictEqual(shadow.querySelector('aside'), panel);
  assert.equal(launcher.hidden, true, 'No large bottom launcher remains while the rail is open');
  assert.equal(expand.getAttribute('aria-expanded'), 'false');
  assert.equal(expand.getAttribute('aria-controls'), content.id);
  assert.strictEqual(shadow.activeElement, expand, 'Focus moves out of the hidden content');
  assert.equal(shadow.querySelector<HTMLElement>('.panel-rail')!.hidden, false);
  expand.click();
  await until(() => !panel.classList.contains('is-collapsed') && !content.hidden, 'expanded panel');
  assert.equal(collapse.getAttribute('aria-expanded'), 'true');
  assert.equal(search.value, 'client');
  assert.deepEqual(paths(shadow), ['src/client.ts', 'tests/client.test.ts']);
  assert.equal(implementation.open, false);
  assert.equal(groups.scrollTop, 127);
  assert.strictEqual(shadow.activeElement, search);
  assert.equal(draft.value, 'Keep my native draft'); assert.equal(viewed.checked, true);
  collapse.click();
  await until(() => panel.classList.contains('is-collapsed'), 'collapse again');
  shadow.querySelector<HTMLButtonElement>('.panel-rail button[aria-label="Close panel"]')!.click();
  await until(() => !shadow.querySelector('aside'), 'rail close');
  assert.equal(launcher.hidden, false);
  assert.strictEqual(shadow.activeElement, launcher);
  launcher.click();
  await until(() => shadow.querySelector('aside') && !shadow.querySelector('aside')!.classList.contains('is-collapsed'), 'reopen expanded panel');
  assert.equal(shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!.value, 'client');
  assert.deepEqual(current.errors, []);
});

test('isolates editable panel keyboard events from GitHub shortcuts without cancelling editing defaults', async t => {
  const observed: string[] = [];
  const beforeEval = (window: JSDOM['window']) => {
    assert.equal(window.document.readyState, 'loading');
    const body = window.document.body;
    body.remove();
    window.document.addEventListener('DOMContentLoaded', () => window.document.documentElement.append(body), { once: true });
    for (const type of ['keydown', 'keypress', 'keyup']) {
      window.document.addEventListener(type, () => observed.push(`document capture ${type}`), true);
      window.document.addEventListener(type, () => observed.push(`document bubble ${type}`));
      window.addEventListener(type, () => observed.push(`window bubble ${type}`));
    }
  };
  const current = page(undefined, {}, undefined, undefined, beforeEval);
  t.after(() => current.dom.window.close());
  const { window } = current;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    // document_start places the extension's window guard before GitHub's window handlers.
    window.addEventListener(type, () => observed.push(`window capture ${type}`), true);
  }
  const shadow = await openPanel(window);
  await until(() => links(shadow).length === initialPaths.length, 'keyboard fixture inventory after DOM load');
  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const dispatchKeys = (target: Element, key: string, modifiers: KeyboardEventInit = {}) => {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = new window.KeyboardEvent(type, { key, bubbles: true, composed: true, cancelable: true, ...modifiers });
      assert.equal(target.dispatchEvent(event), true, `${key} ${type} remains available to native editing`);
      assert.equal(event.defaultPrevented, false);
    }
  };
  for (const [key, modifiers] of [
    ['c', {}], ['C', { shiftKey: true }], ['g', {}], ['?', { shiftKey: true }],
    ['ArrowDown', {}], ['ArrowUp', {}], ['ArrowLeft', {}], ['ArrowRight', {}], ['Tab', {}],
    ['a', { metaKey: true }], ['v', { metaKey: true }], ['v', { ctrlKey: true }],
  ] as const) dispatchKeys(search, key, modifiers);
  const paste = new window.Event('paste', { bubbles: true, composed: true, cancelable: true });
  assert.equal(search.dispatchEvent(paste), true);
  assert.equal(paste.defaultPrevented, false);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'client');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => links(shadow).length === 2, 'search remains functional after guarded typing and paste');
  assert.deepEqual(paths(shadow), ['src/client.ts', 'tests/client.test.ts']);
  assert.deepEqual(observed, []);

  const category = shadow.querySelector<HTMLSelectElement>('select[aria-label="Category for src/client.ts"]')!;
  category.closest('details')!.open = true;
  await until(() => !category.disabled, 'select preferences loaded');
  category.focus();
  for (const key of ['t', 'ArrowDown', 'Tab']) dispatchKeys(category, key);
  assert.deepEqual(observed, []);
  search.focus();
  dispatchKeys(search, 'Escape', { keyCode: 229 });
  dispatchKeys(search, 'Escape', { isComposing: true });
  assert.ok(shadow.querySelector('aside'));
  assert.deepEqual(observed, []);

  const outside = window.document.querySelector('textarea')!;
  dispatchKeys(outside, 'c');
  assert.equal(observed.length, 12);
  observed.length = 0;
  dispatchKeys(links(shadow)[0], 'g');
  assert.equal(observed.length, 12);
  observed.length = 0;

  search.focus();
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
  await until(() => !shadow.querySelector('aside'), 'Escape closes the local panel');
  assert.strictEqual(shadow.activeElement, shadow.querySelector('button.launcher'));
  assert.equal(shadow.querySelector('button.launcher')?.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(observed, []);
  window.dispatchEvent(new window.Event('pagehide'));
  await until(() => !window.document.querySelector('#pr-reviewer-root'), 'guarded panel unmounted on page hide');
  dispatchKeys(outside, 'c');
  assert.equal(observed.length, 12);
  assert.deepEqual(current.errors, []);
});

test('organizes loaded files, persists corrections, and preserves native review state', async t => {
  const current = page();
  t.after(() => current.dom.window.close());
  const { window } = current;
  const native = window.document.querySelector('#native-files')!;
  const tables = [...native.querySelectorAll('table')];
  const draft = native.querySelector('textarea')!;
  const viewed = native.querySelector<HTMLInputElement>('input')!;
  draft.value = 'My unfinished review';
  viewed.checked = true;

  const shadow = await openPanel(window);
  await until(() => links(shadow).length === initialPaths.length, 'initial file list');
  assert.deepEqual(paths(shadow), [...initialPaths].sort());
  assert.equal(shadow.querySelectorAll('details.group').length, 4);
  for (const label of ['Documentation', 'Implementation', 'Tests', 'Migrations']) {
    assert.ok([...shadow.querySelectorAll('details.group > summary')].some(summary => summary.textContent?.includes(label)));
  }

  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setValue.call(search, 'CLIENT');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => links(shadow).length === 2, 'search results');
  assert.deepEqual(paths(shadow), ['src/client.ts', 'tests/client.test.ts']);
  setValue.call(search, '');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => links(shadow).length === 3, 'cleared search');

  const implementation = shadow.querySelector<HTMLDetailsElement>('details.group.implementation')!;
  implementation.open = false;
  assert.equal(implementation.open, false);
  implementation.open = true;
  const correction = shadow.querySelector<HTMLSelectElement>('select[aria-label="Category for src/client.ts"]')!;
  correction.closest('details')!.open = true;
  await until(() => !correction.disabled, 'loaded preferences');
  correction.value = 'documentation';
  correction.dispatchEvent(new window.Event('change', { bubbles: true }));
  await until(() => shadow.querySelector('details.group.documentation a[title="src/client.ts"]'), 'corrected category');

  native.insertAdjacentHTML('beforeend', filesHTML(['src/extra.ts']).replaceAll(anchor(0), anchor(3)));
  window.document.querySelector('#files_tab_counter')!.textContent = '4';
  window.document.querySelector('#files_tab_counter')!.setAttribute('title', '4');
  await until(() => links(shadow).length === 4, 'dynamically loaded file');
  assert.equal(links(shadow).filter(link => link.title === 'src/extra.ts').length, 1);
  assert.deepEqual([...native.querySelectorAll('table')].slice(0, 3), tables);
  assert.strictEqual(native.querySelector('textarea'), draft);
  assert.equal(draft.value, 'My unfinished review');
  assert.strictEqual(native.querySelector('input'), viewed);
  assert.equal(viewed.checked, true);

  const panel = shadow.querySelector('aside')!;
  const clientLink = links(shadow).find(link => link.title === 'src/client.ts')!;
  clientLink.click();
  await until(() => window.location.hash === `#${anchor(1)}`, 'native anchor navigation');
  await until(() => clientLink.closest('li')!.classList.contains('selected'), 'selected file stays visible');
  assert.strictEqual(shadow.querySelector('aside'), panel);
  assert.strictEqual(shadow.activeElement, clientLink);
  assert.equal(window.location.hash, `#${anchor(1)}`);
  assert.equal(draft.value, 'My unfinished review');
  assert.equal(viewed.checked, true);
  shadow.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')!.click();
  await until(() => !shadow.querySelector('aside'), 'explicit close still closes panel');

  const reload = page(undefined, current.stored);
  t.after(() => reload.dom.window.close());
  const reloadedShadow = await openPanel(reload.window);
  await until(() => reloadedShadow.querySelector('details.group.documentation a[title="src/client.ts"]'), 'saved correction on reload');

  const other = page('https://github.com/acme/other/pull/12/files', current.stored);
  t.after(() => other.dom.window.close());
  const otherShadow = await openPanel(other.window);
  await until(() => otherShadow.querySelector<HTMLSelectElement>('select[aria-label="Category for src/client.ts"]')?.disabled === false, 'other repository preferences');
  assert.ok(otherShadow.querySelector('details.group.implementation a[title="src/client.ts"]'));
  for (const result of [current, reload, other]) assert.equal(result.messages.some(message => message.type === 'ai-review'), false);
  assert.deepEqual(current.errors, []);
  assert.deepEqual(reload.errors, []);
  assert.deepEqual(other.errors, []);
});

test('groups SQL migrations, filters them, and persists a manual migration category', async t => {
  const sqlPaths = [
    'backend/src/db/migrations/0101_currency_history.sql',
    'backend/src/db/migrations/0101_currency_history.down.sql',
  ];
  const fixturePaths = ['README.md', 'src/schema.ts', ...sqlPaths];
  const html = `
    <a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter" title="4">4</span></a>
    <main id="native-files">${filesHTML(fixturePaths)}</main>`;
  const current = page(undefined, {}, html);
  t.after(() => current.dom.window.close());
  const shadow = await openPanel(current.window);
  await until(() => links(shadow).length === fixturePaths.length, 'SQL fixture inventory');
  const migrations = shadow.querySelector('details.group.migrations')!;
  assert.deepEqual(paths(migrations), [...sqlPaths].sort());
  assert.equal(migrations.querySelector('.group-count')?.textContent, '2');

  const filter = [...shadow.querySelectorAll<HTMLButtonElement>('.filters button')]
    .find(button => button.textContent === 'Migrations')!;
  filter.click();
  await until(() => links(shadow).length === sqlPaths.length, 'migration filter');
  assert.deepEqual(paths(shadow), [...sqlPaths].sort());
  assert.equal(shadow.querySelectorAll('details.group').length, 1);
  filter.click();
  await until(() => links(shadow).length === fixturePaths.length, 'all categories restored');

  const correction = shadow.querySelector<HTMLSelectElement>('select[aria-label="Category for src/schema.ts"]')!;
  correction.closest('details')!.open = true;
  await until(() => !correction.disabled, 'migration correction preferences');
  assert.equal(correction.querySelector('option[value="migrations"]')?.textContent, 'Migrations');
  correction.value = 'migrations';
  correction.dispatchEvent(new current.window.Event('change', { bubbles: true }));
  await until(() => shadow.querySelector('details.group.migrations a[title="src/schema.ts"]'), 'manual migration correction');

  const reload = page(undefined, current.stored, html);
  t.after(() => reload.dom.window.close());
  const reloaded = await openPanel(reload.window);
  await until(() => reloaded.querySelector('details.group.migrations a[title="src/schema.ts"]'), 'migration correction on reload');
  assert.deepEqual(paths(reloaded.querySelector('details.group.migrations')!), [...sqlPaths, 'src/schema.ts'].sort());
  assert.deepEqual(current.errors, []);
  assert.deepEqual(reload.errors, []);
});

test('subdivides implementation by area and backend module while retaining navigation and repository corrections', async t => {
  const implementationPaths = [
    'backend/src/api/v1/commission/sync.ts',
    'backend/src/api/v1/payment/crud.ts',
    'backend/src/db/schemas/sales-channels.ts',
    'frontend/src/components/page.tsx',
    'backend/scripts/proxy.cjs',
    'frontend/src/types/reservation.ts',
    'src/util.ts',
  ];
  const fixturePaths = [...implementationPaths, 'README.md', 'tests/client.test.ts', 'backend/src/db/migrations/0101_currency.sql'];
  const html = `
    <a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter" title="10">10</span></a>
    <main id="native-files">${filesHTML(fixturePaths)}</main>`;
  const current = page(undefined, {}, html);
  t.after(() => current.dom.window.close());
  const { window } = current;
  const shadow = await openPanel(window);
  await until(() => links(shadow).length === fixturePaths.length, 'implementation hierarchy inventory');
  const implementation = shadow.querySelector<HTMLDetailsElement>('details.group.implementation')!;
  const count = (details: Element) => details.firstElementChild?.querySelector('.group-count')?.textContent;
  const subgroup = (group: string) => implementation.querySelector<HTMLDetailsElement>(`details.implementation-subgroup[data-group="${group}"]`);
  assert.equal(count(implementation), '7');
  assert.deepEqual(paths(implementation), [...implementationPaths].sort());
  assert.equal(new Set(paths(shadow)).size, fixturePaths.length);
  for (const [group, expected] of [
    ['backend', implementationPaths.slice(0, 3)],
    ['frontend', [implementationPaths[3]]],
    ['scripts', [implementationPaths[4]]],
    ['types', [implementationPaths[5]]],
    ['other', [implementationPaths[6]]],
  ] as const) {
    assert.deepEqual(paths(subgroup(group)!), [...expected].sort());
    assert.equal(count(subgroup(group)!), String(expected.length));
  }
  assert.deepEqual(paths(shadow.querySelector('details.group.documentation')!), ['README.md']);
  assert.deepEqual(paths(shadow.querySelector('details.group.tests')!), ['tests/client.test.ts']);
  assert.deepEqual(paths(shadow.querySelector('details.group.migrations')!), ['backend/src/db/migrations/0101_currency.sql']);

  const commission = implementation.querySelector<HTMLDetailsElement>('details.implementation-module[data-module="api/v1/commission"]')!;
  const payment = implementation.querySelector<HTMLDetailsElement>('details.implementation-module[data-module="api/v1/payment"]')!;
  assert.ok(commission.firstElementChild?.textContent?.includes('API › v1 › Commission'));
  assert.deepEqual(paths(commission), [implementationPaths[0]]);
  assert.equal(count(commission), '1');
  commission.open = false;
  assert.equal(payment.open, true);
  assert.equal(subgroup('backend')!.open, true);
  commission.open = true;

  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  const setSearch = (value: string) => {
    setValue.call(search, value);
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const filter = [...shadow.querySelectorAll<HTMLButtonElement>('.filters button')]
    .find(button => button.textContent === 'Implementation')!;
  filter.click();
  setSearch('api/v1/commission');
  await until(() => links(shadow).length === 1, 'module path search');
  assert.equal(count(implementation), '1/7');
  assert.equal(count(subgroup('backend')!), '1/3');
  assert.equal(implementation.querySelectorAll('details.implementation-subgroup').length, 1);
  assert.equal(implementation.querySelectorAll('details.implementation-module').length, 1);
  const panel = shadow.querySelector('aside')!;
  const groups = shadow.querySelector<HTMLElement>('.groups')!;
  groups.scrollTop = 120;
  const fileLink = links(shadow)[0];
  fileLink.click();
  await until(() => window.location.hash === `#${anchor(0)}`, 'module native diff navigation');
  assert.strictEqual(shadow.querySelector('aside'), panel);
  assert.strictEqual(shadow.querySelector('.groups'), groups);
  assert.strictEqual(shadow.activeElement, fileLink);
  assert.equal(groups.scrollTop, 120);
  assert.equal(search.value, 'api/v1/commission');
  assert.equal(filter.getAttribute('aria-pressed'), 'true');

  setSearch('');
  filter.click();
  await until(() => links(shadow).length === fixturePaths.length, 'all files restored');
  const movedPath = implementationPaths[3];
  const correction = shadow.querySelector<HTMLSelectElement>(`select[aria-label="Subcategory for ${movedPath}"]`)!;
  correction.closest('details')!.open = true;
  await until(() => !correction.disabled, 'implementation correction preferences');
  assert.deepEqual([...correction.options].map(option => option.value), ['auto', 'backend', 'frontend', 'scripts', 'types', 'other']);
  correction.value = 'backend';
  correction.dispatchEvent(new window.Event('change', { bubbles: true }));
  await until(() => subgroup('backend')?.querySelector(`a[title="${movedPath}"]`), 'manual area correction');
  assert.equal(subgroup('frontend'), null);
  assert.equal(count(subgroup('backend')!), '4');
  assert.equal(count(implementation), '7');
  assert.equal(current.stored[`pr-reviewer:repo:acme/example:implementation:${movedPath}`], 'backend');
  assert.deepEqual(paths(shadow), [...fixturePaths].sort());

  const reload = page(undefined, current.stored, html);
  t.after(() => reload.dom.window.close());
  const reloaded = await openPanel(reload.window);
  await until(() => reloaded.querySelector(`details.implementation-subgroup[data-group="backend"] a[title="${movedPath}"]`), 'saved area correction on reload');
  const other = page('https://github.com/acme/other/pull/12/files', current.stored, html.replace('/acme/example/pull/12/files', '/acme/other/pull/12/files'));
  t.after(() => other.dom.window.close());
  const otherShadow = await openPanel(other.window);
  await until(() => otherShadow.querySelector<HTMLSelectElement>(`select[aria-label="Subcategory for ${movedPath}"]`)?.disabled === false, 'other repository area preferences');
  assert.ok(otherShadow.querySelector(`details.implementation-subgroup[data-group="frontend"] a[title="${movedPath}"]`));
  for (const result of [current, reload, other]) assert.deepEqual(result.errors, []);
});

test('tracks GitHub SPA navigation without duplicating hosts or retaining stale PR files', async t => {
  const current = page();
  t.after(() => current.dom.window.close());
  const { window } = current;
  await openPanel(window);
  const host = window.document.querySelector('#pr-reviewer-root')!;

  window.history.pushState({}, '', '/acme/example/pull/13/files');
  window.document.dispatchEvent(new window.Event('turbo:load', { bubbles: true }));
  await until(() => host.shadowRoot?.querySelector('.launcher-count')?.textContent === '0', 'stale DOM inventory cleared');
  const shadow = await openPanel(window);
  assert.ok(shadow.textContent?.includes('#13'));
  assert.deepEqual(paths(shadow), []);
  window.document.querySelector('#native-files')!.innerHTML = filesHTML(['docs/next.md']);
  window.document.querySelector<HTMLAnchorElement>('.tabnav-tab')!.href = '/acme/example/pull/13/files';
  window.document.querySelector('#files_tab_counter')!.textContent = '1';
  window.document.querySelector('#files_tab_counter')!.setAttribute('title', '1');
  window.document.dispatchEvent(new window.Event('turbo:load', { bubbles: true }));
  await until(() => links(shadow).length === 1 && paths(shadow)[0] === 'docs/next.md', 'new PR files');
  assert.equal(window.document.querySelectorAll('#pr-reviewer-root').length, 1);
  assert.strictEqual(window.document.querySelector('#pr-reviewer-root'), host);

  window.history.pushState({}, '', '/acme/example/issues');
  window.document.dispatchEvent(new window.Event('turbo:load', { bubbles: true }));
  await until(() => !window.document.querySelector('#pr-reviewer-root'), 'host removed outside PR');

  window.history.pushState({}, '', '/acme/example/pull/13/files');
  window.document.dispatchEvent(new window.Event('turbo:load', { bubbles: true }));
  const restored = await openPanel(window);
  await until(() => links(restored).length === 1, 'host restored on PR entry');
  assert.deepEqual(paths(restored), ['docs/next.md']);
  assert.equal(window.document.querySelectorAll('#pr-reviewer-root').length, 1);
  assert.deepEqual(current.errors, []);
});

test('organizes all 144 React tree files across virtual diff remounts and uses native tree navigation', async t => {
  const allPaths = Array.from({ length: 144 }, (_, index) => {
    const file = Math.floor(index / 3);
    return index % 3 === 0 ? `docs/module-${file}.md` :
      index % 3 === 1 ? `src/client-${file}.ts` : `tests/client-${file}.test.ts`;
  });
  const current = page('https://github.com/acme/example/pull/12/changes', {}, `
    <a id="prs-files-anchor-tab" href="/acme/example/pull/12/changes">Files changed<span data-component="CounterLabel" aria-hidden="true">144</span></a>
    <nav id="native-tree">${treeHTML(allPaths)}</nav>
    <main id="native-files">${regionHTML(allPaths[0], 0)}</main>
    <form id="native-review"><input type="checkbox" aria-label="Viewed" checked><textarea aria-label="Review comment"></textarea></form>`);
  t.after(() => current.dom.window.close());
  const { window } = current;
  const document = window.document;
  const native = document.querySelector('#native-files')!;
  const tree = document.querySelector('#native-tree')!;
  const treeContents = tree.innerHTML;
  const draft = document.querySelector<HTMLTextAreaElement>('#native-review textarea')!;
  const viewed = document.querySelector<HTMLInputElement>('#native-review input')!;
  draft.value = 'Keep my pending review';

  const shadow = await openPanel(window);
  await until(() => links(shadow).length === allPaths.length, 'full virtualized PR inventory');
  assert.equal(document.querySelectorAll('[role="region"][id^="diff-"]').length, 1);
  assert.deepEqual(paths(shadow), [...allPaths].sort());
  assert.equal(shadow.querySelector('.notice'), null);
  for (const category of ['documentation', 'implementation', 'tests']) {
    assert.equal(shadow.querySelector(`details.group.${category} .group-count`)?.textContent, '48');
  }

  native.innerHTML = regionHTML(allPaths[70], 70);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(paths(shadow), [...allPaths].sort());
  assert.equal(shadow.querySelector('.launcher-count')?.textContent, '144');

  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setValue.call(search, 'CLIENT');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const filter = [...shadow.querySelectorAll<HTMLButtonElement>('.filters button')]
    .find(button => button.textContent === 'Tests')!;
  filter.click();
  await until(() => links(shadow).length === 48, 'filtered test files');
  const panel = shadow.querySelector('aside')!;
  const groups = shadow.querySelector<HTMLElement>('.groups')!;
  groups.scrollTop = 320;
  const clickedIndexes: number[] = [];
  for (const targetIndex of [143, 140]) {
    const nativeLink = tree.querySelector<HTMLAnchorElement>(`a[href="#${anchor(targetIndex)}"]`)!;
    nativeLink.addEventListener('click', event => {
      event.preventDefault();
      clickedIndexes.push(targetIndex);
      native.innerHTML = regionHTML(allPaths[targetIndex], targetIndex);
      window.history.replaceState({}, '', `#${anchor(targetIndex)}`);
    });
    assert.equal(document.getElementById(anchor(targetIndex)), null);
    const panelLink = links(shadow).find(link => link.title === allPaths[targetIndex])!;
    panelLink.click();
    await until(() => panelLink.closest('li')!.classList.contains('selected'), 'native navigation marks selected file');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.strictEqual(shadow.querySelector('aside'), panel);
    assert.strictEqual(shadow.querySelector('.groups'), groups);
    assert.strictEqual(shadow.activeElement, panelLink);
    assert.strictEqual(shadow.querySelector('input[aria-label="Search files"]'), search);
    assert.equal(search.value, 'CLIENT');
    assert.equal(filter.getAttribute('aria-pressed'), 'true');
    assert.equal(groups.scrollTop, 320);
    assert.equal(links(shadow).length, 48);
    assert.equal(shadow.querySelectorAll('li.selected').length, 1);
    assert.ok(document.getElementById(anchor(targetIndex)));
    assert.equal(window.location.hash, `#${anchor(targetIndex)}`);
  }
  assert.deepEqual(clickedIndexes, [143, 140]);
  assert.strictEqual(document.querySelector('#native-review textarea'), draft);
  assert.strictEqual(document.querySelector('#native-review input'), viewed);
  assert.equal(draft.value, 'Keep my pending review');
  assert.equal(viewed.checked, true);
  assert.strictEqual(document.querySelector('#native-tree'), tree);
  assert.equal(tree.innerHTML, treeContents);

  assert.equal(shadow.querySelector('.launcher-count')?.textContent, '144');
  assert.deepEqual(paths(shadow), allPaths.filter(path => path.startsWith('tests/')).sort());

  window.history.pushState({}, '', '/acme/example/pull/13/changes');
  document.dispatchEvent(new window.Event('turbo:load', { bubbles: true }));
  await until(() => shadow.querySelector('.launcher-count')?.textContent === '0', 'old React tree rejected during SPA navigation');
  assert.deepEqual(paths(shadow), []);
  const nextPR = await openPanel(window);
  tree.innerHTML = treeHTML(['docs/next.md']);
  native.innerHTML = regionHTML('docs/next.md', 0);
  document.querySelector<HTMLAnchorElement>('#prs-files-anchor-tab')!.href = '/acme/example/pull/13/changes';
  document.querySelector('[data-component="CounterLabel"]')!.textContent = '1';
  document.dispatchEvent(new window.Event('turbo:load', { bubbles: true }));
  await until(() => links(nextPR).length === 1 && paths(nextPR)[0] === 'docs/next.md', 'new React PR inventory');
  assert.deepEqual(current.errors, []);
});

test('organizes embedded summaries before native folders open and navigates through only async ancestors', async t => {
  const targetPath = 'backend/src/api/v1/commission/sync.ts';
  const fixturePaths = [targetPath, 'frontend/src/pages/home.tsx', 'README.md'];
  const route = '/acme/example/pull/12/changes';
  const payload = { payload: { pullRequestsChangesRoute: {
    pullRequestUrl: 'https://github.com/acme/example/pull/12',
    diffSummaries: fixturePaths.map((path, index) => ({ path, pathDigest: anchor(index).slice(5), changeType: 'ADDED' })),
  } } };
  const current = page(`https://github.com${route}`, {}, `
    <a id="prs-files-anchor-tab" href="${route}">Files changed<span data-component="CounterLabel">3</span></a>
    <react-app app-name="repo" initial-path="${route}"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(payload)}</script></react-app>
    <ul role="tree" aria-label="File Tree">
      <li role="treeitem" id="backend" aria-expanded="false"><div class="PRIVATE_TreeView-item-toggle"></div></li>
      <li role="treeitem" id="frontend" aria-expanded="false"><div class="PRIVATE_TreeView-item-toggle"></div></li>
    </ul>
    <main id="native-files">${regionHTML('README.md', 2)}</main>`);
  t.after(() => current.dom.window.close());
  const { window } = current;
  const document = window.document;
  const tree = document.querySelector('[role="tree"]')!;
  const expanded: string[] = [];
  let fileClicks = 0;
  tree.addEventListener('click', event => {
    const target = event.target as Element;
    if (target.matches('a')) {
      event.preventDefault();
      fileClicks += 1;
      document.querySelector('#native-files')!.innerHTML = regionHTML(targetPath, 0);
      window.history.replaceState({}, '', `#${anchor(0)}`);
    } else if (target.matches('.PRIVATE_TreeView-item-toggle')) {
      const item = target.closest('[role="treeitem"]')!;
      expanded.push(item.id);
      window.setTimeout(() => {
        item.setAttribute('aria-expanded', 'true');
        const next = targetPath.split('/').slice(0, item.id.split('/').length + 1).join('/');
        item.insertAdjacentHTML('beforeend', `<ul role="group"><li role="treeitem" id="${next}" ${next === targetPath ? 'tabindex="-1"' : 'aria-expanded="false"'}>${next === targetPath ? `<a href="#${anchor(0)}">sync.ts</a>` : '<div class="PRIVATE_TreeView-item-toggle"></div>'}</li></ul>`);
      }, 0);
    }
  });

  const shadow = await openPanel(window);
  await until(() => links(shadow).length === fixturePaths.length, 'embedded inventory with collapsed native tree');
  assert.deepEqual(paths(shadow), [...fixturePaths].sort());
  const implementation = shadow.querySelector('details.group.implementation')!;
  const module = implementation.querySelector('details.implementation-subgroup[data-group="backend"] details.implementation-module[data-module="api/v1/commission"]')!;
  assert.ok(module.firstElementChild?.textContent?.includes('API › v1 › Commission'));
  assert.deepEqual(paths(module), [targetPath]);
  assert.equal(document.getElementById(targetPath), null);
  assert.equal(document.getElementById('backend')!.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(expanded, []);

  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'commission');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => links(shadow).length === 1, 'search before native ancestors load');
  const panel = shadow.querySelector('aside')!;
  const groups = shadow.querySelector<HTMLElement>('.groups')!;
  groups.scrollTop = 110;
  const link = links(shadow)[0];
  link.click();
  await until(() => link.closest('li')!.classList.contains('selected'), 'async native tree navigation completes');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(expanded, ['backend', 'backend/src', 'backend/src/api', 'backend/src/api/v1', 'backend/src/api/v1/commission']);
  assert.equal(fileClicks, 1);
  assert.equal(document.getElementById('frontend')!.getAttribute('aria-expanded'), 'false');
  assert.equal(window.location.hash, `#${anchor(0)}`);
  assert.strictEqual(shadow.querySelector('aside'), panel);
  assert.strictEqual(shadow.querySelector('.groups'), groups);
  assert.strictEqual(shadow.activeElement, link);
  assert.equal(groups.scrollTop, 110);
  assert.equal(search.value, 'commission');
  assert.equal(shadow.querySelector('.launcher-count')?.textContent, '3');
  assert.equal(implementation.firstElementChild?.querySelector('.group-count')?.textContent, '1/2');
  assert.deepEqual(paths(shadow), [targetPath]);
  assert.deepEqual(current.errors, []);
});

test('groups frontend modules and orders changed lines before unknown sizes, including live statistics updates', async t => {
  const fixturePaths = [
    'frontend/src/modules/reservations/unknown.tsx',
    'frontend/src/modules/reservations/b-small.tsx',
    'frontend/src/modules/reservations/zero.tsx',
    'frontend/src/modules/reservations/z-large.tsx',
    'frontend/src/modules/reservations/a-small.tsx',
    'frontend/src/modules/settings/page.tsx',
    'frontend/src/App.tsx',
    'frontend/src/components/Widget.tsx',
    'docs/a-small.md',
    'docs/z-large.md',
  ];
  const statistics = [undefined, [2, 3], [0, 0], [40, 60], [5, 0], [100, 1], [200, 50], [250, 1], [1, 0], [250, 250]];
  const summaries = fixturePaths.map((path, index) => ({
    path, pathDigest: anchor(index).slice(5), changeType: 'MODIFIED',
    ...(statistics[index] ? { linesAdded: statistics[index]![0], linesDeleted: statistics[index]![1] } : {}),
  }));
  const route = '/acme/example/pull/12/changes';
  const payload = { payload: { pullRequestsChangesRoute: {
    pullRequestUrl: 'https://github.com/acme/example/pull/12', diffSummaries: summaries,
  } } };
  const current = page(`https://github.com${route}`, {}, `
    <a id="prs-files-anchor-tab" href="${route}">Files changed<span data-component="CounterLabel">10</span></a>
    <react-app app-name="repo" initial-path="${route}"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(payload)}</script></react-app>
    <nav id="native-tree">${treeHTML(fixturePaths)}</nav>
    <main id="native-files">${regionHTML('docs/z-large.md', 9)}</main>`);
  t.after(() => current.dom.window.close());
  const { window } = current;
  const shadow = await openPanel(window);
  await until(() => links(shadow).length === fixturePaths.length, 'frontend modules inventory');
  const orderedPaths = (root: ParentNode) => links(root).map(link => link.title);
  const count = (details: Element) => details.firstElementChild?.querySelector('.group-count')?.textContent;
  const implementation = shadow.querySelector('details.group.implementation')!;
  const frontend = implementation.querySelector('details.implementation-subgroup[data-group="frontend"]')!;
  const reservations = frontend.querySelector('details.implementation-module[data-module="reservations"]')!;
  const initialOrder = [3, 4, 1, 2, 0].map(index => fixturePaths[index]);
  assert.deepEqual(orderedPaths(reservations), initialOrder);
  assert.deepEqual([...frontend.querySelectorAll('details.implementation-module')].map(module => module.getAttribute('data-module')), ['', 'components', 'reservations', 'settings']);
  assert.deepEqual(paths(frontend), fixturePaths.slice(0, 8).sort());
  assert.equal(count(implementation), '8');
  assert.equal(count(frontend), '8');
  assert.equal(count(reservations), '5');
  assert.deepEqual(orderedPaths(shadow.querySelector('details.group.documentation')!), [fixturePaths[9], fixturePaths[8]]);
  assert.equal(new Set(paths(shadow)).size, fixturePaths.length);
  assert.ok(shadow.querySelector('.sort-hint')?.textContent?.includes('Largest changes first'));
  assert.equal(shadow.querySelector('.heat-legend')?.getAttribute('aria-label'), 'Change volume temperature');
  for (const [index, heat] of [[0, null], [2, null], [8, 'cool'], [3, 'cool'], [5, 'mild'], [6, 'mild'], [7, 'warm'], [9, 'warm']] as const) {
    const link = links(shadow).find(file => file.title === fixturePaths[index])!;
    assert.equal(link.closest('li')!.getAttribute('data-heat'), heat, `heat boundary: ${statistics[index]?.reduce((sum, lines) => sum + lines, 0) ?? 'unknown'}`);
    assert.equal(link.getAttribute('title'), fixturePaths[index]);
    const total = link.querySelector('.change-total');
    if (heat) {
      const [added, deleted] = statistics[index]!;
      assert.equal(link.querySelector('.file-changes')?.getAttribute('aria-label'), `${added} lines added and ${deleted} deleted, ${added + deleted} changes`);
      assert.ok(total?.getAttribute('title'));
    } else assert.equal(total?.getAttribute('title') ?? null, null);
  }
  const large = links(reservations).find(link => link.title === fixturePaths[3])!;
  const changes = large.querySelector('.file-changes')!;
  assert.ok(changes.textContent?.includes('+40'));
  assert.ok(changes.textContent?.includes('−60'));
  assert.ok(changes.getAttribute('aria-label'));

  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'reservations');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const filter = [...shadow.querySelectorAll<HTMLButtonElement>('.filters button')].find(button => button.textContent === 'Implementation')!;
  filter.click();
  await until(() => links(shadow).length === 5, 'ordered filtered frontend module');
  assert.deepEqual(orderedPaths(reservations), initialOrder);
  assert.equal(frontend.querySelectorAll('details.implementation-module').length, 1);
  assert.equal(count(implementation), '5/8');
  assert.equal(count(frontend), '5/8');
  assert.equal(count(reservations), '5/5');
  let nativeClicks = 0;
  window.document.querySelector<HTMLAnchorElement>(`#native-tree a[href="#${anchor(3)}"]`)!.addEventListener('click', event => {
    event.preventDefault();
    nativeClicks += 1;
    window.document.querySelector('#native-files')!.innerHTML = regionHTML(fixturePaths[3], 3);
    window.history.replaceState({}, '', `#${anchor(3)}`);
  });
  const panel = shadow.querySelector('aside')!;
  const groups = shadow.querySelector<HTMLElement>('.groups')!;
  groups.scrollTop = 140;
  large.click();
  await until(() => large.closest('li')!.classList.contains('selected'), 'sorted file native navigation');
  assert.equal(nativeClicks, 1);
  assert.equal(window.location.hash, `#${anchor(3)}`);
  assert.strictEqual(shadow.querySelector('aside'), panel);
  assert.strictEqual(shadow.activeElement, large);
  assert.equal(groups.scrollTop, 140);
  assert.equal(search.value, 'reservations');
  assert.equal(filter.getAttribute('aria-pressed'), 'true');

  summaries[2].linesAdded = 200;
  summaries[2].linesDeleted = 60;
  window.document.querySelector('script[data-target="react-app.embeddedData"]')!.textContent = JSON.stringify(payload);
  await until(() => links(reservations)[0]?.title === fixturePaths[2], 'updated statistics reorder unchanged inventory');
  const updated = links(reservations)[0];
  assert.equal(updated.closest('li')!.getAttribute('data-heat'), 'warm');
  assert.equal(updated.querySelector('.change-total')?.getAttribute('title'), 'High: 251–500 changes');
  assert.equal(updated.querySelector('.file-changes')?.getAttribute('aria-label'), '200 lines added and 60 deleted, 260 changes');
  assert.deepEqual(orderedPaths(reservations), [2, 3, 4, 1, 0].map(index => fixturePaths[index]));
  summaries[2].linesAdded = 441;
  window.document.querySelector('script[data-target="react-app.embeddedData"]')!.textContent = JSON.stringify(payload);
  await until(() => updated.closest('li')!.getAttribute('data-heat') === 'hot', 'live heat rises beyond 500 changed lines');
  assert.equal(updated.querySelector('.change-total')?.getAttribute('title'), 'Very high: more than 500 changes');
  assert.equal(updated.querySelector('.file-changes')?.getAttribute('aria-label'), '441 lines added and 60 deleted, 501 changes');
  assert.deepEqual(orderedPaths(reservations), [2, 3, 4, 1, 0].map(index => fixturePaths[index]));
  assert.equal(shadow.querySelector('.launcher-count')?.textContent, '10');
  assert.equal(count(implementation), '5/8');
  assert.equal(count(reservations), '5/5');
  assert.equal(new Set(paths(shadow)).size, 5);
  assert.strictEqual(shadow.querySelector('aside'), panel);
  assert.equal(search.value, 'reservations');
  assert.deepEqual(current.errors, []);
});

test('groups monorepo packages across implementation areas while preserving legacy modules and main categories', async t => {
  const fixturePaths = [
    'packages/mira-api/src/booking/service.ts', 'packages/mira-api/package.json',
    'packages/mira-widgets/src/nested/BookingCard.tsx', 'packages/mira-widgets/src/other/util.ts', 'packages/mira-widgets/package.json',
    'packages/mira-editor/src/model.ts', 'packages/mira-editor/package.json',
    'packages/mira-widgets/scripts/build.ts', 'packages/mira-widgets/src/types/booking.ts', 'packages/mira-utils/src/helpers.ts',
    'backend/src/api/v1/commission/sync.ts', 'frontend/src/pages/reservations/page.tsx',
    'scripts/release.sh', 'src/types/local.ts', 'src/utils.ts',
    'packages/mira-widgets/README.md', 'packages/mira-widgets/src/nested/Card.test.tsx', 'packages/mira-api/db/migrations/001.sql',
  ];
  const route = '/acme/example/pull/12/changes';
  const payload = { payload: { pullRequestsChangesRoute: {
    pullRequestUrl: 'https://github.com/acme/example/pull/12',
    diffSummaries: fixturePaths.map((path, index) => ({
      path, pathDigest: anchor(index).slice(5), changeType: 'MODIFIED',
      linesAdded: index === 2 ? 5 : index === 3 ? 100 : index === 4 ? 20 : index + 1, linesDeleted: 0,
    })),
  } } };
  const current = page(`https://github.com${route}`, {}, `
    <a id="prs-files-anchor-tab" href="${route}">Files changed<span data-component="CounterLabel">18</span></a>
    <react-app app-name="repo" initial-path="${route}"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(payload)}</script></react-app>`);
  t.after(() => current.dom.window.close());
  const { window } = current;
  const shadow = await openPanel(window);
  await until(() => links(shadow).length === fixturePaths.length, 'mixed monorepo inventory');
  const implementation = shadow.querySelector('details.group.implementation')!;
  const count = (details: Element) => details.firstElementChild?.querySelector('.group-count')?.textContent;
  const subgroup = (name: string) => implementation.querySelector(`details.implementation-subgroup[data-group="${name}"]`)!;
  const module = (group: string, name: string) => subgroup(group).querySelector(`details.implementation-module[data-module="${name}"]`)!;
  for (const [group, name, indices] of [
    ['backend', 'mira-api', [0, 1]], ['frontend', 'mira-widgets', [2, 3, 4]], ['frontend', 'mira-editor', [5, 6]],
    ['scripts', 'mira-widgets', [7]], ['types', 'mira-widgets', [8]], ['other', 'mira-utils', [9]],
  ] as const) {
    const packageModule = module(group, `packages/${name}`);
    assert.deepEqual(paths(packageModule), indices.map(index => fixturePaths[index]).sort());
    assert.equal(packageModule.firstElementChild?.firstElementChild?.childNodes[0].textContent, name);
    assert.equal(count(packageModule), String(indices.length));
  }
  assert.deepEqual(links(module('frontend', 'packages/mira-widgets')).map(link => link.title), [3, 4, 2].map(index => fixturePaths[index]));
  assert.deepEqual(paths(module('backend', 'api/v1/commission')), [fixturePaths[10]]);
  assert.deepEqual(paths(module('frontend', 'reservations')), [fixturePaths[11]]);
  for (const [group, index] of [['scripts', 12], ['types', 13], ['other', 14]] as const) {
    const legacyLink = links(subgroup(group)).find(link => link.title === fixturePaths[index])!;
    assert.ok(legacyLink);
    assert.strictEqual(legacyLink.closest('details.implementation-module'), module(group, ''));
    assert.deepEqual(paths(module(group, '')), [fixturePaths[index]]);
    assert.equal(module(group, '').firstElementChild?.firstElementChild?.childNodes[0].textContent, 'General');
  }
  assert.equal(count(implementation), '15');
  assert.equal(new Set(paths(shadow)).size, fixturePaths.length);
  for (const [category, index] of [['documentation', 15], ['tests', 16], ['migrations', 17]] as const) {
    assert.deepEqual(paths(shadow.querySelector(`details.group.${category}`)!), [fixturePaths[index]]);
  }

  const search = shadow.querySelector<HTMLInputElement>('input[aria-label="Search files"]')!;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'packages/mira-widgets/');
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await until(() => links(shadow).length === 7, 'exact package search across main categories');
  assert.equal(count(implementation), '5/15');
  assert.equal(count(subgroup('frontend')), '3/6');
  assert.deepEqual(links(module('frontend', 'packages/mira-widgets')).map(link => link.title), [3, 4, 2].map(index => fixturePaths[index]));

  const movedPath = fixturePaths[3];
  const correction = shadow.querySelector<HTMLSelectElement>(`select[aria-label="Subcategory for ${movedPath}"]`)!;
  correction.closest('details')!.open = true;
  await until(() => !correction.disabled, 'package correction preferences');
  correction.value = 'backend';
  correction.dispatchEvent(new window.Event('change', { bubbles: true }));
  await until(() => subgroup('backend')?.querySelector(`details.implementation-module[data-module="packages/mira-widgets"] a[title="${movedPath}"]`), 'manual area preserves package module');
  assert.equal(module('backend', 'packages/mira-widgets').firstElementChild?.firstElementChild?.childNodes[0].textContent, 'mira-widgets');
  assert.deepEqual(paths(module('backend', 'packages/mira-widgets')), [movedPath]);
  assert.deepEqual(paths(module('frontend', 'packages/mira-widgets')), [fixturePaths[2], fixturePaths[4]].sort());
  assert.equal(count(implementation), '5/15');
  assert.equal(links(shadow).length, 7);
  assert.equal(new Set(paths(shadow)).size, 7);
  assert.equal(current.stored[`pr-reviewer:repo:acme/example:implementation:${movedPath}`], 'backend');
  assert.deepEqual(current.errors, []);
});

test('rejects legacy worker language and review schemas until a compatible Spanish review arrives', async t => {
  const path = 'src/language.ts';
  const warning = 'Reload PR Reviewer in chrome://extensions, then reload this GitHub tab to apply AI response language settings.';
  const referenceWarning = 'Reload PR Reviewer in chrome://extensions, then reload this GitHub tab to apply AI line references.';
  let language: unknown;
  let structured = false;
  const html = `
    <a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter">1</span></a>
    <div class="js-file" data-tagsearch-path="${path}" id="${anchor(0)}">
      <div class="file-header" data-path="${path}" data-anchor="${anchor(0)}"><a href="#${anchor(0)}" title="${path}">${path}</a></div>
      <table><tbody><tr><td class="blob-num" data-line-number="1">1</td><td class="blob-code blob-code-addition"><span class="blob-code-inner" data-code-marker="+">export const greeting = 'Hola';</span></td></tr></tbody></table>
    </div>`;
  const current = page(undefined, {}, html, message => {
    if (message.type === 'ai-status') return {
      ok: true,
      status: { configured: true, enabled: true, model: 'legacy-fixture-model', ...(language === undefined ? {} : { language }) },
    } as unknown as ExtensionResponse;
    if (message.type === 'ai-review') {
      if (!structured) return { ok: true, review: { summary: 'Old string-array review', highlights: ['Old highlight'], focus: ['Old focus'] } } as unknown as ExtensionResponse;
      return { ok: true, review: { summary: 'Resumen en español', highlights: [reviewComment('Añade un saludo')], focus: [reviewComment('Revisar el saludo')] } };
    }
  });
  t.after(() => current.dom.window.close());
  current.window.document.querySelector<HTMLAnchorElement>('.file-header a')!.addEventListener('click', event => {
    event.preventDefault();
    current.window.history.replaceState({}, '', `#${anchor(0)}`);
  });
  const shadow = await openPanel(current.window);
  await until(() => links(shadow).length === 1, 'legacy worker file');
  links(shadow)[0].click();
  await until(() => shadow.querySelector<HTMLElement>('.ai-review')?.hidden === false && shadow.querySelector('.ai-error')?.textContent === warning, 'visible worker compatibility warning');
  assert.equal(current.messages.some(message => message.type === 'ai-review'), false);
  assert.equal(shadow.querySelector('.ai-result'), null);
  shadow.querySelector<HTMLButtonElement>('button.ai-settings-button')!.click();
  await until(() => current.messages.some(message => message.type === 'ai-open-settings'), 'settings remain available');

  const previousStatuses = current.messages.filter(message => message.type === 'ai-status').length;
  language = 'fr';
  current.notifyAI();
  await until(() => current.messages.filter(message => message.type === 'ai-status').length > previousStatuses, 'invalid worker language checked');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(shadow.querySelector('.ai-error')?.textContent, warning);
  assert.equal(current.messages.some(message => message.type === 'ai-review'), false);

  language = 'es';
  current.notifyAI();
  await until(() => shadow.querySelector('.ai-error')?.textContent === referenceWarning, 'valid language with legacy review schema rejected');
  assert.equal(current.messages.filter(message => message.type === 'ai-review').length, 1);
  assert.equal(shadow.querySelector('.ai-result'), null);
  structured = true;
  shadow.querySelector<HTMLButtonElement>('button.ai-retry')!.click();
  await until(() => shadow.querySelector('.ai-summary')?.textContent === 'Resumen en español', 'compatible Spanish worker resumes review');
  assert.equal(current.messages.filter(message => message.type === 'ai-review').length, 2);
  assert.equal(shadow.querySelector('.ai-error'), null);
  assert.ok(shadow.querySelector('.ai-scope')?.textContent?.includes('Español'));
  assert.equal(shadow.querySelector('.ai-result')?.getAttribute('lang'), 'es');
  assert.deepEqual(current.errors, []);
});

test('reviews only the selected diff through the background bridge and ignores a late previous review', async t => {
  const fixturePaths = ['src/alpha.ts', 'src/beta.ts'];
  const secret = 'TEST_KEY_NOT_FOR_PAGE';
  let responseLanguage: AILanguage = 'en';
  let responseProvider: AIProvider = 'openai';
  const scrolled: Element[] = [];
  const pending = new Map<string, { requestId: string; resolve: (response: ExtensionResponse) => void }>();
  const html = `
    <a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter">2</span></a>
    <main id="native-files">${fixturePaths.map((path, index) => `
      <div class="js-file" data-tagsearch-path="${path}" id="${anchor(index)}">
        <div class="file-header" data-path="${path}" data-anchor="${anchor(index)}"><a href="#${anchor(index)}" title="${path}">${path}</a></div>
        <table><tbody><tr><td class="blob-num" data-line-number="1" id="${anchor(index)}L1">1</td><td class="blob-code blob-code-deletion"><span class="blob-code-inner" data-code-marker="-">export const ${index ? 'beta' : 'alpha'} = 0;</span></td></tr><tr><td class="blob-num" data-line-number="1" id="${anchor(index)}R1">1</td><td class="blob-code blob-code-addition"><span class="blob-code-inner" data-code-marker="+">export const ${index ? 'beta' : 'alpha'} = ${index + 1};</span></td></tr><tr><td class="blob-num" data-line-number="2" id="${anchor(index)}R2">2</td><td class="blob-code blob-code-addition"><span class="blob-code-inner" data-code-marker="+">export const ${index ? 'beta' : 'alpha'}Enabled = true;</span></td></tr></tbody></table>
      </div>`).join('')}</main>
    <textarea aria-label="Review comment">PRIVATE_REVIEW_DRAFT</textarea><input type="checkbox" aria-label="Viewed" checked>`;
  const current = page(undefined, { 'private-ai-settings': { apiKey: secret } }, html, message => {
    if (message.type === 'ai-status') return { ok: true, status: { configured: true, enabled: true, model: 'fixture-model', language: responseLanguage, provider: responseProvider } };
    if (message.type === 'ai-review') return new Promise(resolve => pending.set(message.context.path, { requestId: message.requestId, resolve }));
  }, window => {
    window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  });
  t.after(() => current.dom.window.close());
  const native = current.window.document.querySelector('#native-files')!;
  const nativeHTML = native.innerHTML;
  const draft = current.window.document.querySelector('textarea')!;
  const viewed = current.window.document.querySelector<HTMLInputElement>('input[aria-label="Viewed"]')!;
  // jsdom defers an anchor's default navigation; GitHub's native navigation
  // updates the route when clicked, so an old navigation cannot reselect a file.
  for (const link of current.window.document.querySelectorAll<HTMLAnchorElement>('.file-header a')) {
    link.addEventListener('click', event => {
      event.preventDefault();
      current.window.history.replaceState({}, '', link.getAttribute('href')!);
    });
  }
  const shadow = await openPanel(current.window);
  await until(() => links(shadow).length === 2, 'AI fixture files');
  // jsdom's selector engine reenters :focus-within and clears its cache when
  // focusing a shadow input after delayed navigation; visual focus styling is browser-tested.
  const style = shadow.querySelector('style')!;
  style.textContent = style.textContent!.replaceAll(':focus-within', ':focus');
  const panel = shadow.querySelector('aside')!;
  links(shadow).find(link => link.title === fixturePaths[0])!.click();
  const alpha = await until(() => pending.get(fixturePaths[0]), 'first file review request');
  const alphaRequest = current.messages.find(message => message.type === 'ai-review' && message.context.path === fixturePaths[0]);
  assert.ok(alphaRequest?.type === 'ai-review');
  assert.ok(alphaRequest.context.diff.includes('export const alpha = 1;'));
  assert.ok(alphaRequest.context.diff.includes('[old line 1] -export const alpha = 0;'));
  assert.ok(alphaRequest.context.diff.includes('[new line 1] +export const alpha = 1;'));
  assert.equal(alphaRequest.context.diff.includes('export const beta'), false);
  assert.equal(shadow.querySelector<HTMLElement>('.ai-review')?.hidden, false);
  await until(() => shadow.querySelector('.ai-loading')?.textContent?.includes('Generating review'), 'generating state');
  const filesView = [...shadow.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Files')!;
  filesView.click();
  links(shadow).find(link => link.title === fixturePaths[1])!.click();
  const beta = await until(() => pending.get(fixturePaths[1]), 'second file review request');
  assert.ok(current.messages.some(message => message.type === 'ai-cancel' && message.requestId === alpha.requestId));
  beta.resolve({ ok: true, review: {
    summary: 'Current beta summary',
    highlights: [{ text: 'Beta highlight', lines: [{ side: 'right', line: 2 }] }, { text: 'Beta old value changed', lines: [{ side: 'left', line: 1 }, { side: 'right', line: 1 }] }],
    focus: [reviewComment('Check beta callers', 'left'), { text: 'Check default behavior', lines: [] }],
  } });
  await until(() => shadow.querySelector('.ai-summary')?.textContent === 'Current beta summary', 'current file review result');
  alpha.resolve({ ok: true, review: { summary: 'Stale alpha summary', highlights: [reviewComment('Stale alpha highlight')], focus: [reviewComment('Stale alpha focus')] } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(shadow.querySelector('.ai-summary')?.textContent, 'Current beta summary');
  assert.equal(shadow.querySelector('.ai-result')?.getAttribute('lang'), 'en');
  assert.ok(shadow.querySelector('.ai-scope')?.textContent?.includes('English'));
  assert.equal(shadow.querySelector('.ai-file')?.getAttribute('title'), fixturePaths[1]);
  assert.ok(shadow.querySelector('.ai-result')?.textContent?.includes('Beta highlight'));
  assert.ok(shadow.querySelector('.ai-result')?.textContent?.includes('Check beta callers'));
  assert.ok(shadow.querySelector('.ai-summary-card .ai-summary'));
  const highlights = [...shadow.querySelectorAll('.ai-highlights li.ai-comment')];
  const focus = [...shadow.querySelectorAll('.ai-focus li.ai-comment')];
  assert.equal(highlights.length, 2);
  assert.equal(focus.length, 2);
  for (const [point, text, references] of [
    [highlights[0], 'Beta highlight', [['right', 'New L2']]],
    [highlights[1], 'Beta old value changed', [['left', 'Old L1'], ['right', 'New L1']]],
    [focus[0], 'Check beta callers', [['left', 'Old L1']]],
    [focus[1], 'Check default behavior', []],
  ] as const) {
    assert.equal(point.querySelector('.ai-comment-text')?.textContent, text);
    const row = point.querySelector('.ai-line-references')!;
    assert.ok(row);
    const chips = [...row.querySelectorAll<HTMLAnchorElement>('a.ai-line-chip')];
    assert.deepEqual(chips.map(chip => [chip.dataset.side, chip.textContent]), references);
    for (const chip of chips) {
      assert.strictEqual(chip.parentElement, row);
      const line = chip.textContent!.slice(-1);
      const accessible = `${chip.dataset.side === 'left' ? 'Original' : 'New'} line ${line}`;
      assert.equal(chip.getAttribute('title'), accessible);
      assert.equal(chip.getAttribute('aria-label'), accessible);
      assert.equal(chip.getAttribute('href'), `#${anchor(1)}${chip.dataset.side === 'left' ? 'L' : 'R'}${line}`);
    }
    const cardLink = point.querySelector<HTMLAnchorElement>('a.ai-comment-link');
    if (references.length) assert.equal(cardLink?.getAttribute('href'), chips[0].getAttribute('href'), 'The whole-card link targets its first reference');
    else {
      assert.equal(row.querySelector('.ai-line-unavailable')?.textContent, 'Line reference unavailable');
      assert.equal(cardLink, null);
      assert.equal(point.querySelector('.ai-comment-text')?.tagName, 'P');
    }
  }

  const aiView = shadow.querySelector<HTMLElement>('.ai-review')!;
  aiView.scrollTop = 123;
  const requestsBeforeNavigation = current.messages.filter(message => message.type === 'ai-review').length;
  const verifyNavigation = async (link: HTMLAnchorElement, side: 'L' | 'R', line: number) => {
    const beforeScroll = scrolled.length;
    const summaryBeforeNavigation = shadow.querySelector('.ai-summary')?.textContent;
    link.click();
    await until(() => current.window.location.hash === `#${anchor(1)}${side}${line}` && scrolled.length > beforeScroll, `AI reference navigation to ${side}${line}`);
    const row = current.window.document.getElementById(`${anchor(1)}${side}${line}`)!.closest('tr')!;
    assert.ok(scrolled.slice(beforeScroll).some(target => target === row || row.contains(target)), 'The referenced native code row is scrolled into view');
    assert.strictEqual(shadow.querySelector('aside'), panel);
    assert.equal(aiView.hidden, false);
    assert.equal(aiView.scrollTop, 123);
    assert.equal(shadow.querySelector('.ai-summary')?.textContent, summaryBeforeNavigation);
    assert.equal(draft.value, 'PRIVATE_REVIEW_DRAFT');
    assert.equal(viewed.checked, true);
  };
  await verifyNavigation(highlights[0].querySelector<HTMLAnchorElement>('a.ai-comment-link')!, 'R', 2);
  await verifyNavigation(highlights[1].querySelector<HTMLAnchorElement>('a.ai-comment-link')!, 'L', 1);
  for (const chip of highlights[1].querySelectorAll<HTMLAnchorElement>('a.ai-line-chip')) {
    await verifyNavigation(chip, chip.dataset.side === 'left' ? 'L' : 'R', 1);
  }
  const nativeModifiedClick = new current.window.MouseEvent('click', { bubbles: true, composed: true, cancelable: true, metaKey: true });
  let modifiedDefaultPrevented: boolean | undefined;
  current.window.document.addEventListener('click', event => {
    modifiedDefaultPrevented = event.defaultPrevented;
    // jsdom lacks modifier/new-tab routing; inspect the app before suppressing its default.
    event.preventDefault();
  }, { once: true });
  highlights[1].querySelector<HTMLAnchorElement>('a.ai-line-chip[data-side="right"]')!.dispatchEvent(nativeModifiedClick);
  assert.equal(modifiedDefaultPrevented, false, 'Modified clicks retain native anchor behavior');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(current.messages.filter(message => message.type === 'ai-review').length, requestsBeforeNavigation, 'Line hashes and card/chip clicks do not regenerate the AI review');

  const missingRow = current.window.document.getElementById(`${anchor(1)}R2`)!.closest('tr')!;
  const tbody = missingRow.parentElement!;
  missingRow.remove();
  highlights[0].querySelector<HTMLAnchorElement>('a.ai-comment-link')!.click();
  const navigationStatus = await until(() => {
    const status = shadow.querySelector('.ai-navigation-status');
    return status?.textContent === 'This line is not loaded. Load or expand its diff in GitHub, then try again.' ? status : null;
  }, 'missing referenced line notice', 7_000);
  assert.equal(navigationStatus.getAttribute('role'), 'status');
  assert.equal(navigationStatus.getAttribute('lang'), 'en');
  assert.equal(shadow.querySelector('.ai-summary')?.textContent, 'Current beta summary');
  assert.equal(current.messages.filter(message => message.type === 'ai-review').length, requestsBeforeNavigation);
  assert.equal(draft.value, 'PRIVATE_REVIEW_DRAFT');
  assert.equal(viewed.checked, true);
  tbody.append(missingRow);
  await verifyNavigation(highlights[0].querySelector<HTMLAnchorElement>('a.ai-line-chip')!, 'R', 2);
  await until(() => !shadow.querySelector('.ai-navigation-status'), 'successful retry clears line navigation notice');

  missingRow.remove();
  highlights[0].querySelector<HTMLAnchorElement>('a.ai-comment-link')!.click();
  await until(() => shadow.querySelector('.ai-navigation-status')?.textContent === 'Finding referenced line…', 'pending navigation starts');
  filesView.click();
  await until(() => aiView.hidden && !shadow.querySelector('.ai-navigation-status'), 'Files view cancels pending line navigation');
  const hashAfterCancel = current.window.location.hash;
  tbody.append(missingRow);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(current.window.location.hash, hashAfterCancel, 'A line loaded after cancellation does not trigger a delayed jump');
  assert.equal(current.messages.filter(message => message.type === 'ai-review').length, requestsBeforeNavigation);
  const aiViewButton = [...shadow.querySelectorAll<HTMLButtonElement>('.panel-views button')].find(button => button.textContent === 'AI review')!;
  aiViewButton.click();
  await until(() => !aiView.hidden, 'AI view remains available after canceled navigation');
  assert.equal(shadow.querySelector('.ai-result')?.textContent?.includes('Stale alpha'), false);
  assert.strictEqual(shadow.querySelector('aside'), panel);
  assert.equal(current.window.document.querySelector('textarea')!.value, 'PRIVATE_REVIEW_DRAFT');
  assert.equal(current.window.document.querySelector<HTMLInputElement>('input[aria-label="Viewed"]')!.checked, true);
  assert.equal(JSON.stringify(current.messages).includes(secret), false);
  assert.equal(JSON.stringify(current.messages).includes('PRIVATE_REVIEW_DRAFT'), false);
  assert.equal(shadow.textContent?.includes(secret), false);
  assert.strictEqual(current.window.document.querySelector('#native-files'), native);
  assert.equal(native.innerHTML, nativeHTML);
  assert.strictEqual(current.window.document.querySelector('textarea'), draft);
  assert.strictEqual(current.window.document.querySelector('input[aria-label="Viewed"]'), viewed);

  filesView.click();
  current.window.dispatchEvent(new current.window.Event('focus'));
  current.window.document.dispatchEvent(new current.window.Event('visibilitychange'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(filesView.getAttribute('aria-pressed'), 'true');
  assert.equal(shadow.querySelector<HTMLElement>('.ai-review')?.hidden, true);
  assert.equal(current.messages.filter(message => message.type === 'ai-review' && message.context.path === fixturePaths[1]).length, 1);
  links(shadow).find(link => link.title === fixturePaths[1])!.click();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(current.messages.filter(message => message.type === 'ai-review' && message.context.path === fixturePaths[1]).length, 1);
  shadow.querySelector<HTMLButtonElement>('button.ai-retry')!.click();
  const refreshingEnglish = await until(() => {
    const request = pending.get(fixturePaths[1]);
    return request?.requestId !== beta.requestId ? request : null;
  }, 'English review refresh request');
  responseLanguage = 'es';
  current.notifyAI();
  const spanish = await until(() => {
    const request = pending.get(fixturePaths[1]);
    return request?.requestId !== refreshingEnglish.requestId ? request : null;
  }, 'language change review request');
  assert.ok(current.messages.some(message => message.type === 'ai-cancel' && message.requestId === refreshingEnglish.requestId));
  assert.equal(shadow.querySelector('.ai-result'), null);
  refreshingEnglish.resolve({ ok: true, review: { summary: 'Stale English refresh', highlights: [reviewComment('Stale English highlight')], focus: [reviewComment('Stale English focus')] } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(shadow.querySelector('.ai-result'), null);
  spanish.resolve({ ok: true, review: { summary: 'Resumen actual en español', highlights: [reviewComment('Cambio de beta')], focus: [reviewComment('Revisar los consumidores de beta', 'left')] } });
  await until(() => shadow.querySelector('.ai-summary')?.textContent === 'Resumen actual en español', 'Spanish review result');
  assert.equal(shadow.querySelector('.ai-result')?.getAttribute('lang'), 'es');
  assert.ok(shadow.querySelector('.ai-scope')?.textContent?.includes('Español'));
  assert.equal(shadow.querySelector('.ai-review h2')?.textContent, 'AI review');
  assert.deepEqual([...shadow.querySelectorAll('.ai-highlights h3, .ai-focus h3')].map(heading => heading.textContent), ['Highlights', 'Review focus']);
  assert.equal(shadow.querySelector('.ai-result')?.textContent?.includes('Stale English'), false);
  for (const provider of ['gemini', 'claude'] as const) {
    const previous = pending.get(fixturePaths[1])!;
    responseProvider = provider;
    current.notifyAI();
    const next = await until(() => {
      const request = pending.get(fixturePaths[1]);
      return request?.requestId !== previous.requestId ? request : null;
    }, `${provider} review refresh`);
    assert.equal(shadow.querySelector('.ai-result'), null, 'Changing providers clears the previous review');
    next.resolve({ ok: true, review: { summary: `${provider} result`, highlights: [reviewComment('Cambio con referencia')], focus: [] } });
    await until(() => shadow.querySelector('.ai-summary')?.textContent === `${provider} result`, `${provider} result rendered`);
    assert.ok(shadow.querySelector('.ai-scope')?.textContent?.includes(AI_PROVIDERS[provider].label));
    assert.ok(shadow.querySelector('.ai-disclosure')?.textContent?.includes(`sent to ${AI_PROVIDERS[provider].label}`));
    assert.equal(shadow.querySelector('.ai-result')?.getAttribute('lang'), 'es');
    await verifyNavigation(shadow.querySelector<HTMLAnchorElement>('.ai-highlights a.ai-line-chip')!, 'R', 1);
  }
  assert.equal(JSON.stringify(current.messages).includes(secret), false);
  assert.equal(JSON.stringify(current.messages).includes('PRIVATE_REVIEW_DRAFT'), false);
  assert.equal(native.innerHTML, nativeHTML);
  assert.equal(draft.value, 'PRIVATE_REVIEW_DRAFT');
  assert.equal(viewed.checked, true);
  assert.deepEqual(current.errors, []);
});

test('reviews semantic React diff gutters and navigates validated references on the correct side', async t => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: { setAccessLevel: async () => {} },
      session: { setAccessLevel: async () => {} },
      onChanged: { addListener() {} },
    },
  } });
  t.after(() => {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  });
  const { parseAIReview } = await import('../src/background.ts');
  const path = 'frontend/src/status.ts';
  const route = '/acme/example/pull/12/changes';
  const payload = { payload: { pullRequestsChangesRoute: {
    pullRequestUrl: 'https://github.com/acme/example/pull/12',
    diffSummaries: [{ path, pathDigest: anchor(0).slice(5), changeType: 'MODIFIED', linesAdded: 1, linesDeleted: 1 }],
  } } };
  const scrolled: Element[] = [];
  const current = page(`https://github.com${route}`, {}, `
    <a id="prs-files-anchor-tab" href="${route}">Files changed<span data-component="CounterLabel">1</span></a>
    <react-app app-name="repo" initial-path="${route}"><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(payload)}</script></react-app>
    <div role="region" aria-labelledby="semantic-heading" id="${anchor(0)}">
      <h3 id="semantic-heading"><a href="#${anchor(0)}"><code>${path}</code></a></h3>
      <table><thead><tr><th scope="col">Original file line number</th><th scope="col">Diff line number</th><th scope="col">Diff line change</th></tr></thead><tbody>
        <tr><td>17</td><td></td><td>const previous = 0;</td></tr>
        <tr><td></td><td>17</td><td>const current = 1;</td></tr>
        <tr><td>18</td><td>19</td><td>export { current };</td></tr>
      </tbody></table>
    </div>
    <textarea aria-label="Review comment">Retain semantic diff draft</textarea><input type="checkbox" aria-label="Viewed" checked>`, message => {
    if (message.type === 'ai-status') return { ok: true, status: { configured: true, enabled: true, model: 'fixture-model', language: 'en' } };
    if (message.type === 'ai-review') {
      const review = parseAIReview({ output_text: JSON.stringify({
        summary: 'Updates the exported value.',
        highlights: [{ text: 'Updates current.', lines: [{ side: 'right', line: 17 }, { side: 'left', line: 19 }, { side: 'right', line: 999 }] }],
        focus: [{ text: 'Compare the previous value.', lines: [{ side: 'left', line: 17 }] }, { text: 'Check the exported value.', lines: [{ side: 'right', line: 19 }] }],
      }) }, message.context.diff);
      assert.ok(review);
      return { ok: true, review };
    }
  }, window => {
    window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  });
  t.after(() => current.dom.window.close());
  const native = current.window.document.getElementById(anchor(0))!;
  const nativeHTML = native.innerHTML;
  const rows = native.querySelectorAll('tbody tr');
  const draft = current.window.document.querySelector('textarea')!;
  const viewed = current.window.document.querySelector<HTMLInputElement>('input[aria-label="Viewed"]')!;
  native.querySelector<HTMLAnchorElement>('h3 a')!.addEventListener('click', event => {
    event.preventDefault();
    current.window.history.replaceState({}, '', `#${anchor(0)}`);
  });
  const shadow = await openPanel(current.window);
  const panel = shadow.querySelector('aside')!;
  await until(() => links(shadow).length === 1, 'semantic React file inventory');
  links(shadow)[0].click();
  await until(() => shadow.querySelector('.ai-summary')?.textContent === 'Updates the exported value.', 'semantic gutter review result');
  const request = current.messages.find(message => message.type === 'ai-review');
  assert.ok(request?.type === 'ai-review');
  assert.equal(request.context.diff, '[old line 17] -const previous = 0;\n[new line 17] +const current = 1;\n[new line 19]  export { current };');
  assert.equal(request.context.partial, false);
  assert.deepEqual([...shadow.querySelectorAll<HTMLAnchorElement>('a.ai-line-chip')].map(link => link.getAttribute('href')), [`#${anchor(0)}R17`, `#${anchor(0)}L17`, `#${anchor(0)}R19`], 'Only references validated against semantic gutter annotations are rendered');
  for (const [selector, hash, gutter] of [
    ['.ai-highlights a.ai-comment-link', `#${anchor(0)}R17`, rows[1].children[1]],
    ['.ai-focus a.ai-line-chip[data-side="left"]', `#${anchor(0)}L17`, rows[0].children[0]],
    ['.ai-focus a.ai-line-chip[data-side="right"]', `#${anchor(0)}R19`, rows[2].children[1]],
  ] as const) {
    const before = scrolled.length;
    shadow.querySelector<HTMLAnchorElement>(selector)!.click();
    await until(() => current.window.location.hash === hash && scrolled.length > before, `semantic gutter navigation ${hash}`);
    assert.strictEqual(scrolled.at(-1), gutter);
    assert.strictEqual(shadow.querySelector('aside'), panel);
    assert.equal(shadow.querySelector<HTMLElement>('.ai-review')?.hidden, false);
    assert.equal(shadow.querySelector('.ai-summary')?.textContent, 'Updates the exported value.');
  }
  assert.equal(current.messages.filter(message => message.type === 'ai-review').length, 1);
  assert.equal(native.innerHTML, nativeHTML);
  assert.equal(draft.value, 'Retain semantic diff draft');
  assert.equal(viewed.checked, true);
  assert.deepEqual(current.errors, []);
});

test('recovers from an invalidated extension without crashing on review or cancellation', async t => {
  const notice = 'PR Reviewer was updated or reloaded. Reload this GitHub tab to reconnect.';
  for (const mode of ['synchronous throw', 'rejected promise']) await t.test(mode, async sub => {
    const fixturePaths = ['src/first.ts', 'src/second.ts'];
    const failed: ExtensionRequest[] = [];
    const uncaught: unknown[] = [];
    const html = `
      <a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter">2</span></a>
      <main id="native-files">${fixturePaths.map((path, index) => `
        <div class="js-file" data-tagsearch-path="${path}" id="${anchor(index)}">
          <div class="file-header" data-path="${path}" data-anchor="${anchor(index)}"><a href="#${anchor(index)}" title="${path}">${path}</a></div>
          <table><tbody><tr><td class="blob-num" data-line-number="1">1</td><td class="blob-code blob-code-addition"><span class="blob-code-inner" data-code-marker="+">export const value = ${index};</span></td></tr></tbody></table>
        </div>`).join('')}</main>
      <textarea aria-label="Review comment">Draft before extension reload</textarea><input type="checkbox" aria-label="Viewed" checked>`;
    const current = page(undefined, {}, html, message => {
      if (message.type === 'ai-status') return { ok: true, status: { configured: true, enabled: true, model: DEFAULT_AI_MODEL, language: 'en' } };
    }, window => {
      const send = window.chrome.runtime.sendMessage;
      Object.defineProperty(window.chrome.runtime, 'sendMessage', { value: (message: ExtensionRequest) => {
        if (message.type !== 'ai-review' && message.type !== 'ai-cancel') return send(message);
        failed.push(structuredClone(message));
        const error = new window.Error('Extension context invalidated.');
        if (mode === 'synchronous throw') throw error;
        return Promise.reject(error);
      } });
      window.addEventListener('error', event => uncaught.push(event.error ?? event.message));
      window.addEventListener('unhandledrejection', event => uncaught.push(event.reason));
    });
    sub.after(() => current.dom.window.close());
    const native = current.window.document.querySelector('#native-files')!;
    const nativeHTML = native.innerHTML;
    const draft = current.window.document.querySelector('textarea')!;
    const viewed = current.window.document.querySelector<HTMLInputElement>('input[aria-label="Viewed"]')!;
    const nativeLinks = [...native.querySelectorAll<HTMLAnchorElement>('.file-header a')];
    for (const link of nativeLinks) link.addEventListener('click', event => {
      event.preventDefault();
      current.window.history.replaceState({}, '', link.getAttribute('href')!);
    });
    const shadow = await openPanel(current.window);
    const panel = shadow.querySelector('aside')!;
    await until(() => links(shadow).length === 2, 'reload recovery fixture inventory');
    nativeLinks[0].click();
    const assertRecovery = async (path: string) => {
      await until(() => shadow.querySelector('.ai-error')?.textContent === notice && shadow.querySelector('.ai-file')?.getAttribute('title') === path, 'friendly invalidated-context recovery');
      assert.equal(shadow.querySelector<HTMLElement>('.ai-review')?.hidden, false);
      assert.equal(shadow.querySelector('.ai-error')?.getAttribute('role'), 'alert');
      const reload = [...shadow.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Reload GitHub tab');
      assert.ok(reload && !reload.disabled, 'The recovery button lets the user reload the GitHub tab');
      assert.equal([...shadow.querySelectorAll('button')].some(button => button.textContent === 'Retry review'), false);
      assert.equal(shadow.textContent?.includes('Extension context invalidated'), false);
      assert.strictEqual(shadow.querySelector('aside'), panel);
      assert.equal(draft.value, 'Draft before extension reload');
      assert.equal(viewed.checked, true);
    };
    await assertRecovery(fixturePaths[0]);
    const first = failed.find(message => message.type === 'ai-review');
    assert.ok(first?.type === 'ai-review');
    nativeLinks[1].click();
    await assertRecovery(fixturePaths[1]);
    assert.ok(failed.some(message => message.type === 'ai-cancel' && message.requestId === first.requestId), 'Switching files safely handles invalidated cancellation cleanup');
    assert.equal(failed.filter(message => message.type === 'ai-review').length, 2);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(uncaught, []);
    assert.deepEqual(current.errors, []);
    assert.equal(native.innerHTML, nativeHTML);
    assert.strictEqual(current.window.document.querySelector('textarea'), draft);
    assert.strictEqual(current.window.document.querySelector('input[aria-label="Viewed"]'), viewed);
  });
});

test('manual workflow saves notes and progress, skips reviewed files, dismisses blocks and opens editable suggestions', async t => {
  const fixturePaths = ['backend/src/api/v1/payment/router.ts', 'backend/src/api/v1/payment/types.ts'];
  const html = `<a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter">2</span></a>${fixturePaths.map((path, index) => `<section id="${anchor(index)}" data-tagsearch-path="${path}"><div class="file-header" data-path="${path}" data-anchor="${anchor(index)}"><a title="${path}" href="#${anchor(index)}">${path}</a><label><input type="checkbox" aria-label="Viewed">Viewed</label></div><table><tr><td id="${anchor(index)}R1" class="blob-num" data-line-number="1">1<button class="add-line-comment" aria-label="Add a comment on line R1"></button></td><td class="blob-code blob-code-addition"><span class="blob-code-inner" data-code-marker="+">return input;</span></td></tr></table></section>`).join('')}`;
  let calls = 0;
  const stored: Record<string, unknown> = {};
  const handler = async (message: ExtensionRequest): Promise<ExtensionResponse | undefined> => {
    if (message.type === 'ai-status') return { ok: true, status: { configured: true, enabled: true, model: 'fixture', language: 'en', options: { ...DEFAULT_WORKFLOW, automatic: false, syncViewed: true, checklist: true }, checklist: ['Tenant isolation'] } };
    if (message.type === 'ai-review') { calls++; return { ok: true, review: { summary: 'Changes return value.', highlights: [], focus: [{ text: 'Could the input be null?', kind: 'question', severity: 'medium', evidence: 'Input is returned directly.', lines: [{ side: 'right', line: 1 }], suggestion: { line: 1, code: 'return input ?? null;' } }], usage: { input: 100, output: 20, total: 120 } } }; }
  };
  const current = page(undefined, stored, html, handler); t.after(() => current.dom.window.close());
  const shadow = await openPanel(current.window);
  const button = (label: string) => [...shadow.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!;
  links(shadow)[0].click();
  await until(() => button('Analyze file'), 'manual analyze button'); assert.equal(calls, 0);
  button('Analyze file').click(); await until(() => shadow.querySelector('.ai-result'), 'manual result'); assert.equal(calls, 1);
  assert.match(shadow.querySelector('.ai-usage')!.textContent!, /100 input \+ 20 output/);
  assert.match(shadow.querySelector('.finding-meta')!.textContent!, /Questionmedium severity/);
  const native = current.window.document.querySelector<HTMLButtonElement>('.add-line-comment')!;
  native.onclick = () => { native.closest('tr')!.lastElementChild!.insertAdjacentHTML('beforeend', '<div class="js-inline-comments-container"><h4>Add a comment on line R1</h4><textarea aria-label="Markdown value"></textarea></div>'); };
  button('Add suggestion').click();
  const editor = await until(() => current.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown value"]')?.value ? current.window.document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Markdown value"]') : null, 'suggestion draft');
  assert.equal(editor.value, '```suggestion\nreturn input ?? null;\n```');
  [...shadow.querySelectorAll<HTMLButtonElement>('.ai-focus button')].find(button => button.textContent === 'Reviewed')!.click(); await until(() => shadow.querySelector('.ai-focus .is-reviewed'), 'reviewed finding');
  const note = shadow.querySelector<HTMLTextAreaElement>('#review-note')!;
  const setter = Object.getOwnPropertyDescriptor(current.window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(note, 'private reviewer note'); note.dispatchEvent(new current.window.Event('input', { bubbles: true, composed: true }));
  note.focus(); note.blur();
  const fileKey = 'test:progress:/acme/example/pull/12/files';
  await until(() => (stored[fileKey] as any)?.files[fixturePaths[0]]?.note === 'private reviewer note', 'saved private note');
  button('Files').click();
  const mark = shadow.querySelector<HTMLButtonElement>('.file-reviewed')!; mark.click();
  await until(() => mark.textContent === '✓ File reviewed', 'file completion');
  await until(() => current.window.document.querySelector<HTMLInputElement>('input[aria-label="Viewed"]')!.checked, 'native Viewed sync');
  button('Next pending').click(); await until(() => shadow.querySelector('.selected .file-link')?.getAttribute('title') === fixturePaths[1], 'next pending file');
  assert.equal(calls, 1, 'Next pending does not automatically analyze in manual mode');
  links(shadow)[0].click(); button('AI review').click(); await until(() => button('Analyze file'), 'manual second visit'); button('Analyze file').click();
  await until(() => shadow.querySelector('.ai-focus .is-reviewed'), 'finding progress survives file switch');
  const toggle = shadow.querySelector<HTMLButtonElement>('.ai-focus .ai-reviewed-toggle')!; toggle.click();
  button('Dismiss').click(); await until(() => shadow.querySelector('.ai-dismissed'), 'dismiss finding');
  button('Undo dismiss').click(); await until(() => shadow.querySelector('.ai-focus .ai-comment'), 'restore finding');
  assert.equal(JSON.stringify(current.messages.filter(message => message.type === 'ai-review')).includes('private reviewer note'), false);
  assert.deepEqual(current.errors, []);
  // A reload reuses local progress without making a provider call until explicitly requested.
  const reloaded = page(undefined, stored, html, handler); t.after(() => reloaded.dom.window.close());
  const nextShadow = await openPanel(reloaded.window);
  await until(() => [...nextShadow.querySelectorAll<HTMLButtonElement>('.file-reviewed')].some(button => button.textContent === '✓ File reviewed'), 'file progress survives reload');
});

for (const apiContext of [false, true]) test(apiContext ? 'module analysis follows references across packages and rejects a mismatched API revision' : 'module analysis reads Changes without GitHub API access and follows references across packages', async t => {
  const fixturePaths = ['packages/mira-api/src/order.ts', 'packages/mira-widgets/src/order.tsx'];
  const route = '/acme/example/pull/12/files';
  const html = `<a class="tabnav-tab" href="${route}"><span id="files_tab_counter">2</span></a>${fixturePaths.map((path, index) => `<section id="${anchor(index)}" data-tagsearch-path="${path}"><div class="file-header" data-path="${path}" data-anchor="${anchor(index)}"><a title="${path}" href="#${anchor(index)}">${path}</a></div><table><tr><td id="${anchor(index)}R1" class="blob-num" data-line-number="1">1</td><td class="blob-code blob-code-addition"><span class="blob-code-inner" data-code-marker="+">return input;</span></td></tr></table></section>`).join('')}`;
  let mismatched = false, calls = 0, apiCalls = 0;
  const current = page(undefined, {}, html, async message => {
    if (message.type === 'ai-status') return { ok: true, status: { configured: true, enabled: true, model: 'fixture', language: 'en', options: { ...DEFAULT_WORKFLOW, automatic: false, moduleReview: true, expandedContext: apiContext } } };
    if (message.type === 'github-context') {
      apiCalls++; assert.equal(apiContext, true);
      assert.deepEqual(Array.from(message.relatedPaths ?? []), [fixturePaths[1]]); assert.equal(message.scope, 'module');
      return { ok: true, context: { path: fixturePaths[0], diff: '[new line 1] +' + (mismatched ? 'stale' : 'return input;'), partial: false, scope: 'module', related: [{ path: fixturePaths[1], diff: '[new line 1] +return input;', partial: false }] } };
    }
    if (message.type === 'ai-review') {
      calls++; assert.equal(message.context.scope, 'module'); assert.equal(message.context.diff, '[new line 1] +return input;');
      assert.equal(message.context.related?.[0].path, fixturePaths[1]); assert.equal(message.context.related?.[0].diff, '[new line 1] +return input;');
      return { ok: true, review: { summary: 'Checks the package contract.', highlights: [{ text: 'Verify the widget caller.', lines: [{ path: fixturePaths[1], side: 'right', line: 1 }] }], focus: [] } };
    }
  }); t.after(() => current.dom.window.close());
  const shadow = await openPanel(current.window); links(shadow).find(link => link.title === fixturePaths[0])!.click();
  const button = (name: string) => [...shadow.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!;
  button('AI review').click(); await until(() => shadow.querySelector('.module-review-controls'), 'module controls');
  shadow.querySelector<HTMLDetailsElement>('.module-review-controls')!.open = true;
  const related = shadow.querySelector<HTMLInputElement>('.module-review-controls input')!; related.click(); button('Analyze module').click();
  await until(() => shadow.querySelector('.ai-result') || shadow.querySelector('.ai-error'), 'module result'); assert.equal(shadow.querySelector('.ai-error')?.textContent, undefined, JSON.stringify(current.messages)); assert.equal(calls, 1);
  const chip = shadow.querySelector<HTMLAnchorElement>('.ai-line-chip')!;
  assert.equal(chip.getAttribute('href'), `#${anchor(1)}R1`); chip.click();
  await until(() => current.window.location.hash === `#${anchor(1)}R1`, 'related package line navigation');
  assert.equal(shadow.querySelector('.ai-file')!.textContent, fixturePaths[0], 'Line jumps preserve the module analysis');
  assert.equal(apiCalls, apiContext ? 1 : 0);
  if (apiContext) {
    mismatched = true; button('Refresh review').click();
    await until(() => shadow.querySelector('.ai-error')?.textContent?.includes('does not match'), 'stale API revision rejection');
    assert.equal(calls, 1, 'A mismatched API context must not be sent to AI');
  }
  assert.deepEqual(current.errors, []);
});

for (const scope of ['file', 'module'] as const) test(`${scope} review falls back to loaded Changes when private GitHub API access fails`, async t => {
  const path = 'backend/src/api/v1/orders/index.ts';
  let calls = 0;
  const html = `<a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter">1</span></a><section id="${anchor(0)}" data-tagsearch-path="${path}"><div class="file-header" data-path="${path}" data-anchor="${anchor(0)}"><a title="${path}" href="#${anchor(0)}">${path}</a></div><table><tr><td class="blob-num" data-line-number="17">17</td><td class="blob-code"><span class="blob-code-inner" data-code-marker="+">return input;</span></td></tr></table><textarea>PRIVATE_DRAFT</textarea></section>`;
  const current = page(undefined, {}, html, async message => {
    if (message.type === 'ai-status') return { ok: true, status: { configured: true, enabled: true, model: 'fixture', language: 'en', options: { ...DEFAULT_WORKFLOW, automatic: false, expandedContext: true, moduleReview: true } } };
    if (message.type === 'github-context') { assert.equal(message.scope, scope); return { ok: false, error: 'GitHub API access failed. For private repositories, add a token with Pull requests and Contents read access in Settings.' }; }
    if (message.type === 'ai-review') {
      calls++; assert.equal(message.context.diff, '[new line 17] +return input;');
      assert.equal(message.context.surrounding, undefined); assert.equal(message.context.revision, undefined);
      assert.equal(JSON.stringify(message.context).includes('PRIVATE_DRAFT'), false);
      return { ok: true, review: { summary: 'Reviews loaded changes.', highlights: [{ text: 'Check input.', lines: [{ side: 'right', line: 17 }] }], focus: [] } };
    }
  }); t.after(() => current.dom.window.close());
  const shadow = await openPanel(current.window); links(shadow).find(link => link.title === path)!.click();
  const button = (name: string) => [...shadow.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!;
  button('AI review').click(); await until(() => button('Analyze file'), 'manual analysis ready');
  if (scope === 'module') shadow.querySelector<HTMLDetailsElement>('.module-review-controls')!.open = true;
  button(scope === 'module' ? 'Analyze module' : 'Analyze file').click();
  await until(() => shadow.querySelector('.ai-result'), 'loaded-diff fallback review');
  assert.equal(calls, 1); assert.equal(shadow.querySelector('.ai-error'), null);
  assert.match(shadow.textContent!, /GitHub API context unavailable. Using loaded changes/);
  assert.match(shadow.querySelector('.ai-disclosure')!.textContent!, /loaded/);
  assert.equal(shadow.querySelector('.ai-disclosure')!.textContent!.includes('surrounding source'), false);
  assert.equal(shadow.querySelector<HTMLAnchorElement>('.ai-line-chip')!.getAttribute('href'), `#${anchor(0)}R17`);
  assert.equal(current.window.document.querySelector('textarea')!.value, 'PRIVATE_DRAFT');
  assert.deepEqual(current.errors, []);
});

test('whole-file progress also supports rendered image diffs without calling AI', async t => {
  const path = 'frontend/images/logo.png';
  const current = page(undefined, {}, `<a class="tabnav-tab" href="/acme/example/pull/12/files"><span id="files_tab_counter">1</span></a><section id="${anchor(0)}" data-tagsearch-path="${path}"><div class="file-header" data-path="${path}" data-anchor="${anchor(0)}"><a href="#${anchor(0)}" title="${path}">${path}</a></div><img src="https://github.com/acme/example/raw/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/frontend/images/logo.png" alt="Changed image"></section>`);
  t.after(() => current.dom.window.close());
  const shadow = await openPanel(current.window); const mark = shadow.querySelector<HTMLButtonElement>('.file-reviewed')!;
  mark.click(); await until(() => mark.textContent === '✓ File reviewed', 'image reviewed');
  assert.equal(current.messages.some(message => message.type === 'ai-review'), false);
  assert.equal(shadow.querySelector('.error'), null);
  assert.deepEqual(current.errors, []);
});
