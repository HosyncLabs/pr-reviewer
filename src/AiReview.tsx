import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { AI_LANGUAGE_LABELS, AI_PROVIDERS, AI_STATUS_NOTICE, EXTENSION_RELOAD_NOTICE, isAILanguage, isAIProvider, sendExtensionMessage, type AIReviewComment, type AIReviewContext, type AIReviewLine, type AIReviewResult, type AIStatus } from './ai-protocol';
import type { PullRequestFile } from './github';
import { collectReviewContext } from './review-context';
import { navigateToReviewLine, reviewLineHash } from './review-navigation';

function hasStructuredComments(review: AIReviewResult) {
  return [review.highlights, review.focus].every(items => Array.isArray(items) && items.every(item =>
    item && typeof item.text === 'string' && Array.isArray(item.lines) && item.lines.every(reference =>
      reference && (reference.side === 'left' || reference.side === 'right') && Number.isSafeInteger(reference.line) && reference.line > 0)));
}

function reviewComments(items: AIReviewComment[], file: PullRequestFile, jump: (event: MouseEvent<HTMLAnchorElement>, reference: AIReviewLine) => void) {
  return <ul className="ai-comments">{items.map((item, index) => <li className={`ai-comment${item.lines.length ? ' has-reference' : ''}`} key={index}>
    <div className="ai-line-references" lang="en" aria-label="Referenced lines">
      {item.lines.length ? item.lines.map(reference => <a className="ai-line-chip" data-side={reference.side} key={`${reference.side}:${reference.line}`} href={reviewLineHash(file, reference)} onClick={event => jump(event, reference)} title={`${reference.side === 'left' ? 'Original' : 'New'} line ${reference.line}`} aria-label={`${reference.side === 'left' ? 'Original' : 'New'} line ${reference.line}`}>{reference.side === 'left' ? 'Old' : 'New'} L{reference.line}</a>) : <span className="ai-line-unavailable">Line reference unavailable</span>}
    </div>
    {item.lines.length ? <a className="ai-comment-text ai-comment-link" href={reviewLineHash(file, item.lines[0])} onClick={event => jump(event, item.lines[0])}>{item.text}</a> : <p className="ai-comment-text">{item.text}</p>}
  </li>)}</ul>;
}

export function AiReview({ file, selection, comparison, visible, onAutomatic, onStatus }: {
  file: PullRequestFile | undefined;
  selection: number;
  comparison: string;
  visible: boolean;
  onAutomatic: () => void;
  onStatus: (status: AIStatus) => void;
}) {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'reading' | 'generating' | 'done' | 'error'>('idle');
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
    setReview(null); setContext(null); setError(''); setPhase('idle');
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
        const selected = JSON.stringify([comparison, file.path, selection]);
        if (automaticSelection.current !== selected) { automaticSelection.current = selected; onAutomatic(); }
        setPhase('reading');
        const current = await collectReviewContext(file, document, controller.signal);
        if (controller.signal.aborted) return;
        setContext(current); setPhase('generating'); sent = true;
        const result = await sendExtensionMessage({ type: 'ai-review', requestId, context: current });
        if (controller.signal.aborted) return;
        if (!result.ok || !result.review) throw new Error(result.ok ? 'The AI provider returned an invalid review.' : result.error);
        if (!hasStructuredComments(result.review)) throw new Error('Reload PR Reviewer in chrome://extensions, then reload this GitHub tab to apply AI line references.');
        setReview(result.review); setPhase('done');
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
  }, [file?.path, file?.anchor, selection, comparison, refresh, onAutomatic, onStatus]);

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
    if (!file || comparison !== location.pathname + location.search) return;
    const controller = new AbortController();
    navigation.current = controller;
    setNavigationStatus('Finding referenced line…');
    let found = false;
    try { found = await navigateToReviewLine(file, reference, document, controller.signal); } catch {}
    if (controller.signal.aborted || navigation.current !== controller) return;
    navigation.current = null;
    setNavigationStatus(found ? '' : 'This line is not loaded. Load or expand its diff in GitHub, then try again.');
  };

  const providerLabel = status ? AI_PROVIDERS[status.provider ?? 'openai'].label : 'the selected AI provider';
  return <section className="ai-review" hidden={!visible} aria-label="AI review">
    <div className="ai-heading"><h2>AI review</h2><button className="ai-settings-button" onClick={() => void openSettings()}>AI settings</button></div>
    {file && <p className="ai-file" title={file.path}>{file.path}</p>}
    {!status && phase !== 'error' && <p role="status">Loading AI settings…</p>}
    {status && !status.configured && <p>Choose a provider and add its API key in AI settings to get highlights when you open a file.</p>}
    {status?.configured && !status.enabled && <p>Automatic AI is off. Enable it in AI settings.</p>}
    {status?.configured && status.enabled && !file && <p>Open a file from the list or GitHub's file tree to see its highlights and review focus.</p>}
    {context && <p className={`ai-scope${context.partial ? ' partial' : ''}`}>{context.partial ? 'Partial diff · only loaded lines were analyzed' : 'Loaded diff analyzed'} · {providerLabel} · {status?.model}{status && <> · {AI_LANGUAGE_LABELS[status.language]}</>}</p>}
    {(phase === 'reading' || phase === 'generating') && <p className="ai-loading" role="status">{phase === 'reading' ? 'Reading file changes…' : 'Generating review…'}</p>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    {navigationStatus && <p className="ai-navigation-status" role="status" lang="en">{navigationStatus}</p>}
    {error === EXTENSION_RELOAD_NOTICE ? <button className="ai-retry" onClick={() => location.reload()}>Reload GitHub tab</button> :
      (phase === 'error' || phase === 'done') && file && status?.configured && status.enabled && <button className="ai-retry" onClick={() => setRefresh(value => value + 1)}>{phase === 'done' ? 'Refresh review' : 'Retry review'}</button>}
    {review && file && context?.path === file.path && <div className="ai-result" lang={status?.language}>
      <div className="ai-summary-card"><span className="ai-kicker" lang="en">Summary</span><p className="ai-summary">{review.summary}</p></div>
      <section className="ai-highlights" aria-labelledby="ai-highlights-heading">
        <h3 id="ai-highlights-heading" lang="en">Highlights</h3>
        {review.highlights.length ? reviewComments(review.highlights, file, (event, reference) => void jump(event, reference)) : <p lang="en">No significant changes identified in the loaded diff.</p>}
      </section>
      <section className="ai-focus" aria-labelledby="ai-focus-heading">
        <h3 id="ai-focus-heading" lang="en">Review focus</h3>
        {review.focus.length ? reviewComments(review.focus, file, (event, reference) => void jump(event, reference)) : <p lang="en">No specific focus points identified in the loaded diff.</p>}
      </section>
    </div>}
    <p className="ai-disclosure">Only this file's loaded diff is sent to {providerLabel}. API usage is billed to your provider account.</p>
  </section>;
}
