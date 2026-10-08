import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import {
  CATEGORY_LABELS, CATEGORY_ORDER, classifyFile, classifyImplementation, getBackendModule, getFrontendModule, getPackageModule,
  IMPLEMENTATION_GROUP_LABELS, IMPLEMENTATION_GROUP_ORDER, type Category, type ImplementationGroup,
} from './classifier';
import { navigateToFile, type PullRequest, type PullRequestFile } from './github';
import { loadPreferences, saveOverride, saveImplementationOverride, subscribePreferences, type RepositoryPreferences } from './storage';
import { DEFAULT_WORKFLOW, EMPTY_PROGRESS, PROGRESS_NOTICE, riskFor, emptyFileProgress, sameDiffRevision, type ReviewProgress } from './workflow';
import { collectProgressRevision, readHeadRevision, syncGitHubViewed } from './review-context';
import { AiReview } from './AiReview';
import { CONTENT_VERSION, EXTENSION_RELOAD_NOTICE, sendExtensionMessage, type AIStatus, type ExtensionRequest } from './ai-protocol';

export type Snapshot = { pr: PullRequest; files: PullRequestFile[]; expected: number | null; comparison: string; headRevision?: string };
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

export function Panel({ pr, files, expected, comparison, headRevision = '' }: Snapshot) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Category | 'all'>('all');
  const [preferences, setPreferences] = useState<RepositoryPreferences>({ overrides: {}, implementationOverrides: {}, rules: [] });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<'files' | 'ai'>('files');
  const [selection, setSelection] = useState(0);
  const [progress, setProgress] = useState<ReviewProgress>(EMPTY_PROGRESS);
  const progressRef = useRef(progress); progressRef.current = progress;
  const [note, setNote] = useState('');
  const noteDirty = useRef(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [aiStatus, setAIStatus] = useState<AIStatus | null>(null);
  const selectedRef = useRef('');
  const navigation = useRef<{ path: string; controller: AbortController } | null>(null);
  const aiStatusRef = useRef(aiStatus);
  aiStatusRef.current = aiStatus;
  const openAutomaticReview = useCallback(() => setView('ai'), []);
  const launcher = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const observedHead = headRevision || readHeadRevision();
  const reviewedFile = (path: string) => { const record = progress.files[path]; return !!record?.reviewed && (!observedHead || record.revision.startsWith(observedHead + ':')); };
  const options = aiStatus?.options ?? DEFAULT_WORKFLOW;
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
  useEffect(() => {
    let active = true;
    void sendExtensionMessage({ type: 'ai-status' }).then(response => { if (active && response.ok && response.status) setAIStatus(response.status); }).catch(() => {});
    const sync = () => { void sendExtensionMessage({ type: 'progress-load' }).then(response => { if (active && response.ok && response.progress) setProgress(response.progress); }).catch(() => {}); };
    if (options.persistProgress) sync();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'session' && (changes[PROGRESS_NOTICE]?.newValue as { scope?: string } | undefined)?.scope === `${pr.key}:${comparison}` && options.persistProgress) sync(); };
    chrome.storage.onChanged.addListener(changed);
    return () => { active = false; chrome.storage.onChanged.removeListener(changed); };
  }, [comparison, options.persistProgress]);
  useEffect(() => { progressRef.current = EMPTY_PROGRESS; setProgress(EMPTY_PROGRESS); setNote(''); noteDirty.current = false; }, [comparison]);
  const saveProgress = useCallback(async (update: Omit<Extract<ExtensionRequest, { type: 'progress-save' }>, 'type'>) => {
    if (comparison !== location.pathname + location.search) return;
    const current = progressRef.current;
    let file = current.files[update.path] ?? emptyFileProgress();
    if (update.revision && file.revision !== update.revision) file = sameDiffRevision(file.revision, update.revision) ? { ...file, revision: update.revision } : { ...emptyFileProgress(update.revision), note: file.note };
    file = { ...file, blocks: { ...file.blocks }, checks: { ...file.checks } };
    if (update.reviewed !== undefined) file.reviewed = update.reviewed;
    if (update.note !== undefined) file.note = update.note;
    if (update.block) { if (update.block.state) file.blocks[update.block.key] = update.block.state; else delete file.blocks[update.block.key]; }
    if (update.check) file.checks[update.check.key] = update.check.checked;
    const next = { files: { ...current.files, [update.path]: file }, lastFile: update.lastFile ? update.path : current.lastFile };
    progressRef.current = next; setProgress(next);
    if (aiStatusRef.current?.options?.persistProgress === false) return;
    try {
      const response = await sendExtensionMessage({ type: 'progress-save', ...update });
      if (!response.ok) throw new Error(response.error);
    } catch { setError('Could not save progress. Your changes are kept in this tab.'); }
  }, [comparison]);
  useEffect(() => {
    noteDirty.current = false; setNote(progressRef.current.files[selected]?.note ?? '');
  }, [selected, comparison]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const file = files.find(file => file.path === selected);
    if (file) void collectProgressRevision(file, document, controller.signal).then(async revision => {
      if (!controller.signal.aborted) await saveProgress({ path: file.path, revision, lastFile: true });
    }).catch(() => {});
    return () => controller.abort();
  }, [selected, comparison, observedHead, saveProgress]);
  useEffect(() => { if (!noteDirty.current) setNote(progress.files[selected]?.note ?? ''); }, [selected, progress.files[selected]?.note]);
  useEffect(() => {
    if (!selected || !noteDirty.current) return;
    const timeout = setTimeout(() => { void saveProgress({ path: selected, note }); }, 400);
    return () => clearTimeout(timeout);
  }, [note, selected, saveProgress]);
  useLayoutEffect(() => {
    if (open && collapsed) expandButton.current?.focus();
    else if (open && wasOpen.current) collapseButton.current?.focus();
    else if (!open && wasOpen.current) launcher.current?.focus();
    wasOpen.current = open;
  }, [open, collapsed]);
  useEffect(() => { if (open && !collapsed && view === 'files') search.current?.focus(); }, [open, collapsed, pr.isFilesPage, view]);
  const selectFile = useCallback((file: PullRequestFile) => {
    if (navigation.current && navigation.current.path !== file.path) navigation.current.controller.abort();
    if (selectedRef.current !== file.path) {
      selectedRef.current = file.path;
      setSelected(file.path); setSelection(value => value + 1);
    }
    if (aiStatusRef.current?.configured && aiStatusRef.current.enabled && aiStatusRef.current.options?.automatic !== false) setView('ai');
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
      risk: file.deleted ? { score: 3, labels: ['File deletion', ...riskFor(file.path).labels] } : riskFor(file.path),
      changes,
      heat,
    };
  }).sort((a, b) => (options.riskPriority ? b.risk.score - a.risk.score : 0) || (b.changes ?? -1) - (a.changes ?? -1) || a.path.localeCompare(b.path));
  const maxRisk = (group: typeof categorized) => Math.max(0, ...group.map(file => file.risk.score));
  const categoryOrder = [...CATEGORY_ORDER].sort((a, b) => options.riskPriority ? maxRisk(categorized.filter(file => file.category === b)) - maxRisk(categorized.filter(file => file.category === a)) : 0);
  const implementationOrder = [...IMPLEMENTATION_GROUP_ORDER].sort((a, b) => options.riskPriority ? maxRisk(categorized.filter(file => file.implementationGroup === b)) - maxRisk(categorized.filter(file => file.implementationGroup === a)) : 0);
  const visible = categorized.filter(file => (filter === 'all' || file.category === filter) && file.path.toLowerCase().includes(query.trim().toLowerCase()) && (!pendingOnly || !reviewedFile(file.path)));
  const close = () => { setOpen(false); setCollapsed(false); };
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
  const goTo = async (file: PullRequestFile) => {
    navigation.current?.controller.abort();
    const current = { path: file.path, controller: new AbortController() }; navigation.current = current;
    if (await navigateToFile(file, document, current.controller.signal) && !current.controller.signal.aborted) selectFile(file);
    else if (!current.controller.signal.aborted) setError('This diff is unavailable. Load it in GitHub first.');
  };
  const markFile = async (file: PullRequestFile) => {
    const reviewed = !reviewedFile(file.path);
    if (reviewed) {
      const controller = new AbortController(); navigation.current?.controller.abort(); navigation.current = { path: file.path, controller };
      try {
        if (!await navigateToFile(file, document, controller.signal)) throw new Error('Diff unavailable');
        const revision = await collectProgressRevision(file, document, controller.signal);
        if (controller.signal.aborted) return;
        await saveProgress({ path: file.path, revision, reviewed: true });
      } catch { setError('Load this file’s diff before marking it reviewed.'); return; }
    } else await saveProgress({ path: file.path, reviewed: false });
    if (options.syncViewed) {
      const controller = new AbortController(); navigation.current?.controller.abort(); navigation.current = { path: file.path, controller };
      try { if (!await syncGitHubViewed(file, reviewed, controller.signal)) setError('Local progress saved. GitHub’s Viewed control is unavailable for this file.'); }
      catch { setError('Local progress saved. Could not update GitHub Viewed.'); }
    }
  };
  const nextPending = () => {
    const start = categorized.findIndex(file => file.path === selected);
    const next = [...categorized.slice(start + 1), ...categorized.slice(0, start + 1)].find(file => !reviewedFile(file.path));
    if (next) void goTo(next);
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
        {options.riskPriority && file.risk.labels.length > 0 && <span className="risk-label" title="Sensitive path heuristic; not an AI finding">{file.risk.labels.join(' · ')}</span>}
        </span><span className="file-arrow" aria-hidden="true">↗</span>
      </a>
      {options.nextPending && <button className="file-reviewed" aria-pressed={!!reviewedFile(file.path)} onClick={() => void markFile(file)}>{reviewedFile(file.path) ? '✓ File reviewed' : 'Mark file reviewed'}</button>}
      <details className="correction"><summary>{manual ? 'Manual category' : manualGroup ? 'Manual subcategory' : 'Adjust category'}</summary>
        <label>Category for {file.path}<select aria-label={`Category for ${file.path}`} disabled={!ready || saving} value={preferences.overrides[file.path] ?? 'auto'} onChange={event => void correct(file.path, event.target.value === 'auto' ? null : event.target.value as Category)}><option value="auto">Automatic ({CATEGORY_LABELS[classifyFile(file.path, {}, preferences.rules)]})</option>{CATEGORY_ORDER.map(value => <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>)}</select></label>
        {file.category === 'implementation' && <label>Subcategory for {file.path}<select aria-label={`Subcategory for ${file.path}`} disabled={!ready || saving} value={preferences.implementationOverrides[file.path] ?? 'auto'} onChange={event => void correctImplementation(file.path, event.target.value === 'auto' ? null : event.target.value as ImplementationGroup)}><option value="auto">Automatic ({IMPLEMENTATION_GROUP_LABELS[classifyImplementation(file.path)]})</option>{IMPLEMENTATION_GROUP_ORDER.map(value => <option key={value} value={value}>{IMPLEMENTATION_GROUP_LABELS[value]}</option>)}</select></label>}
      </details>
    </li>;
  })}</ul>;

  const renderImplementation = (group: typeof categorized) => <div className="implementation-subgroups">
    {implementationOrder.map(subcategory => {
      const all = categorized.filter(file => file.category === 'implementation' && file.implementationGroup === subcategory);
      if (!all.length) return null;
      const subset = group.filter(file => file.implementationGroup === subcategory);
      if (!subset.length && query.trim()) return null;
      return <details className="implementation-subgroup" data-group={subcategory} key={subcategory} open>
        <summary><span>{IMPLEMENTATION_GROUP_LABELS[subcategory]}</span><span className="group-count">{query.trim() ? `${subset.length}/${all.length}` : all.length}</span><span className="chevron" aria-hidden="true">⌄</span></summary>
        {subcategory === 'backend' || subcategory === 'frontend' || all.some(file => file.module) ? [...new Set(all.map(file => file.module))].sort((a, b) => (options.riskPriority ? maxRisk(all.filter(file => file.module === b)) - maxRisk(all.filter(file => file.module === a)) : 0) || a.localeCompare(b)).map(module => {
          const moduleFiles = subset.filter(file => file.module === module);
          if (!moduleFiles.length) return null;
          const moduleTotal = all.filter(file => file.module === module).length;
          return <details className="implementation-module" data-module={module} key={module} open>
            <summary><span>{moduleLabel(module)}{options.nextPending && <small className="module-progress"> {all.filter(file => file.module === module && reviewedFile(file.path)).length}/{moduleTotal} reviewed</small>}</span><span className="group-count">{query.trim() ? `${moduleFiles.length}/${moduleTotal}` : moduleTotal}</span><span className="chevron" aria-hidden="true">⌄</span></summary>
            {renderFiles(moduleFiles)}
          </details>;
        }) : renderFiles(subset)}
      </details>;
    })}
  </div>;

  return <div lang="en" onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); close(); } }}>
    <button ref={launcher} className="launcher" hidden={open} aria-expanded={open} aria-controls="pr-reviewer-panel" onClick={() => setOpen(!open)}>
      <span className="brand-mark" aria-hidden="true">▥</span> Organize PR <span className="launcher-count">{files.length}</span>
    </button>
    {open && <aside id="pr-reviewer-panel" className={`panel${collapsed ? ' is-collapsed' : ''}`} aria-label="Pull request organizer">
      <div className="panel-rail" hidden={!collapsed}>
        <button ref={expandButton} className="icon-button" aria-label="Expand panel" title="Expand panel" aria-expanded={!collapsed} aria-controls="pr-reviewer-panel-content" onClick={() => setCollapsed(false)}><span aria-hidden="true">«</span></button>
        <span className="brand-mark" aria-hidden="true">▥</span><span className="rail-label">PR Reviewer</span>
        {collapsed && <button className="icon-button rail-close" aria-label="Close panel" title="Close panel" onClick={close}>×</button>}
      </div>
      <div id="pr-reviewer-panel-content" className="panel-content" hidden={collapsed}>
      <header className="brand-bar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">▥</span> PR Reviewer <span className="local-badge" title={`Content UI version ${CONTENT_VERSION}`}>LOCAL · {CONTENT_VERSION}</span></div>
        <button className="ai-settings-button" hidden={view === 'ai'} onClick={() => {
          void sendExtensionMessage({ type: 'ai-open-settings' }).then(response => {
            if (!response?.ok) setError('Could not open AI settings. Reload the GitHub tab and try again.');
          }).catch(cause => setError(cause instanceof Error && cause.message === EXTENSION_RELOAD_NOTICE ? cause.message : 'Could not open AI settings. Reload the GitHub tab and try again.'));
        }}>Settings</button>
        <button ref={collapseButton} className="icon-button" aria-label="Collapse panel" title="Collapse to the right" aria-expanded={!collapsed} aria-controls="pr-reviewer-panel-content" onClick={() => setCollapsed(true)}><span aria-hidden="true">»</span></button>
        <button className="icon-button" aria-label="Close panel" title="Close panel" onClick={close}>×</button>
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
          {options.nextPending && <div className="progress-tools"><span>{files.filter(file => reviewedFile(file.path)).length}/{files.length} reviewed</span><button onClick={nextPending} disabled={files.every(file => reviewedFile(file.path))}>Next pending</button><label><input type="checkbox" checked={pendingOnly} onChange={event => setPendingOnly(event.target.checked)} /> Pending only</label></div>}
          {options.persistProgress && progress.lastFile && !selected && files.some(file => file.path === progress.lastFile) && <button className="ai-retry" onClick={() => void goTo(files.find(file => file.path === progress.lastFile)!)}>Resume last file</button>}
          <p className="sort-hint">{options.riskPriority ? 'Sensitive paths first · then largest changes' : 'Largest changes first'} · lines added + deleted</p>
          <p className="heat-legend" aria-label="Change volume temperature">Temperature: {Object.entries(heatLabels).map(([heat, label]) => <span key={heat} data-heat={heat} title={label}>{heat === 'hot' ? '>500' : heat === 'warm' ? '251–500' : heat === 'mild' ? '101–250' : '1–100'}</span>)}</p>
        </div>
        <div className="inventory-status" role="status" hidden={view === 'ai'}><span>{visible.length} of {files.length} files detected</span><span className="status-dot" aria-hidden="true" /> <span>{!files.length ? 'Waiting for diffs' : incomplete ? 'Partial' : 'Updated'}</span></div>
        {incomplete && <div className="notice" hidden={view === 'ai'}>GitHub exposes {files.length} of {expected} files in this view. Check the filters or wait for loading to finish.</div>}
        <div className="groups" hidden={view === 'ai'}>
          {categoryOrder.filter(category => filter === 'all' || filter === category).map(category => {
            const group = visible.filter(file => file.category === category);
            const total = categorized.filter(file => file.category === category).length;
            return <details className={`group ${category}`} key={category} open>
              <summary><span className="category-symbol" aria-hidden="true">{symbols[category]}</span><span>{CATEGORY_LABELS[category]}</span><span className="group-count">{query.trim() ? `${group.length}/${total}` : total}</span><span className="chevron" aria-hidden="true">⌄</span></summary>
              {group.length ? category === 'implementation' ? renderImplementation(group) : renderFiles(group) : <p className="group-empty">{query || filter !== 'all' ? 'No matches.' : 'No files detected in this group.'}</p>}
            </details>;
          })}
          {!files.length && <p className="no-files">Wait for GitHub to load the diffs. If none appear, return to the original view and check GitHub filters.</p>}
        </div>
        <AiReview headRevision={observedHead} onNext={nextPending} onReviewed={() => { const file = files.find(file => file.path === selected); if (file) void markFile(file); }} files={files} progress={progress} onProgress={saveProgress} file={files.find(file => file.path === selected)} selection={selection} comparison={comparison} visible={view === 'ai' && !collapsed} onAutomatic={openAutomaticReview} onStatus={setAIStatus} />
      </>}
      {selected && (options.persistProgress || options.checklist) && !collapsed && <details className="review-notebook"><summary>Review notes &amp; checklist</summary>
        {options.persistProgress && <><label htmlFor="review-note">Private note · saved locally</label><textarea id="review-note" maxLength={4000} value={note} onChange={event => { noteDirty.current = true; setNote(event.target.value); }} onBlur={() => { noteDirty.current = false; void saveProgress({ path: selected, note }); }} placeholder="Notes for this file…" /></>}
        {options.checklist && (aiStatus?.checklist ?? []).map(item => <label key={item}><input type="checkbox" checked={progress.files[selected]?.checks[item] ?? false} onChange={event => void saveProgress({ path: selected, check: { key: item, checked: event.target.checked } })} />{item}</label>)}
        {options.checklist && !aiStatus?.checklist?.length && <p>Add criteria for {repository} in Settings.</p>}
      </details>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer><div className="privacy"><span aria-hidden="true">◉</span> Local grouping · AI review optional</div><button className="return-button" onClick={close}>Return to original view <span aria-hidden="true">↗</span></button></footer>
      </div>
    </aside>}
  </div>;
}
