import { getPullRequest, isPullRequestView, readFiles, type PullRequestFile } from './github';
import { fingerprint, moduleFor, type WorkflowOptions } from './workflow';
import type { AIReviewContext, AIReviewLine } from './ai-protocol';

export type ReviewContext = { path: string; diff: string; partial: boolean };

const MAX_CHARS = 60_000;
const CODE = '.blob-code-inner, .diff-text-inner, .blob-code, [data-code-marker]';
const EXCLUDED = '.js-inline-comments-container, .js-comment-container, .review-comment, .review-thread, .timeline-comment, .comment-body, .markdown-body, [id^="review-thread"], textarea, input, [contenteditable="true"], [role="textbox"]';
const LOAD_ERROR = 'No readable text diff is available for this file. Load or expand its diff in GitHub, then Retry.';
const STALE_ERROR = 'The pull request or selected file changed. Select the file again and Retry.';

function visible(element: Element): boolean {
  if (typeof element.checkVisibility === 'function') return element.checkVisibility({ visibilityProperty: true });
  for (let current: Element | null = element; current; current = current.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(current);
    if (current.hasAttribute('hidden') || current.tagName === 'DETAILS' && !current.hasAttribute('open') ||
      style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  }
  return true;
}

function renderedPath(target: Element, anchor: string): string | null {
  const explicit = target.getAttribute('data-tagsearch-path') ?? target.getAttribute('data-path') ??
    target.querySelector('.file-header[data-path], [data-path][data-anchor]')?.getAttribute('data-path');
  if (explicit) return explicit;
  if (target.getAttribute('role') !== 'region') return null;
  const label = target.getAttribute('aria-labelledby');
  const heading = label ? target.ownerDocument.getElementById(label) : null;
  if (heading?.tagName !== 'H3' || !target.contains(heading)) return null;
  const link = [...heading.querySelectorAll('a[href]')].find(link => link.getAttribute('href') === `#${anchor}`);
  return link?.querySelector('code')?.textContent?.replace(/^[\t\n\r ]*\u200e|\u200e[\t\n\r ]*$/g, '') ?? null;
}

type LineSide = 'old' | 'new';
type LineReference = { side: LineSide; line: number; target: Element };
type CodeLine = { marker: string; reference: LineReference | null };

function semanticTable(table: Element | null): number {
  if (!table) return 0;
  const headers = [...table.querySelectorAll('th, [role="columnheader"]')]
    .filter(header => header.closest('table') === table);
  if (headers.length !== 3 || !headers.every((header, index) =>
    (header.tagName === 'TH' || header.tagName === 'TD') && (header as HTMLTableCellElement).rowSpan === 1 &&
    header.parentElement === headers[0].parentElement && header.textContent?.trim() ===
    ['Original file line number', 'Diff line number', 'Diff line change'][index])) return 0;
  const spans = headers.map(header => (header as HTMLTableCellElement).colSpan);
  return spans[0] === 1 && spans[1] === 1 && (spans[2] === 1 || spans[2] === 2) ? spans[2] : 0;
}

function positiveLine(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function gutterInfo(element: Element, anchor: string): { side?: LineSide; line: number } | null {
  const anchored = element.id.startsWith(anchor) ? element.id.slice(anchor.length).match(/^([LR])([1-9]\d*)$/) : null;
  if (element.id.startsWith('diff-') && !anchored) return null;
  const raw = element.getAttribute('data-line-number');
  const line = positiveLine(raw) ?? positiveLine(anchored?.[2] ?? null);
  if (line === null || anchored && raw !== null && positiveLine(raw) !== positiveLine(anchored[2])) return null;
  const side = anchored ? anchored[1] === 'L' ? 'old' : 'new' :
    element.matches('.js-blob-rnum, .blob-num-addition') ? 'new' :
      element.matches('.blob-num-deletion') ? 'old' : undefined;
  return { side, line };
}

function lineReference(cell: Element, marker: string, anchor: string): LineReference | null {
  if (marker !== '+' && marker !== '-' && marker !== ' ') return null;
  const column = cell.closest('td, [role="cell"], [role="gridcell"]');
  const row = cell.closest('tr, [role="row"]');
  const codeColumns = row ? [...row.children].filter(column => column.matches(CODE) || column.querySelector(CODE)) : [];
  const splitSide: LineSide | undefined = codeColumns.length === 2 && column ?
    codeColumns.indexOf(column) === 0 ? 'old' : codeColumns.indexOf(column) === 1 ? 'new' : undefined : undefined;
  const gutters: Element[] = [];
  for (let previous = column?.previousElementSibling; previous; previous = previous.previousElementSibling) {
    if (codeColumns.includes(previous)) break;
    if (previous.hasAttribute('data-line-number') || previous.matches('.blob-num')) gutters.unshift(previous);
  }
  const infos = gutters.map(gutter => gutterInfo(gutter, anchor));
  const markedSide = marker === '+' ? 'new' : marker === '-' ? 'old' : undefined;
  if (markedSide && splitSide && markedSide !== splitSide) return null;
  const side = markedSide ?? splitSide ?? (gutters.length === 1 ? infos[0]?.side : undefined) ?? 'new';
  const own = cell.closest('[data-line-number]');
  if (own && own.id !== anchor && (!row || row.contains(own)) && (own !== row || codeColumns.length < 2)) {
    const info = gutterInfo(own, anchor);
    if (info && (!info.side || info.side === side)) return { side, line: info.line, target: own };
  }
  const knownIndex = infos.findIndex(info => info?.side === side);
  if (knownIndex >= 0) return { side, line: infos[knownIndex]!.line, target: gutters[knownIndex] };
  if (gutters.length === 1 && infos[0] && !infos[0].side) return { side, line: infos[0].line, target: gutters[0] };
  return null;
}

function semanticLine(cell: Element, marker: string, anchor: string): CodeLine | undefined {
  const row = cell.closest('tr');
  const columns = row ? [...row.children] : [];
  const codeSpan = semanticTable(row?.closest('table') ?? null);
  if (!codeSpan || columns.length !== 3 || columns.some((column, index) => column.tagName !== 'TD' ||
    (column as HTMLTableCellElement).colSpan !== (index === 2 ? codeSpan : 1) || (column as HTMLTableCellElement).rowSpan !== 1) ||
    cell.closest('td') !== columns[2]) return;
  const values = columns.slice(0, 2).map(gutter => gutter.textContent?.trim() ?? '');
  // Classic gutters can expose numbers only through attributes; their normal adapter handles those.
  if (values.every(value => !value)) return;
  const numbers = values.map(positiveLine);
  const invalid = (): CodeLine => ({ marker, reference: null });
  if (values.some((value, index) => value && numbers[index] === null) ||
    columns.slice(0, 2).some(gutter => !visible(gutter) || gutter.matches(EXCLUDED) || gutter.querySelector(EXCLUDED) ||
      [...gutter.querySelectorAll('*')].some(element => element.textContent?.trim() &&
        (!visible(element) || element.matches('[aria-hidden="true"], [role="tooltip"], tool-tip'))))) return invalid();
  const inferred = numbers[0] === null ? '+' : numbers[1] === null ? '-' : ' ';
  const side: LineSide = inferred === '-' ? 'old' : 'new';
  const index = side === 'old' ? 0 : 1;
  const explicit = cell.closest('[data-code-marker]')?.getAttribute('data-code-marker');
  if (marker && marker !== inferred || explicit !== undefined && explicit !== null && explicit !== inferred) return invalid();
  for (let index = 0; index < 2; index += 1) {
    const gutter = columns[index];
    const known = [gutter, ...gutter.querySelectorAll('[data-line-number], [id^="diff-"]')]
      .filter(element => element.hasAttribute('data-line-number') || element.id.startsWith('diff-'));
    for (const element of known) {
      const info = gutterInfo(element, anchor);
      if (!info || info.line !== numbers[index] || info.side && info.side !== (index === 0 ? 'old' : 'new')) return invalid();
    }
  }
  const own = cell.closest('[data-line-number]');
  if (own && own.id !== anchor && row?.contains(own)) {
    const info = gutterInfo(own, anchor);
    if (!info || info.line !== numbers[index] || info.side && info.side !== side) return invalid();
  }
  return { marker: inferred, reference: { side, line: numbers[index]!, target: columns[index] } };
}

function codeCells(target: Element): Element[] {
  const sourceCell = (cell: Element) => !cell.closest(EXCLUDED) && !cell.closest('.empty-cell, .blob-code-hunk, .diff-hunk-cell') &&
    !cell.querySelector('.blob-code-hunk, .diff-hunk-cell');
  let cells = [...target.querySelectorAll(CODE)].filter(cell => !cell.querySelector(CODE) && sourceCell(cell));
  if (!cells.length) {
    // The local demo and simple native diff tables expose a numeric gutter.
    cells = [...target.querySelectorAll('table tr')].flatMap(row => {
      const columns = [...row.querySelectorAll(':scope > td')];
      const semantic = columns.length === 3 && semanticTable(row.closest('table')) &&
        columns.slice(0, 2).some(column => positiveLine(column.textContent?.trim() ?? '') !== null);
      return (semantic || columns.length >= 2 && /^\d+$/.test(columns[0].textContent?.trim() ?? '')) &&
        !columns.at(-1)!.querySelector(EXCLUDED) ? [columns.at(-1)!] : [];
    });
  }
  return cells.filter(sourceCell);
}

function codeMarker(cell: Element): string {
  const explicit = cell.closest('[data-code-marker]')?.getAttribute('data-code-marker');
  return explicit === '+' || explicit === '-' || explicit === ' ' ? explicit :
    cell.closest('.blob-code-addition') ? '+' : cell.closest('.blob-code-deletion') ? '-' :
      cell.closest('.blob-code-context') ? ' ' : '';
}

function codeLine(cell: Element, anchor: string): CodeLine {
  const marker = codeMarker(cell);
  return semanticLine(cell, marker, anchor) ?? { marker, reference: lineReference(cell, marker, anchor) };
}

export function selectedDiff(file: PullRequestFile, document: Document): { target: HTMLElement; current: PullRequestFile } | null {
  const pr = getPullRequest(document.URL);
  const current = readFiles(document).find(current => current.path === file.path && current.anchor === file.anchor);
  if (!pr?.isFilesPage || !isPullRequestView(document, pr) || !current) throw new Error(STALE_ERROR);
  const target = document.getElementById(file.anchor);
  if (!target) return null;
  const path = renderedPath(target, file.anchor);
  if (path && path !== file.path) throw new Error(STALE_ERROR);
  return path && visible(target) ? { target, current } : null;
}

export function findReviewLine(
  file: PullRequestFile,
  reference: AIReviewLine,
  document: Document = globalThis.document,
): HTMLElement | null {
  if (!Number.isSafeInteger(reference.line) || reference.line < 1 ||
    reference.side !== 'left' && reference.side !== 'right') return null;
  try {
    const selected = selectedDiff(file, document);
    if (!selected) return null;
    const side = reference.side === 'left' ? 'old' : 'new';
    for (const cell of codeCells(selected.target)) {
      if (!visible(cell)) continue;
      const current = codeLine(cell, file.anchor).reference;
      if (current?.side === side && current.line === reference.line) {
        const target = visible(current.target) ? current.target : cell;
        return target.namespaceURI === 'http://www.w3.org/1999/xhtml' ? target as HTMLElement : null;
      }
    }
  } catch {
    // Stale routes or mismatched file regions are never navigation targets.
  }
  return null;
}

function extract(target: Element, file: PullRequestFile): ReviewContext | null {
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  let length = 0;
  let partial = !!target.querySelector('.js-expand, .js-expand-all, .blob-num-expandable, .js-diff-load-container, [data-hidden-line-count]');
  for (const cell of codeCells(target)) {
    if (!visible(cell)) { partial = true; continue; }
    const copy = cell.cloneNode(true) as Element;
    copy.querySelectorAll(EXCLUDED).forEach(element => element.remove());
    const text = (copy.textContent ?? '').replace(/\r\n?/g, '\n');
    const { marker, reference } = codeLine(cell, file.anchor);
    if (marker === '+') additions += 1;
    if (marker === '-') deletions += 1;
    if (!marker || /[\n\u2028\u2029]/.test(text)) partial = true;
    if (!reference) partial = true;
    // Keep each DOM row on one output row so source text cannot forge reference tags.
    const source = text.replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const line = `${reference ? `[${reference.side} line ${reference.line}] ` : ''}${marker || ' '}${source}`;
    length += line.length + (lines.length ? 1 : 0);
    lines.push(line);
    if (length > MAX_CHARS) { partial = true; break; }
  }
  if (!lines.length) return null;
  partial ||= file.additions === undefined || file.deletions === undefined ||
    additions !== file.additions || deletions !== file.deletions;
  return { path: file.path, diff: lines.join('\n').slice(0, MAX_CHARS), partial };
}

export async function collectReviewContext(
  file: PullRequestFile,
  document: Document = globalThis.document,
  signal?: AbortSignal,
): Promise<ReviewContext> {
  const route = document.URL.split('#')[0];
  const Observer = document.defaultView?.MutationObserver ?? MutationObserver;
  return new Promise((resolve, reject) => {
    const finish = (context?: ReviewContext, error?: unknown) => {
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(context!);
    };
    const abort = () => finish(undefined, new DOMException('Review canceled.', 'AbortError'));
    const check = () => {
      if (signal?.aborted) { abort(); return; }
      try {
        if (document.URL.split('#')[0] !== route) throw new Error(STALE_ERROR);
        const selected = selectedDiff(file, document);
        if (!selected) return;
        const context = extract(selected.target, selected.current);
        if (context) finish(context);
      } catch (error) { finish(undefined, error); }
    };
    const observer = new Observer(check);
    const poll = setInterval(check, 100);
    const timeout = setTimeout(() => finish(undefined, new Error(LOAD_ERROR)), 5_000);
    observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}

export function collectLoadedReviewContext(
  file: PullRequestFile,
  files: PullRequestFile[],
  loaded: ReviewContext,
  scope: 'file' | 'module',
  relatedPaths: string[],
  options: WorkflowOptions,
  document: Document = globalThis.document,
): AIReviewContext {
  const candidates = scope === 'module' ? [file, ...files.filter(target => target.path !== file.path &&
    (moduleFor(target.path) === moduleFor(file.path) || relatedPaths.includes(target.path)))] : [file];
  const contexts: AIReviewContext[] = [];
  const warnings: string[] = [];
  let remaining = options.maxContextChars, unavailable = 0;
  for (const target of candidates) {
    if (contexts.length >= options.moduleFileLimit || remaining < 1000) {
      warnings.push('Review limits reached; some selected files were omitted.'); break;
    }
    const selected = target.path === file.path ? null : selectedDiff(target, document);
    const context = target.path === file.path ? loaded : selected && extract(selected.target, selected.current);
    if (!context) { unavailable++; continue; }
    let diff = context.diff;
    if (diff.length > remaining) {
      diff = diff.slice(0, remaining);
      const end = diff.lastIndexOf('\n');
      if (end >= 0) diff = diff.slice(0, end);
    }
    contexts.push({ ...context, diff, partial: context.partial || diff !== context.diff });
    remaining -= diff.length;
  }
  if (unavailable) warnings.push(`${unavailable} selected file${unavailable === 1 ? '' : 's'} had no loaded text diff. Load or expand them in GitHub, then refresh the review.`);
  return { ...contexts[0], ...(scope === 'module' ? { scope, related: contexts.slice(1) } : {}),
    partial: contexts.some(context => context.partial) || warnings.length > 0,
    ...(warnings.length ? { warnings } : {}) };
}

export function readHeadRevision(document: Document = globalThis.document): string {
  for (const element of document.querySelectorAll('[data-head-sha], meta[name="pull-request-head-sha"]')) {
    const value = element.getAttribute('data-head-sha') ?? element.getAttribute('content');
    if (/^[a-f\d]{40,64}$/i.test(value ?? '')) return value!;
  }
  for (const app of document.querySelectorAll('react-app[app-name="repo"][initial-path]')) {
    try {
      const url = new URL(app.getAttribute('initial-path')!, document.URL);
      if (url.pathname + url.search !== new URL(document.URL).pathname + new URL(document.URL).search) continue;
      const route = JSON.parse(app.querySelector('script[data-target="react-app.embeddedData"]')?.textContent ?? '').payload?.pullRequestsChangesRoute;
      const pr = getPullRequest(document.URL);
      if (!pr || getPullRequest(route?.pullRequestUrl ?? '')?.key !== pr.key) continue;
      for (const value of [route.headOid, route.headSha, route.currentHeadOid]) if (typeof value === 'string' && /^[a-f\d]{40,64}$/i.test(value)) return value;
    } catch {}
  }
  return '';
}

export async function syncGitHubViewed(file: PullRequestFile, reviewed: boolean, signal?: AbortSignal): Promise<boolean> {
  const route = document.URL.split('#')[0];
  if (!await import('./github').then(({ navigateToFile }) => navigateToFile(file, document, signal))) return false;
  const deadline = Date.now() + 3000;
  do {
    if (signal?.aborted || document.URL.split('#')[0] !== route) return false;
    const target = selectedDiff(file, document)?.target;
    const controls = target ? [...target.querySelectorAll<HTMLElement>('input[type="checkbox"], [role="checkbox"][aria-checked]')].filter(input => {
      const label = input.getAttribute('aria-label') ?? input.closest('label')?.textContent?.trim() ?? '';
      return /\bviewed\b/i.test(label) && !input.closest('.js-inline-comments-container, .review-comment, .comment-body') && !input.hasAttribute('disabled');
    }) : [];
    if (controls.length === 1) {
      const input = controls[0];
      const checked = () => input instanceof HTMLInputElement ? input.checked : input.getAttribute('aria-checked') === 'true';
      if (checked() !== reviewed) input.click();
      return checked() === reviewed;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return false;
}

export async function collectProgressRevision(file: PullRequestFile, document: Document = globalThis.document, signal?: AbortSignal): Promise<string> {
  const selected = selectedDiff(file, document);
  if (selected && !selected.target.querySelector(CODE)) {
    const images = [...selected.target.querySelectorAll<HTMLImageElement>('img[src]')].filter(image => !image.closest(EXCLUDED)).map(image => image.getAttribute('src'));
    const copy = selected.target.cloneNode(true) as Element; copy.querySelectorAll(EXCLUDED).forEach(element => element.remove());
    if (images.length && /\.(png|jpe?g|gif|webp|avif|ico|svg)$/i.test(file.path) || /\b(?:Binary file not shown|Binary files differ|Sorry, we cannot display this file)\b/i.test(copy.textContent ?? '')) {
      return readHeadRevision(document) + ':' + await fingerprint(JSON.stringify([file.path, file.deleted, file.additions, file.deletions, images]));
    }
  }
  const context = await collectReviewContext(file, document, signal);
  return readHeadRevision(document) + ':' + await fingerprint(context.diff);
}
