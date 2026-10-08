import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { AI_LANGUAGE_LABELS, AI_PROVIDERS, AI_STATUS_NOTICE, EXTENSION_RELOAD_NOTICE, isAILanguage, isAIProvider, sendExtensionMessage, type AIReviewComment, type AIReviewContext, type AIReviewLine, type AIReviewResult, type AIStatus, type ExtensionRequest } from './ai-protocol';
import type { PullRequestFile } from './github';
import { collectReviewContext, readHeadRevision } from './review-context';
import { navigateToReviewLine, reviewLineHash } from './review-navigation';
import { openReviewComment } from './review-comment';
import { DEFAULT_WORKFLOW, fingerprint, blockKey, moduleFor, suggestionDraft, type WorkflowOptions, type ReviewProgress } from './workflow';

function hasStructuredComments(review: AIReviewResult) {
  return typeof review.summary === 'string' && (review.summaryComment === undefined || typeof review.summaryComment === 'string') &&
    [review.highlights, review.focus].every(items => Array.isArray(items) && items.every(item =>
    item && typeof item.text === 'string' && (item.suggestedComment === undefined || typeof item.suggestedComment === 'string') && Array.isArray(item.lines) && item.lines.every(reference =>
      reference && (reference.side === 'left' || reference.side === 'right') && Number.isSafeInteger(reference.line) && reference.line > 0)));
}

function ReviewBlock({ item, file, summary = false, jump, addComment, blockState, onMark, options, files }: {
  item: AIReviewComment;
  file: PullRequestFile;
  summary?: boolean;
  blockState?: 'reviewed' | 'dismissed';
  onMark: (state: 'reviewed' | 'dismissed' | null) => void;
  options: WorkflowOptions;
  files: PullRequestFile[];
  jump: (event: MouseEvent<HTMLAnchorElement>, reference: AIReviewLine) => void;
  addComment: (reference: AIReviewLine | undefined, draft: string) => Promise<{ message: string; showDraft: boolean } | undefined>;
}) {
  const reviewed = blockState === 'reviewed';
  const [collapsed, setCollapsed] = useState(reviewed);
  useEffect(() => setCollapsed(reviewed), [reviewed]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [showDraft, setShowDraft] = useState(false);
  const [shownDraft, setShownDraft] = useState('');
  const bodyId = useId();
  const disclosure = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (collapsed) disclosure.current?.focus(); }, [collapsed]);
  const draft = item.suggestedComment?.trim() || item.text;
  const referenceHash = (reference: AIReviewLine) => { const target = reference.path ? files.find(file => file.path === reference.path) : file; return target ? reviewLineHash(target, reference) : undefined; };
  const openComment = async (suggestion = false) => {
    setPending(true); setMessage('Opening GitHub’s editor…'); setShowDraft(false);
    const generated = suggestion && item.suggestion ? suggestionDraft(item.suggestion.code) : draft; setShownDraft(generated);
    const result = await addComment(suggestion && item.suggestion ? { side: 'right', line: item.suggestion.line } : item.lines[0], generated);
    if (!mounted.current) return;
    setPending(false); setMessage(result?.message ?? 'Comment cancelled. Try again on the current file.'); setShowDraft(result?.showDraft ?? false);
  };
  const Tag = summary ? 'div' : 'li';
  if (blockState === 'dismissed') return <Tag className="ai-dismissed"><span>Dismissed</span><button onClick={() => onMark(null)}>Undo dismiss</button></Tag>;
  return <Tag className={`${summary ? 'ai-summary-card' : `ai-comment${item.lines.length ? ' has-reference' : ''}`}${reviewed ? ' is-reviewed' : ''}${collapsed ? ' is-collapsed' : ''}`}>
    {reviewed && <button ref={disclosure} className="ai-reviewed-toggle" lang="en" title={item.text} aria-label={`Reviewed: ${item.text}. ${collapsed ? 'Show' : 'Hide'} details`} aria-expanded={!collapsed} aria-controls={bodyId} onClick={() => setCollapsed(value => !value)}>✓ Reviewed <span>{collapsed ? 'Show' : 'Hide'}</span></button>}
    <div id={bodyId} hidden={collapsed}>
    {summary ? <><span className="ai-kicker" lang="en">Summary</span><p className="ai-summary">{item.text}</p></> : <>
    {options.findingDetails && item.kind && <div className="finding-meta" lang="en"><span>{item.kind === 'bug' ? 'Possible bug' : item.kind === 'question' ? 'Question' : 'Suggestion'}</span><span data-severity={item.severity}>{item.severity} severity</span></div>}
    <div className="ai-line-references" lang="en" aria-label="Referenced lines">
      {item.lines.length ? item.lines.map(reference => <a className="ai-line-chip" data-side={reference.side} key={`${reference.side}:${reference.line}`} href={referenceHash(reference)} onClick={event => jump(event, reference)} title={`${reference.side === 'left' ? 'Original' : 'New'} line ${reference.line}`} aria-label={`${reference.side === 'left' ? 'Original' : 'New'} line ${reference.line}`}>{reference.path ? reference.path.split('/').at(-1) + ' · ' : ''}{reference.side === 'left' ? 'Old' : 'New'} L{reference.line}</a>) : <span className="ai-line-unavailable">Line reference unavailable</span>}
    </div>
    {item.lines.length ? <a className="ai-comment-text ai-comment-link" href={referenceHash(item.lines[0])} onClick={event => jump(event, item.lines[0])}>{item.text}</a> : <p className="ai-comment-text">{item.text}</p>}
    </>}
    {options.findingDetails && item.evidence && <p className="finding-evidence"><strong lang="en">Evidence: </strong>{item.evidence}</p>}
    <div className="ai-block-actions" lang="en">
      <button disabled={pending} onClick={() => void openComment()}>{pending ? 'Opening…' : 'Add comment'}</button>
      {options.suggestions && item.suggestion && <button disabled={pending} onClick={() => void openComment(true)}>Add suggestion</button>}
      <button disabled={pending} aria-pressed={reviewed} onClick={() => { onMark(reviewed ? null : 'reviewed'); setCollapsed(!reviewed); }}>{reviewed ? 'Undo reviewed' : 'Reviewed'}</button>
      {!summary && <button disabled={pending} onClick={() => onMark('dismissed')}>Dismiss</button>}
    </div>
    {message && <div className="ai-comment-draft">
      <p role="status" lang="en">{message}</p>
      {showDraft && <><label htmlFor={`${bodyId}-draft`} lang="en">Suggested comment · edit in GitHub before posting</label>
      <textarea id={`${bodyId}-draft`} readOnly value={shownDraft || draft} aria-label="Suggested comment" /></>}
    </div>}
    </div>
  </Tag>;
}

