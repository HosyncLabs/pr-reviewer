import { useEffect, useRef, useState } from 'react';
import { AI_LANGUAGE_LABELS, AI_STATUS_NOTICE, isAILanguage, type AIReviewComment, type AIReviewContext, type AIReviewResult, type AIStatus, type ExtensionResponse } from './ai-protocol';
import type { PullRequestFile } from './github';
import { collectReviewContext } from './review-context';

function hasLineReferences(review: AIReviewResult) {
  return [review.highlights, review.focus].every(items => Array.isArray(items) && items.every(item =>
    item && typeof item.text === 'string' && Array.isArray(item.lines) && item.lines.every(reference =>
      reference && (reference.side === 'left' || reference.side === 'right') && Number.isSafeInteger(reference.line) && reference.line > 0)));
}

function reviewComments(items: AIReviewComment[]) {
  return <ul className="ai-comments">{items.map((item, index) => <li className="ai-comment" key={index}>
    <div className="ai-line-references" lang="en" aria-label="Referenced lines">
      {item.lines.length ? item.lines.map(({ side, line }) => <span className="ai-line-chip" data-side={side} key={`${side}:${line}`} title={`${side === 'left' ? 'Original' : 'New'} line ${line}`} aria-label={`${side === 'left' ? 'Original' : 'New'} line ${line}`}>{side === 'left' ? 'Old' : 'New'} L{line}</span>) : <span className="ai-line-unavailable">Line reference unavailable</span>}
    </div>
    <p className="ai-comment-text">{item.text}</p>
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
  const automaticSelection = useRef('');

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
        const response = await chrome.runtime.sendMessage({ type: 'ai-status' }) as ExtensionResponse;
        if (controller.signal.aborted) return;
        if (!response.ok || !response.status) throw new Error(response.ok ? 'Could not read AI settings.' : response.error);
        if (!isAILanguage(response.status.language)) {
          if (file && response.status.configured && response.status.enabled) onAutomatic();
          throw new Error('Reload PR Reviewer in chrome://extensions, then reload this GitHub tab to apply AI response language settings.');
        }
        setStatus(response.status); onStatus(response.status);
        if (!file || !response.status.configured || !response.status.enabled) { automaticSelection.current = ''; return; }
        const selected = JSON.stringify([comparison, file.path, selection]);
        if (automaticSelection.current !== selected) { automaticSelection.current = selected; onAutomatic(); }
        setPhase('reading');
        const current = await collectReviewContext(file, document, controller.signal);
        if (controller.signal.aborted) return;
        setContext(current); setPhase('generating'); sent = true;
        const result = await chrome.runtime.sendMessage({ type: 'ai-review', requestId, context: current }) as ExtensionResponse;
        if (controller.signal.aborted) return;
        if (!result.ok || !result.review) throw new Error(result.ok ? 'OpenAI returned an invalid review.' : result.error);
        if (!hasLineReferences(result.review)) throw new Error('Reload PR Reviewer in chrome://extensions, then reload this GitHub tab to apply AI line references.');
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
      if (sent) void chrome.runtime.sendMessage({ type: 'ai-cancel', requestId }).catch(() => {});
    };
  }, [file?.path, file?.anchor, selection, comparison, refresh, onAutomatic, onStatus]);

  const openSettings = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ai-open-settings' }) as ExtensionResponse;
      if (!response.ok) throw new Error(response.error);
    } catch {
      setError('Could not open AI settings. Reload the GitHub tab and try again.');
    }
  };

  return <section className="ai-review" hidden={!visible} aria-label="AI review">
    <div className="ai-heading"><h2>AI review</h2><button className="ai-settings-button" onClick={() => void openSettings()}>AI settings</button></div>
    {file && <p className="ai-file" title={file.path}>{file.path}</p>}
    {!status && phase !== 'error' && <p role="status">Loading AI settings…</p>}
    {status && !status.configured && <p>Add your OpenAI API key in AI settings to get highlights when you open a file.</p>}
    {status?.configured && !status.enabled && <p>Automatic AI is off. Enable it in AI settings.</p>}
    {status?.configured && status.enabled && !file && <p>Open a file from the list or GitHub's file tree to see its highlights and review focus.</p>}
    {context && <p className={`ai-scope${context.partial ? ' partial' : ''}`}>{context.partial ? 'Partial diff · only loaded lines were analyzed' : 'Loaded diff analyzed'} · {status?.model}{status && <> · {AI_LANGUAGE_LABELS[status.language]}</>}</p>}
    {(phase === 'reading' || phase === 'generating') && <p className="ai-loading" role="status">{phase === 'reading' ? 'Reading file changes…' : 'Generating review…'}</p>}
    {error && <p className="ai-error" role="alert">{error}</p>}
    {(phase === 'error' || phase === 'done') && file && status?.configured && status.enabled && <button className="ai-retry" onClick={() => setRefresh(value => value + 1)}>{phase === 'done' ? 'Refresh review' : 'Retry review'}</button>}
    {review && <div className="ai-result" lang={status?.language}>
      <div className="ai-summary-card"><span className="ai-kicker" lang="en">Summary</span><p className="ai-summary">{review.summary}</p></div>
      <section className="ai-highlights" aria-label="Highlights">
        <h3 lang="en">Highlights</h3>
        {review.highlights.length ? reviewComments(review.highlights) : <p>No significant changes identified in the loaded diff.</p>}
      </section>
      <section className="ai-focus" aria-label="Review focus">
        <h3 lang="en">Review focus</h3>
        {review.focus.length ? reviewComments(review.focus) : <p>No specific focus points identified in the loaded diff.</p>}
      </section>
    </div>}
    <p className="ai-disclosure">Only this file's loaded diff is sent to OpenAI. API usage is billed to your OpenAI account.</p>
  </section>;
}
