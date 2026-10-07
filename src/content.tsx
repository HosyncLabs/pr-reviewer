import { createRoot, type Root } from 'react-dom/client';
import { getPullRequest, readFiles, readExpectedCount, isPullRequestView } from './github';
import { Panel, type Snapshot } from './Panel';
import { CONTENT_VERSION } from './ai-protocol';
import styles from './panel.css';

const HOST_ID = 'pr-reviewer-root';
let host: HTMLElement | null = null;
let root: Root | null = null;
let fileObserver: MutationObserver | null = null;
let themeObserver: MutationObserver | null = null;
let debounce: ReturnType<typeof setTimeout> | undefined;
let routeTimer: ReturnType<typeof setInterval> | undefined;
let lastRoute = '';
let signature = '';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function isolateTyping(event: KeyboardEvent) {
  const path = event.composedPath();
  const target = path[0];
  if (!host || !path.includes(host) || !(target instanceof HTMLElement) ||
    !target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  // GitHub sees the shadow host instead of the input, so its input guard misses typing.
  // Capture at window before its shortcut handlers, leaving native editing defaults intact.
  event.stopImmediatePropagation();
  if (event.type === 'keydown' && event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
    host.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Close panel"]')?.click();
  }
}

function updateTheme() {
  if (!host) return;
  const mode = document.documentElement.getAttribute('data-color-mode');
  host.dataset.theme = mode === 'dark' || (mode !== 'light' && media.matches) ? 'dark' : 'light';
}

function unmount() {
  fileObserver?.disconnect(); fileObserver = null;
  themeObserver?.disconnect(); themeObserver = null;
  media.removeEventListener('change', updateTheme);
  clearTimeout(debounce); debounce = undefined;
  root?.unmount(); root = null;
  host?.remove(); host = null;
  signature = '';
}

function mount() {
  if (host?.isConnected) return;
  if (root) unmount();
  // A repeated injection must never create a second panel or observer.
  if (document.getElementById(HOST_ID)) return;
  host = document.createElement('div'); host.id = HOST_ID;
  host.dataset.contentVersion = CONTENT_VERSION;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = styles;
  const container = document.createElement('div');
  shadow.append(style, container); document.body.append(host);
  root = createRoot(container);
  updateTheme();
  media.addEventListener('change', updateTheme);
  themeObserver = new MutationObserver(updateTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode', 'data-dark-theme', 'data-light-theme'] });
  fileObserver = new MutationObserver(records => {
    if (records.every(record => record.target === host || host?.contains(record.target))) return;
    scheduleRefresh();
  });
  fileObserver.observe(document.body, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['data-path', 'data-tagsearch-path', 'data-anchor', 'data-file-deleted', 'id', 'title', 'href', 'role', 'aria-expanded', 'aria-labelledby', 'initial-path'],
  });
}

function refresh() {
  if (!document.body) return;
  clearTimeout(debounce); debounce = undefined;
  lastRoute = location.pathname + location.search;
  const pr = getPullRequest(location.href);
  if (!pr) { unmount(); return; }
  mount();
  if (!root) return;
  const currentView = pr.isFilesPage && isPullRequestView(document, pr);
  const snapshot: Snapshot = { pr, files: currentView ? readFiles(document) : [], expected: currentView ? readExpectedCount(document) : null, comparison: lastRoute };
  const next = JSON.stringify(snapshot);
  if (next !== signature) {
    signature = next;
    root.render(<Panel key={pr.key} {...snapshot} />);
  }
}

function scheduleRefresh() {
  clearTimeout(debounce);
  debounce = setTimeout(refresh, 150);
}

function start() {
  if (routeTimer) return;
  refresh();
  // ponytail: isolated content scripts cannot intercept GitHub's History API;
  // a URL-only fallback catches SPA navigation without touching GitHub scripts.
  routeTimer = setInterval(() => { if (lastRoute !== location.pathname + location.search) refresh(); }, 750);
}

function stop() {
  clearInterval(routeTimer); routeTimer = undefined;
  unmount();
}

for (const event of ['turbo:load', 'turbo:render', 'pjax:end']) document.addEventListener(event, scheduleRefresh);
for (const event of ['keydown', 'keypress', 'keyup'] as const) window.addEventListener(event, isolateTyping, true);
window.addEventListener('popstate', scheduleRefresh);
window.addEventListener('pagehide', stop);
window.addEventListener('pageshow', start);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
