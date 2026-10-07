import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  CATEGORY_LABELS, CATEGORY_ORDER, classifyFile, classifyImplementation, getBackendModule, getFrontendModule, getPackageModule,
  IMPLEMENTATION_GROUP_LABELS, IMPLEMENTATION_GROUP_ORDER, type Category, type ImplementationGroup,
} from './classifier';
import { navigateToFile, type PullRequest, type PullRequestFile } from './github';
import { loadPreferences, saveOverride, saveImplementationOverride, subscribePreferences, type RepositoryPreferences } from './storage';
import { AiReview } from './AiReview';
import type { AIStatus } from './ai-protocol';

export type Snapshot = { pr: PullRequest; files: PullRequestFile[]; expected: number | null; comparison: string };
const symbols = { documentation: '▤', implementation: '〈〉', migrations: '▦', tests: '✓' };
const heatLabels = { hot: 'Very high: more than 500 changes', warm: 'High: 251–500 changes', mild: 'Medium: 101–250 changes', cool: 'Low: 1–100 changes' };

function moduleLabel(module: string): string {
  if (!module) return 'General';
  const parts = module.split('/');
  const packageRoot = parts.findIndex(part => part.toLowerCase() === 'packages');
  if (packageRoot !== -1 && parts[packageRoot + 1]) return parts.slice(packageRoot + 1).join('/');
  return parts.map(part => part === 'api' ? 'API' : part === 'db' ? 'DB' :
    /^v\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1).replaceAll('-', ' ')).join(' › ');
}

