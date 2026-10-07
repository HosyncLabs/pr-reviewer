import { getPullRequest, isPullRequestView, readFiles, type PullRequestFile } from './github';

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

function lineNumber(cell: Element): string | null {
  const own = cell.closest('[data-line-number]')?.getAttribute('data-line-number');
  if (own && /^\d+$/.test(own)) return own;
  const td = cell.closest('td');
  for (let previous = td?.previousElementSibling; previous; previous = previous.previousElementSibling) {
    const number = previous.getAttribute('data-line-number');
    if (number && /^\d+$/.test(number)) return number;
  }
  const first = cell.closest('tr')?.querySelector('td')?.textContent?.trim();
  return first && /^\d+$/.test(first) ? first : null;
}

function extract(target: Element, file: PullRequestFile): ReviewContext | null {
  let cells = [...target.querySelectorAll(CODE)].filter(cell => !cell.querySelector(CODE));
  if (!cells.length) {
    // The local demo and simple native diff tables expose a numeric gutter.
    cells = [...target.querySelectorAll('table tr')].flatMap(row => {
      const columns = [...row.querySelectorAll(':scope > td')];
      return columns.length >= 2 && /^\d+$/.test(columns[0].textContent?.trim() ?? '') ? [columns.at(-1)!] : [];
    });
  }
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  let length = 0;
  let partial = !!target.querySelector('.js-expand, .js-expand-all, .blob-num-expandable, .js-diff-load-container, [data-hidden-line-count]');
  for (const cell of cells) {
    if (cell.closest(EXCLUDED) || cell.matches('.blob-code-hunk') || cell.querySelector('.blob-code-hunk')) continue;
    if (!visible(cell)) { partial = true; continue; }
    const copy = cell.cloneNode(true) as Element;
    copy.querySelectorAll(EXCLUDED).forEach(element => element.remove());
    const text = (copy.textContent ?? '').replace(/\r\n?/g, '\n');
    const explicitMarker = cell.closest('[data-code-marker]')?.getAttribute('data-code-marker');
    const marker = explicitMarker === '+' || explicitMarker === '-' || explicitMarker === ' ' ? explicitMarker :
      cell.closest('.blob-code-addition') ? '+' : cell.closest('.blob-code-deletion') ? '-' :
        cell.closest('.blob-code-context') ? ' ' : '';
    if (marker === '+') additions += 1;
    if (marker === '-') deletions += 1;
    if (!marker || text.includes('\n')) partial = true;
    const number = lineNumber(cell);
    const line = `${number ? `[line ${number}] ` : ''}${marker}${text}`;
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
        const pr = getPullRequest(document.URL);
        const current = readFiles(document).find(current => current.path === file.path && current.anchor === file.anchor);
        if (document.URL.split('#')[0] !== route || !pr?.isFilesPage ||
          !isPullRequestView(document, pr) || !current) throw new Error(STALE_ERROR);
        const target = document.getElementById(file.anchor);
        if (!target) return;
        const path = renderedPath(target, file.anchor);
        if (path && path !== file.path) throw new Error(STALE_ERROR);
        if (!path || !visible(target)) return;
        const context = extract(target, current);
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
