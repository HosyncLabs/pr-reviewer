import type { AIReviewLine } from './ai-protocol';
import { getPullRequest, isPullRequestView, navigateToFile, readFiles, type PullRequestFile } from './github';
import { findReviewLine } from './review-context';

export function reviewLineHash(file: PullRequestFile, reference: AIReviewLine): string {
  if (!file || !/^diff-(?:[a-f\d]{32}|[a-f\d]{64})$/i.test(file.anchor) ||
    !reference || reference.side !== 'left' && reference.side !== 'right' ||
    !Number.isSafeInteger(reference.line) || reference.line <= 0) {
    throw new RangeError('Invalid review line reference.');
  }
  return `#${file.anchor}${reference.side === 'left' ? 'L' : 'R'}${reference.line}`;
}

export async function navigateToReviewLine(
  file: PullRequestFile,
  reference: AIReviewLine,
  document: Document = globalThis.document,
  signal?: AbortSignal,
): Promise<boolean> {
  let hash: string;
  try { hash = reviewLineHash(file, reference); } catch { return false; }
  const window = document.defaultView;
  const route = document.URL.split('#')[0];
  const pr = getPullRequest(route);
  if (!window || !pr?.isFilesPage) return false;
  const deadline = Date.now() + 5_000;
  const current = () => !signal?.aborted && document.URL.split('#')[0] === route &&
    isPullRequestView(document, pr) &&
    readFiles(document).some(candidate => candidate.path === file.path && candidate.anchor === file.anchor);
  const jump = (line: HTMLElement) => {
    if (!current() || !line.isConnected || line.ownerDocument !== document) return false;
    try {
      line.scrollIntoView({ block: 'center', behavior: 'auto' });
      if (!current()) return false;
      window.history.pushState(window.history.state, '', hash);
      return true;
    } catch { return false; }
  };
  if (!current()) return false;
  const initial = findReviewLine(file, reference, document);
  if (initial) return jump(initial);

  // The native tree mounts virtualized files and expands their folder ancestors.
  try { await navigateToFile(file, document, signal); } catch { return false; }
  if (!current() || Date.now() >= deadline) return false;
  return new Promise(resolve => {
    let finished = false;
    const finish = (found: boolean) => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve(found);
    };
    const abort = () => finish(false);
    const check = () => {
      if (!current()) { finish(false); return; }
      const line = findReviewLine(file, reference, document);
      if (line) finish(jump(line));
    };
    const observer = new window.MutationObserver(check);
    const poll = setInterval(check, 100);
    const timeout = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
    observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true });
    signal?.addEventListener('abort', abort, { once: true });
    check();
  });
}
