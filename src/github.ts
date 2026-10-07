export type PullRequest = {
  owner: string;
  repo: string;
  number: number;
  key: string;
  filesUrl: string;
  isFilesPage: boolean;
};

export type PullRequestFile = {
  path: string;
  anchor: string;
  deleted: boolean;
  additions?: number;
  deletions?: number;
};

const diffAnchor = /^diff-(?:[a-f\d]{32}|[a-f\d]{64})$/i;

export function getPullRequest(url: string): PullRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://github.com') return null;

  const match = parsed.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/(files|changes|commits|checks)(?:\/[^/]+)?)?\/?$/,
  );
  if (!match) return null;
  const [, owner, repo, rawNumber, section] = match;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number)) return null;

  return {
    owner,
    repo,
    number,
    key: `${owner}/${repo}#${number}`.toLowerCase(),
    filesUrl: `https://github.com/${owner}/${repo}/pull/${number}/${section === 'changes' ? 'changes' : 'files'}`,
    isFilesPage: section === 'files' || section === 'changes',
  };
}

export function isPullRequestView(document: Document, pr: PullRequest): boolean {
  const counterLink = document.getElementById('files_tab_counter')?.closest('a');
  const tabs = [...document.querySelectorAll<HTMLAnchorElement>('a.tabnav-tab[href], a[role="tab"][href], a#prs-files-anchor-tab[href]')]
    .filter((tab) => /\/(?:files|changes)\/?(?:[?#].*)?$/.test(tab.href));
  if (counterLink) tabs.push(counterLink);
  if (tabs.length) return tabs.every((tab) => getPullRequest(tab.href)?.key === pr.key);

  const url = document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.content;
  return !!url && getPullRequest(url)?.key === pr.key;
}

function regionHeaderLink(region: Element): HTMLAnchorElement | null {
  if (region.getAttribute('role') !== 'region' || !diffAnchor.test(region.id)) return null;
  const label = region.getAttribute('aria-labelledby');
  const heading = label ? region.ownerDocument.getElementById(label) : null;
  if (heading?.tagName !== 'H3' || !region.contains(heading)) return null;
  return [...heading.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
    (link) => link.getAttribute('href') === `#${region.id}` && link.querySelector('code'),
  ) ?? null;
}

function fileTreeLinks(document: Document): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('[role="tree"] a[href^="#diff-"]')]
    .filter(link => {
      const item = link.closest('[role="treeitem"]');
      return !!item?.id && !item.hasAttribute('aria-expanded') &&
        diffAnchor.test(link.getAttribute('href')!.slice(1));
    });
}

function embeddedFiles(document: Document): PullRequestFile[] {
  const currentUrl = new URL(document.URL);
  const pr = getPullRequest(currentUrl.href);
  if (!pr?.isFilesPage) return [];

  for (const app of document.querySelectorAll('react-app[app-name="repo"][initial-path]')) {
    try {
      const initialUrl = new URL(app.getAttribute('initial-path')!, currentUrl);
      if (initialUrl.origin !== currentUrl.origin || initialUrl.pathname !== currentUrl.pathname ||
        initialUrl.search !== currentUrl.search) continue;
      const script = app.querySelector('script[type="application/json"][data-target="react-app.embeddedData"]');
      const route = JSON.parse(script?.textContent ?? '').payload?.pullRequestsChangesRoute;
      if (typeof route?.pullRequestUrl !== 'string' ||
        getPullRequest(route.pullRequestUrl)?.key !== pr.key || !Array.isArray(route.diffSummaries)) continue;

      return route.diffSummaries.flatMap((summary: unknown) => {
        if (!summary || typeof summary !== 'object') return [];
        const { path, pathDigest, changeType, linesAdded, linesDeleted } = summary as Record<string, unknown>;
        if (typeof path !== 'string' || !path.trim() || typeof pathDigest !== 'string' ||
          !diffAnchor.test(`diff-${pathDigest}`)) return [];
        const file: PullRequestFile = { path, anchor: `diff-${pathDigest}`, deleted: changeType === 'DELETED' };
        if (typeof linesAdded === 'number' && Number.isSafeInteger(linesAdded) && linesAdded >= 0 &&
          typeof linesDeleted === 'number' && Number.isSafeInteger(linesDeleted) && linesDeleted >= 0) {
          file.additions = linesAdded;
          file.deletions = linesDeleted;
        }
        return [file];
      });
    } catch {
      // The app can be loading or hold metadata for a previous SPA route.
    }
  }
  return [];
}

export function readFiles(document: Document): PullRequestFile[] {
  const files = new Map(embeddedFiles(document).map(file => [file.path, file]));
  // Route summaries survive collapsed folders and virtualized diff regions.
  // The native tree is the fallback when embedded metadata is unavailable.
  // The row ID is the full path; the visible link label is only a basename.
  for (const link of fileTreeLinks(document)) {
    const path = link.closest('[role="treeitem"]')!.id;
    if (!files.has(path)) files.set(path, { path, anchor: link.getAttribute('href')!.slice(1), deleted: false });
  }
  const candidates = document.querySelectorAll<HTMLElement>(
    '[data-tagsearch-path][id], .file-header[data-path], [data-path][data-anchor], [role="region"][id^="diff-"]',
  );

  for (const element of candidates) {
    const path = element.getAttribute('data-tagsearch-path') ?? element.getAttribute('data-path') ??
      regionHeaderLink(element)?.querySelector('code')?.textContent?.replace(/^[\t\n\r ]*\u200e|\u200e[\t\n\r ]*$/g, '');
    const anchor = (
      element.getAttribute('data-anchor') ?? element.closest('[id^="diff-"]')?.id ?? ''
    ).replace(/^#/, '');
    if (!path || !diffAnchor.test(anchor)) continue;
    const current = files.get(path);
    if (current && current.anchor !== anchor) continue;
    files.set(path, {
      ...current,
      path,
      anchor,
      deleted: !!current?.deleted || element.closest('[data-file-deleted]')?.getAttribute('data-file-deleted') === 'true',
    });
  }

  return [...files.values()];
}

export function readExpectedCount(document: Document): number | null {
  const counter = document.getElementById('files_tab_counter') ??
    document.querySelector('#prs-files-anchor-tab [data-component="CounterLabel"]');
  for (const value of [counter?.getAttribute('title'), counter?.textContent]) {
    const formatted = value?.trim();
    if (!formatted || !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(formatted)) continue;
    const count = Number(formatted.replaceAll(',', ''));
    if (Number.isSafeInteger(count)) return count;
  }
  return null;
}

export async function navigateToFile(file: PullRequestFile, document: Document = globalThis.document, signal?: AbortSignal): Promise<boolean> {
  const route = document.URL.split('#')[0];
  const expanded = new Set<string>();
  for (let attempt = 0; attempt <= file.path.split('/').length; attempt += 1) {
    if (signal?.aborted || document.URL.split('#')[0] !== route ||
      !readFiles(document).some(current => current.path === file.path && current.anchor === file.anchor)) return false;
    const treeLink = fileTreeLinks(document).find(link =>
      link.closest('[role="treeitem"]')!.id === file.path && link.getAttribute('href') === `#${file.anchor}`,
    );
    if (treeLink) {
      // The native tree handler renders a virtualized diff before scrolling to it.
      treeLink.closest<HTMLElement>('[role="treeitem"]')!.focus({ preventScroll: true });
      if (signal?.aborted || document.URL.split('#')[0] !== route) return false;
      treeLink.click();
      return true;
    }
    const folder = [...document.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"][id][aria-expanded="false"]')]
      .filter(item => item.id && file.path.startsWith(`${item.id}/`) && !expanded.has(item.id))
      .sort((a, b) => a.id.length - b.id.length)[0];
    const toggle = folder && [...folder.querySelectorAll<HTMLElement>('.PRIVATE_TreeView-item-toggle')]
      .find(item => item.closest('[role="treeitem"]') === folder);
    if (!toggle) break;
    expanded.add(folder!.id);
    if (signal?.aborted) return false;
    toggle.click();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (signal?.aborted) return false;
  }
  if (signal?.aborted || document.URL.split('#')[0] !== route ||
    !readFiles(document).some(current => current.path === file.path && current.anchor === file.anchor)) return false;
  const target = document.getElementById(file.anchor);
  if (!target) return false;
  if (typeof target.checkVisibility === 'function') {
    if (!target.checkVisibility({ visibilityProperty: true })) return false;
  } else {
    for (let element: HTMLElement | null = target; element; element = element.parentElement) {
      const style = document.defaultView?.getComputedStyle(element);
      if (element.hasAttribute('hidden') || style?.display === 'none' ||
        style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    }
  }
  const link = [...target.querySelectorAll<HTMLAnchorElement>('a[href]')].find(
    (candidate) =>
      candidate.getAttribute('href') === `#${file.anchor}` &&
      (candidate.closest('.file-header, [data-path][data-anchor]') || candidate.title === file.path),
  ) ?? regionHeaderLink(target);
  if (link) {
    link.focus({ preventScroll: true });
    if (signal?.aborted || document.URL.split('#')[0] !== route) return false;
    link.click();
  }
  else {
    if (signal?.aborted || document.URL.split('#')[0] !== route) return false;
    target.scrollIntoView({ block: 'start' });
  }
  return true;
}