export function AiReview({ file, files, progress, onProgress, selection, comparison, visible, onAutomatic, onStatus, onNext, onReviewed, headRevision }: {
  file: PullRequestFile | undefined;
  files: PullRequestFile[];
  progress: ReviewProgress;
  onProgress: (update: Omit<Extract<ExtensionRequest, { type: 'progress-save' }>, 'type'>) => Promise<void>;
  selection: number;
  comparison: string;
  visible: boolean;
  onAutomatic: () => void;
  onStatus: (status: AIStatus) => void;
  headRevision: string;
  onNext: () => void;
  onReviewed: () => void;
}) {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [requested, setRequested] = useState('');
  const [scope, setScope] = useState<'file' | 'module'>('file');
  const [relatedPaths, setRelatedPaths] = useState<string[]>([]);
  const relatedRef = useRef(relatedPaths); relatedRef.current = relatedPaths;
  const force = useRef(false);
  const options = status?.options ?? DEFAULT_WORKFLOW;
  const selectionKey = JSON.stringify([comparison, file?.path, selection, headRevision]);
  const filesRef = useRef(files); filesRef.current = files;
  const [refresh, setRefresh] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'reading' | 'generating' | 'done' | 'error'>('idle');
  const [blockIds, setBlockIds] = useState<Record<string, string>>({});
  const [review, setReview] = useState<AIReviewResult | null>(null);
  const [context, setContext] = useState<AIReviewContext | null>(null);
  const [error, setError] = useState('');
  const [navigationStatus, setNavigationStatus] = useState('');
  const automaticSelection = useRef('');
  const navigation = useRef<AbortController | null>(null);

  useEffect(() => {
    setNavigationStatus('');
    return () => navigation.current?.abort();
  }, [file?.path, file?.anchor, selection, comparison, refresh, visible]);

  useEffect(() => {
    const sync = () => setRefresh(value => value + 1);
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && Object.hasOwn(changes, AI_STATUS_NOTICE)) sync();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = crypto.randomUUID();
    let sent = false;
    const bypassCache = force.current; force.current = false;
    setReview(null); setBlockIds({}); setContext(null); setError(''); setPhase('idle');
    const run = async () => {
      try {
        const response = await sendExtensionMessage({ type: 'ai-status' });
        if (controller.signal.aborted) return;
        if (!response.ok || !response.status) throw new Error(response.ok ? 'Could not read AI settings.' : response.error);
        if (!isAILanguage(response.status.language)) {
          if (file && response.status.configured && response.status.enabled) onAutomatic();
          throw new Error('Reload PR Reviewer in chrome://extensions, then reload this GitHub tab to apply AI response language settings.');
        }
        if (response.status.provider !== undefined && !isAIProvider(response.status.provider)) throw new Error('Could not read the selected AI provider. Reload PR Reviewer and this GitHub tab.');
        setStatus(response.status); onStatus(response.status);
        if (!file || !response.status.configured || !response.status.enabled) { automaticSelection.current = ''; return; }
        const currentOptions = response.status.options ?? DEFAULT_WORKFLOW;
        const selected = JSON.stringify([comparison, file.path, selection, headRevision]);
        if (!currentOptions.automatic && requested !== selected) return;
        if (automaticSelection.current !== selected) { automaticSelection.current = selected; onAutomatic(); }
        setPhase('reading');
        let current: AIReviewContext;
        const loaded = await collectReviewContext(file, document, controller.signal);
        const revision = readHeadRevision() + ':' + await fingerprint(loaded.diff);
        if (controller.signal.aborted) return;
        await onProgress({ path: file.path, revision });
        const currentScope = requested === selected ? scope : 'file';
        if (currentOptions.expandedContext || currentScope === 'module') {
          sent = true;
          const expanded = await sendExtensionMessage({ type: 'github-context', path: file.path, scope: currentScope, relatedPaths: relatedRef.current, requestId });
          if (controller.signal.aborted) return;
          if (!expanded.ok || !expanded.context) throw new Error(expanded.ok ? 'GitHub did not return context.' : expanded.error);

          const apiLines = new Map(expanded.context.diff.split('\n').map(line => [line.match(/^\[(?:old|new) line \d+\]/)?.[0], line]));
          const loadedLines = loaded.diff.split('\n').filter(line => /^\[(?:old|new) line \d+\]/.test(line));
          const common = loadedLines.filter(line => apiLines.has(line.match(/^\[(?:old|new) line \d+\]/)?.[0]));
          if (!common.length || common.some(line => apiLines.get(line.match(/^\[(?:old|new) line \d+\]/)?.[0]) !== line)) throw new Error('The loaded diff does not match the GitHub API revision. Reload GitHub, or use loaded-diff mode.');
          const pageHead = readHeadRevision();
          if (pageHead && expanded.context.revision !== pageHead) throw new Error('The GitHub page shows an older commit. Reload this tab before using expanded context.');
          current = expanded.context;
        } else {
          current = loaded;
          if (current.diff.length > currentOptions.maxContextChars) {
            const shortened = current.diff.slice(0, currentOptions.maxContextChars);
            current = { ...current, diff: shortened.slice(0, shortened.lastIndexOf('\n')), partial: true };
          }
        }
        if (controller.signal.aborted) return;
        setContext(current); setPhase('generating'); sent = true;
        const result = await sendExtensionMessage({ type: 'ai-review', requestId, context: current, ...(bypassCache ? { force: true } : {}) });
        if (controller.signal.aborted) return;
        if (!result.ok || !result.review) throw new Error(result.ok ? 'The AI provider returned an invalid review.' : result.error);
        if (!hasStructuredComments(result.review)) throw new Error('Reload PR Reviewer in chrome://extensions, then reload this GitHub tab to apply AI line references.');
        const items = [{ text: result.review.summary, lines: [] }, ...result.review.highlights, ...result.review.focus];
        const ids = await Promise.all(items.map(async item => [blockKey(item), await fingerprint(blockKey(item))]));
        if (controller.signal.aborted) return;
        setBlockIds(Object.fromEntries(ids)); setReview(result.review); setPhase('done');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Could not generate the review. Please try again.');
        setPhase('error');
      }
    };
    void run();
    return () => {
      controller.abort();
      if (sent) void sendExtensionMessage({ type: 'ai-cancel', requestId }).catch(() => {});
    };
  }, [file?.path, file?.anchor, selection, comparison, refresh, onAutomatic, onStatus, onProgress, requested, scope, headRevision]);

  const openSettings = async () => {
    try {
      const response = await sendExtensionMessage({ type: 'ai-open-settings' });
      if (!response.ok) throw new Error(response.error);
    } catch (cause) {
      setError(cause instanceof Error && cause.message === EXTENSION_RELOAD_NOTICE ? cause.message : 'Could not open AI settings. Reload the GitHub tab and try again.');
    }
  };

  const jump = async (event: MouseEvent<HTMLAnchorElement>, reference: AIReviewLine) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigation.current?.abort();
    if (reference.path && !filesRef.current.some(file => file.path === reference.path)) { setNavigationStatus('This file is not in GitHub’s loaded inventory. Load the remaining files and try again.'); return; }
    if (!file || comparison !== location.pathname + location.search) return;
    const controller = new AbortController();
    navigation.current = controller;
    setNavigationStatus('Finding referenced line…');
    let found = false;
    try { found = await navigateToReviewLine(filesRef.current.find(target => target.path === reference.path) ?? file, reference, document, controller.signal); } catch {}
    if (controller.signal.aborted || navigation.current !== controller) return;
    navigation.current = null;
    setNavigationStatus(found ? '' : 'This line is not loaded. Load or expand its diff in GitHub, then try again.');
  };

  const addComment = async (reference: AIReviewLine | undefined, draft: string) => {
    navigation.current?.abort();
    if (reference?.path && !filesRef.current.some(file => file.path === reference.path)) return { message: 'This file is not in GitHub’s loaded inventory. Load the remaining files before adding a comment.', showDraft: true };
    if (!visible || !file || comparison !== location.pathname + location.search) return;
    const controller = new AbortController();
    navigation.current = controller;
    setNavigationStatus('');
    let message: string;
    let showDraft = true;
    try {
      const result = await openReviewComment(filesRef.current.find(target => target.path === reference?.path) ?? file, reference, draft, document, controller.signal);
      message = result === 'filled' ? 'Draft added in GitHub. Edit it before posting.' : 'Your existing draft was preserved. The AI suggestion is below.';
      showDraft = result === 'preserved';
    } catch (cause) {
      message = cause instanceof Error ? cause.message : 'Could not open GitHub’s editor. The AI suggestion is below.';
    }
    if (controller.signal.aborted || navigation.current !== controller) return;
    navigation.current = null;
    return { message, showDraft };
  };

  const marks = progress.files[file?.path ?? '']?.blocks ?? {};
  const mark = (item: AIReviewComment, state: 'reviewed' | 'dismissed' | null) => { if (file) void onProgress({ path: file.path, block: { key: blockIds[blockKey(item)], state } }); };
  const summaryItem: AIReviewComment = { text: review?.summary ?? '', lines: [], suggestedComment: review?.summaryComment };
  const providerLabel = status ? AI_PROVIDERS[status.provider ?? 'openai'].label : 'the selected AI provider';
  return <section className="ai-review" hidden={!visible} aria-label="AI review">
    <div className="ai-heading"><h2>AI review</h2><button className="ai-settings-button" onClick={() => void openSettings()}>Settings</button></div>
    {file && <p className="ai-file" title={file.path}>{file.path}</p>}
    {options.nextPending && file && <div className="progress-tools"><button aria-pressed={!!progress.files[file.path]?.reviewed} onClick={onReviewed}>{progress.files[file.path]?.reviewed ? '✓ File reviewed' : 'Mark file reviewed'}</button><button disabled={files.every(file => progress.files[file.path]?.reviewed)} onClick={onNext}>Next pending</button></div>}
    {!status && phase !== 'error' && <p role="status">Loading AI settings…</p>}
    {status && !status.configured && <p>Choose a provider and add its API key in AI settings to get highlights when you open a file.</p>}
    {status?.configured && !status.enabled && <p>AI is off. Enable it in Settings.</p>}
    {status?.configured && status.enabled && !file && <p>Open a file from the list or GitHub's file tree to see its highlights and review focus.</p>}
    {file && status?.configured && status.enabled && phase === 'idle' && <button className="ai-retry" onClick={() => { setScope('file'); setRequested(selectionKey); setRefresh(value => value + 1); }}>Analyze file</button>}
    {context && <p className={`ai-scope${context.partial ? ' partial' : ''}`}>{context.scope === 'module' ? 'Module analysis' : context.surrounding ? 'Diff + surrounding source' : context.revision ? 'GitHub API diff' : 'Loaded diff analyzed'}{context.partial ? ' · Partial diff' : ''} · {providerLabel} · {status?.model}{status && <> · {AI_LANGUAGE_LABELS[status.language]}</>}</p>}
    {context?.warnings?.map(warning => <p key={warning} className="ai-scope partial">{warning}</p>)}
    {review && <p className="ai-usage">{review.cached ? 'Cached review · no new AI request' : 'New analysis'}{review.usage ? ` · ${review.usage.input.toLocaleString()} input + ${review.usage.output.toLocaleString()} output tokens` : ' · Token usage unavailable'}</p>}
    {options.moduleReview && file && <details className="module-review-controls"><summary>Module review · {moduleFor(file.path)}</summary><p>Include changed files from this module, plus optional related files below. Limits apply.</p><div className="related-file-list">{files.filter(target => target.path !== file.path && moduleFor(target.path) !== moduleFor(file.path)).map(target => <label key={target.path}><input type="checkbox" checked={relatedPaths.includes(target.path)} onChange={event => setRelatedPaths(paths => event.target.checked ? [...paths, target.path] : paths.filter(path => path !== target.path))} />{target.path}</label>)}</div><button disabled={phase === 'reading' || phase === 'generating' || !status?.enabled || !status.configured} onClick={() => { setScope('module'); setRequested(selectionKey); setRefresh(value => value + 1); }}>Analyze module</button></details>}
    {(phase === 'reading' || phase === 'generating') && <p className="ai-loading" role="status">{phase === 'reading' ? 'Reading file changes…' : 'Generating review…'}</p>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    {navigationStatus && <p className="ai-navigation-status" role="status" lang="en">{navigationStatus}</p>}
    {error === EXTENSION_RELOAD_NOTICE ? <button className="ai-retry" onClick={() => location.reload()}>Reload GitHub tab</button> :
      (phase === 'error' || phase === 'done') && file && status?.configured && status.enabled && <button className="ai-retry" onClick={() => { force.current = true; setRequested(selectionKey); setRefresh(value => value + 1); }}>{phase === 'done' ? 'Refresh review' : 'Retry review'}</button>}
    {review && file && context?.path === file.path && <div className="ai-result" lang={status?.language}>
      <ReviewBlock summary item={summaryItem} blockState={marks[blockIds[blockKey(summaryItem)]]} onMark={state => mark(summaryItem, state)} options={options} files={files} file={file} jump={(event, reference) => void jump(event, reference)} addComment={addComment} />
      <section className="ai-highlights" aria-labelledby="ai-highlights-heading">
        <h3 id="ai-highlights-heading" lang="en">Highlights</h3>
        {review.highlights.length ? <ul className="ai-comments">{review.highlights.map((item, index) => <ReviewBlock key={`${blockKey(item)}:${index}`} item={item} blockState={marks[blockIds[blockKey(item)]]} onMark={state => mark(item, state)} options={options} files={files} file={file} jump={(event, reference) => void jump(event, reference)} addComment={addComment} />)}</ul> : <p lang="en">No significant changes identified in the loaded diff.</p>}
      </section>
      <section className="ai-focus" aria-labelledby="ai-focus-heading">
        <h3 id="ai-focus-heading" lang="en">Review focus</h3>
        {review.focus.length ? <ul className="ai-comments">{review.focus.map((item, index) => <ReviewBlock key={`${blockKey(item)}:${index}`} item={item} blockState={marks[blockIds[blockKey(item)]]} onMark={state => mark(item, state)} options={options} files={files} file={file} jump={(event, reference) => void jump(event, reference)} addComment={addComment} />)}</ul> : <p lang="en">No specific focus points identified in the loaded diff.</p>}
      </section>
    </div>}
    <p className="ai-disclosure">{context?.scope === 'module' ? 'Selected module diffs and optional surrounding source are sent to' : options.expandedContext ? 'This file’s API diff and surrounding source are sent to' : "Only this file's loaded diff is sent to"} {providerLabel}. API usage is billed to your provider account.</p>
  </section>;
}