export function Panel({ pr, files, expected, comparison }: Snapshot) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [preferences, setPreferences] = useState<RepositoryPreferences>({ overrides: {}, implementationOverrides: {}, rules: [] });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<'files' | 'ai'>('files');
  const [selection, setSelection] = useState(0);
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null);
  const selectedRef = useRef('');
  const navigation = useRef<{ path: string; controller: AbortController } | null>(null);
  const aiStatusRef = useRef(aiStatus);
  aiStatusRef.current = aiStatus;
  const openAutomaticReview = useCallback(() => setView('ai'), []);
  const launcher = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const repository = `${pr.owner}/${pr.repo}`;

  useEffect(() => {
    let active = true;
    const sync = () => {
      loadPreferences(repository).then(value => { if (active) { setPreferences(value); setReady(true); } })
        .catch(() => { if (active) { setReady(true); setError('Could not load your local preferences.'); } });
    };
    sync();
    const unsubscribe = subscribePreferences(repository, sync);
    return () => { active = false; unsubscribe(); };
  }, [repository]);
  useEffect(() => { if (open && view === 'files') search.current?.focus(); }, [open, pr.isFilesPage, view]);
  const selectFile = useCallback((file: PullRequestFile) => {
    if (navigation.current && navigation.current.path !== file.path) navigation.current.controller.abort();
    if (selectedRef.current !== file.path) {
      selectedRef.current = file.path;
      setSelected(file.path); setSelection(value => value + 1);
    }
    if (aiStatusRef.current?.configured && aiStatusRef.current.enabled) setView('ai');
  }, []);
  useEffect(() => () => navigation.current?.controller.abort(), [comparison]);
  useEffect(() => {
    if (!pr.isFilesPage) { selectedRef.current = ''; setSelected(''); setView('files'); return; }
    const fromHash = () => {
      const file = files.find(candidate => location.hash === `#${candidate.anchor}`);
      if (file) selectFile(file);
    };
    const clicked = (event: globalThis.MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>('a[href]');
      if (!link) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return;
      const file = files.find(candidate => url.hash === `#${candidate.anchor}`);
      if (file) selectFile(file);
    };
    fromHash();
    document.addEventListener('click', clicked, true);
    window.addEventListener('hashchange', fromHash);
    return () => { document.removeEventListener('click', clicked, true); window.removeEventListener('hashchange', fromHash); };
  }, [files, pr.isFilesPage, comparison, selectFile]);

  const categorized = files.map(file => {
    const implementationGroup = classifyImplementation(file.path, preferences.implementationOverrides);
    const changes = file.additions !== undefined && file.deletions !== undefined ? file.additions + file.deletions : null;
    const heat: keyof typeof heatLabels | undefined = changes !== null && changes > 0 ? changes > 500 ? 'hot' : changes > 250 ? 'warm' : changes > 100 ? 'mild' : 'cool' : undefined;
    return {
      ...file,
      category: classifyFile(file.path, preferences.overrides, preferences.rules),
      implementationGroup,
      module: getPackageModule(file.path) || (implementationGroup === 'frontend' ? getFrontendModule(file.path) : implementationGroup === 'backend' ? getBackendModule(file.path) : ''),
      changes,
      heat,
    };
  }).sort((a, b) => (b.changes ?? -1) - (a.changes ?? -1) || a.path.localeCompare(b.path));
  const visible = categorized.filter(file => (filter === 'all' || file.category === filter) && file.path.toLowerCase().includes(query.trim().toLowerCase()));
  const close = () => { setOpen(false); launcher.current?.focus(); };
  const navigate = async (event: MouseEvent<HTMLAnchorElement>, file: PullRequestFile) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    const link = event.currentTarget;
    navigation.current?.controller.abort();
    const current = { path: file.path, controller: new AbortController() };
    navigation.current = current;
    const found = await navigateToFile(file, document, current.controller.signal);
    if (current.controller.signal.aborted) return;
    if (navigation.current === current) navigation.current = null;
    if (found) {
      selectFile(file);
      if (!aiStatusRef.current?.enabled) link.focus({ preventScroll: true });
    }
    else setError('This diff is unavailable in the current view. Check GitHub filters or load the remaining files.');
  };
  const correct = async (path: string, category: Category | null) => {
    setSaving(true); setError('');
    try { setPreferences(await saveOverride(repository, path, category)); }
    catch { setError('Could not save the category. Please try again.'); }
    finally { setSaving(false); }
  };
  const correctImplementation = async (path: string, group: ImplementationGroup | null) => {
    setSaving(true); setError('');
    try { setPreferences(await saveImplementationOverride(repository, path, group)); }
    catch { setError('Could not save the subcategory. Please try again.'); }
    finally { setSaving(false); }
  };
  const incomplete = expected !== null && files.length < expected;

  const renderFiles = (group: typeof categorized) => <ul>{group.map(file => {
    const separator = file.path.lastIndexOf('/');
    const manual = Object.hasOwn(preferences.overrides, file.path);
    const manualGroup = file.category === 'implementation' && Object.hasOwn(preferences.implementationOverrides, file.path);
    const heatLabel = file.heat ? heatLabels[file.heat] : undefined;
    return <li key={file.path} className={selected === file.path ? 'selected' : ''} data-heat={file.heat}>
      <a className="file-link" href={`#${file.anchor}`} title={file.path} onClick={event => navigate(event, file)}>
        <span className="file-icon" aria-hidden="true">▱</span><span className="file-copy"><span className="file-name">{file.path.slice(separator + 1)}</span><span className="file-directory">{separator >= 0 ? file.path.slice(0, separator) : 'Repository root'}{file.deleted ? ' · Deleted' : ''}</span>
          {file.changes !== null ? <span className="file-changes" aria-label={`${file.additions} lines added and ${file.deletions} deleted, ${file.changes} changes`}><span className="additions">+{file.additions}</span><span className="deletions">−{file.deletions}</span><span className="change-total" title={heatLabel}>· {file.changes} changes</span></span> : <span className="file-changes" title="GitHub does not expose statistics for this file">No statistics</span>}
        </span><span className="file-arrow" aria-hidden="true">↗</span>
      </a>
      <details className="correction"><summary>{manual ? 'Manual category' : manualGroup ? 'Manual subcategory' : 'Adjust category'}</summary>
        <label>Category for {file.path}<select aria-label={`Category for ${file.path}`} disabled={!ready || saving} value={preferences.overrides[file.path] ?? 'auto'} onChange={event => void correct(file.path, event.target.value === 'auto' ? null : event.target.value as Category)}><option value="auto">Automatic ({CATEGORY_LABELS[classifyFile(file.path, {}, preferences.rules)]})</option>{CATEGORY_ORDER.map(value => <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>)}</select></label>
        {file.category === 'implementation' && <label>Subcategory for {file.path}<select aria-label={`Subcategory for ${file.path}`} disabled={!ready || saving} value={preferences.implementationOverrides[file.path] ?? 'auto'} onChange={event => void correctImplementation(file.path, event.target.value === 'auto' ? null : event.target.value as ImplementationGroup)}><option value="auto">Automatic ({IMPLEMENTATION_GROUP_LABELS[classifyImplementation(file.path)]})</option>{IMPLEMENTATION_GROUP_ORDER.map(value => <option key={value} value={value}>{IMPLEMENTATION_GROUP_LABELS[value]}</option>)}</select></label>}
      </details>
    </li>;
  })}</ul>;

  const renderImplementation = (group: typeof categorized) => <div className="implementation-subgroups">
    {IMPLEMENTATION_GROUP_ORDER.map(subcategory => {
      const all = categorized.filter(file => file.category === 'implementation' && file.implementationGroup === subcategory);
      if (!all.length) return null;
      const subset = group.filter(file => file.implementationGroup === subcategory);
      if (!subset.length && query.trim()) return null;
      return <details className="implementation-subgroup" data-group={subcategory} key={subcategory} open>
        <summary><span>{IMPLEMENTATION_GROUP_LABELS[subcategory]}</span><span className="group-count">{query.trim() ? `${subset.length}/${all.length}` : all.length}</span><span className="chevron" aria-hidden="true">⌄</span></summary>
        {subcategory === 'backend' || subcategory === 'frontend' || all.some(file => file.module) ? [...new Set(all.map(file => file.module))].sort().map(module => {
          const moduleFiles = subset.filter(file => file.module === module);
          if (!moduleFiles.length) return null;
          const moduleTotal = all.filter(file => file.module === module).length;
          return <details className="implementation-module" data-module={module} key={module} open>
            <summary><span>{moduleLabel(module)}</span><span className="group-count">{query.trim() ? `${moduleFiles.length}/${moduleTotal}` : moduleTotal}</span><span className="chevron" aria-hidden="true">⌄</span></summary>
            {renderFiles(moduleFiles)}
          </details>;
        }) : renderFiles(subset)}
      </details>;
    })}
  </div>;

  return <div lang="en" onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); close(); } }}>
    <button ref={launcher} className="launcher" aria-expanded={open} aria-controls="pr-reviewer-panel" onClick={() => setOpen(!open)}>
      <span className="brand-mark" aria-hidden="true">▥</span> Organize PR <span className="launcher-count">{files.length}</span>
    </button>
    {open && <aside id="pr-reviewer-panel" className="panel" aria-label="Pull request organizer">
      <header className="brand-bar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">▥</span> PR Reviewer <span className="local-badge">LOCAL</span></div>
        <button className="ai-settings-button" hidden={view === 'ai'} onClick={() => {
          void chrome.runtime.sendMessage({ type: 'ai-open-settings' }).then(response => {
            if (!response?.ok) setError('Could not open AI settings. Reload the GitHub tab and try again.');
          }).catch(() => setError('Could not open AI settings. Reload the GitHub tab and try again.'));
        }}>AI settings</button>
        <button className="icon-button" aria-label="Close panel" onClick={close}>×</button>
      </header>
      {pr.isFilesPage && <nav className="panel-views" aria-label="Panel view"><button aria-pressed={view === 'files'} onClick={() => setView('files')}>Files</button><button aria-pressed={view === 'ai'} onClick={() => setView('ai')}>AI review</button></nav>}
      <div className="intro" hidden={view === 'ai'}>
        <div className="repo-line"><span title={repository}>{repository}</span><span className="pr-number">#{pr.number}</span></div>
        <h1>Files, organized.</h1>
        <p>Find your starting point. Review on GitHub.</p>
      </div>
      {!pr.isFilesPage ? <div className="empty-page"><span className="empty-icon" aria-hidden="true">▤</span><h2>Open the PR changes</h2><p>We'll group the files GitHub has loaded there.</p><a className="primary-link" href={pr.filesUrl}>Go to Files changed <span aria-hidden="true">↗</span></a></div> : <>
        <div className="tools" hidden={view === 'ai'}>
          <label className="search"><span aria-hidden="true">⌕</span><input ref={search} type="search" aria-label="Search files" placeholder="Search by name or path…" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className="filters" role="group" aria-label="Filter by category">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All</button>
            {CATEGORY_ORDER.map(category => <button key={category} aria-pressed={filter === category} onClick={() => setFilter(filter === category ? 'all' : category)}>{category === 'documentation' ? 'Docs' : CATEGORY_LABELS[category]}</button>)}
          </div>
          <p className="sort-hint">Largest changes first · lines added + deleted</p>
          <p className="heat-legend" aria-label="Change volume temperature">Temperature: {Object.entries(heatLabels).map(([heat, label]) => <span key={heat} data-heat={heat} title={label}>{heat === 'hot' ? '>500' : heat === 'warm' ? '251–500' : heat === 'mild' ? '101–250' : '1–100'}</span>)}</p>
        </div>
        <div className="inventory-status" role="status" hidden={view === 'ai'}><span>{visible.length} of {files.length} files detected</span><span className="status-dot" aria-hidden="true" /> <span>{!files.length ? 'Waiting for diffs' : incomplete ? 'Partial' : 'Updated'}</span></div>
        {incomplete && <div className="notice" hidden={view === 'ai'}>GitHub exposes {files.length} of {expected} files in this view. Check the filters or wait for loading to finish.</div>}
        <div className="groups" hidden={view === 'ai'}>
          {CATEGORY_ORDER.filter(category => filter === 'all' || filter === category).map(category => {
            const group = visible.filter(file => file.category === category);
            const total = categorized.filter(file => file.category === category).length;
            return <details className={`group ${category}`} key={category} open>
              <summary><span className="category-symbol" aria-hidden="true">{symbols[category]}</span><span>{CATEGORY_LABELS[category]}</span><span className="group-count">{query.trim() ? `${group.length}/${total}` : total}</span><span className="chevron" aria-hidden="true">⌄</span></summary>
              {group.length ? category === 'implementation' ? renderImplementation(group) : renderFiles(group) : <p className="group-empty">{query || filter !== 'all' ? 'No matches.' : 'No files detected in this group.'}</p>}
            </details>;
          })}
          {!files.length && <p className="no-files">Wait for GitHub to load the diffs. If none appear, return to the original view and check GitHub filters.</p>}
        </div>
        <AiReview file={files.find(file => file.path === selected)} selection={selection} comparison={comparison} visible={view === 'ai'} onAutomatic={openAutomaticReview} onStatus={setAIStatus} />
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer><div className="privacy"><span aria-hidden="true">◉</span> Local grouping · OpenAI review optional</div><button className="return-button" onClick={close}>Return to original view <span aria-hidden="true">↗</span></button></footer>
    </aside>}
  </div>;
}
