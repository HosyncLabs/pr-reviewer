import type { AIReviewContext } from './ai-protocol';
import type { PullRequest } from './github';
import { moduleFor, type WorkflowOptions } from './workflow';

type ChangedFile = { filename: string; previous_filename?: string; patch?: string; additions: number; deletions: number; status: string; sha: string };
export function annotatePatch(patch: string, limit: number): { diff: string; partial: boolean; newLines: number[] } {
  let old = 0, next = 0, active = false, length = 0, expectedOld = 0, expectedNew = 0;
  const lines: string[] = [], newLines: number[] = [];
  let partial = false;
  for (const row of patch.replaceAll('\r\n', '\n').split('\n')) {
    const header = row.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      if (active && (expectedOld || expectedNew)) partial = true;
      old = Number(header[1]); next = Number(header[3]); expectedOld = Number(header[2] ?? 1); expectedNew = Number(header[4] ?? 1); active = true;
      if (![old, next, expectedOld, expectedNew].every(Number.isSafeInteger)) throw new Error('Invalid diff coordinates.');
      continue;
    }
    if (!active || row.startsWith('\\ No newline')) continue;
    const marker = row[0];
    if (!['+', '-', ' '].includes(marker)) { if (row) partial = true; continue; }
    const number = marker === '-' ? old : next;
    if (number < 1) { partial = true; continue; }
    const text = `[${marker === '-' ? 'old' : 'new'} line ${number}] ${row.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')}`;
    if (length + text.length + 1 > limit) { partial = true; break; }
    lines.push(text); length += text.length + 1;
    if (marker !== '-') { newLines.push(next++); expectedNew--; }
    if (marker !== '+') { old++; expectedOld--; }
    if (expectedOld < 0 || expectedNew < 0) partial = true;
  }
  partial ||= expectedOld !== 0 || expectedNew !== 0;
  return { diff: lines.join('\n'), partial, newLines };
}
export function surroundingSource(source: string, changed: number[], radius: number, limit: number): string {
  if (!radius || !changed.length) return '';
  const sourceLines = source.split('\n'), wanted = new Set<number>();
  for (const number of changed) for (let line = Math.max(1, number - radius); line <= Math.min(sourceLines.length, number + radius); line++) wanted.add(line);
  const result: string[] = []; let length = 0;
  for (const line of [...wanted].sort((a, b) => a - b)) {
    const text = `[source line ${line}] ${sourceLines[line - 1].replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')}`;
    if (length + text.length + 1 > limit) break;
    result.push(text); length += text.length + 1;
  }
  return result.join('\n');
}
async function githubJSON(path: string, token: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, { signal, redirect: 'error', credentials: 'omit', headers: {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  } });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 || response.status === 404 ? 'GitHub API access failed. For private repositories, add a token with Pull requests and Contents read access in Settings.' : 'GitHub API is unavailable or rate limited. Try again later.');
  const text = await response.text();
  if (text.length > 3_000_000) throw new Error('GitHub response exceeds the safe context limit.');
  return JSON.parse(text);
}
export async function loadGitHubContext(pr: PullRequest, path: string, scope: 'file' | 'module', relatedPaths: string[], options: WorkflowOptions, token: string, signal: AbortSignal): Promise<AIReviewContext> {
  const root = `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;
  const pull = await githubJSON(root, token, signal);
  const head = pull.head?.sha;
  if (!/^[a-f\d]{40,64}$/i.test(head ?? '')) throw new Error('GitHub did not provide a verified PR revision.');
  const headRepo = pull.head?.repo?.full_name;
  if (typeof headRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(headRepo)) throw new Error('GitHub did not provide the PR source repository.');
  const files: ChangedFile[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await githubJSON(`${root}/files?per_page=100&page=${page}`, token, signal);
    if (!Array.isArray(batch)) throw new Error('GitHub did not provide a file inventory.');
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const selected = files.find(file => file.filename === path);
  if (!selected) throw new Error('The selected file is no longer in this PR. Reload GitHub.');
  const sameModule = files.filter(file => moduleFor(file.filename) === moduleFor(path));
  const candidates = scope === 'module' ? [selected, ...files.filter(file => file !== selected && (sameModule.includes(file) || relatedPaths.includes(file.filename)))] : [selected];
  const chosen = candidates.slice(0, options.moduleFileLimit);
  let remaining = options.maxContextChars;
  const contexts: AIReviewContext[] = [];
  const warnings: string[] = [];
  if (chosen.length < candidates.length) warnings.push(`Only ${chosen.length} of ${candidates.length} selected module files fit the file limit.`);
  for (const file of chosen) {
    if (remaining < 1000) { warnings.push('Context character limit reached; some module files were omitted.'); break; }
    if (typeof file.patch !== 'string' || !file.patch.trim()) { warnings.push(`No text patch available: ${file.filename}`); continue; }
    const parsed = annotatePatch(file.patch, remaining);
    if (!parsed.diff) continue;
    remaining -= parsed.diff.length;
    const added = (parsed.diff.match(/^\[new line \d+\] \+/gm) ?? []).length;
    const deleted = (parsed.diff.match(/^\[old line \d+\] -/gm) ?? []).length;
    const context: AIReviewContext = { path: file.filename, diff: parsed.diff, partial: parsed.partial || added !== file.additions || deleted !== file.deletions, revision: head };
    if (options.expandedContext && file.status !== 'removed' && options.contextLines && remaining > 1000) {
      try {
        const source = await githubJSON(`/repos/${headRepo.split('/').map(encodeURIComponent).join('/')}/contents/${file.filename.split('/').map(encodeURIComponent).join('/')}?ref=${head}`, token, signal);
        if (source.type !== 'file' || source.encoding !== 'base64' || typeof source.content !== 'string' || source.size > 1_000_000) throw new Error('Source unavailable');
        const bytes = Uint8Array.from(atob(source.content.replaceAll('\n', '')), char => char.charCodeAt(0));
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (decoded.includes('\0')) throw new Error('Binary source');
        context.surrounding = surroundingSource(decoded, parsed.newLines, options.contextLines, Math.min(remaining, 20000));
        remaining -= context.surrounding.length;
      } catch (cause) { if (signal.aborted) throw cause; warnings.push(`Surrounding source unavailable: ${file.filename}`); }
    }
    contexts.push(context);
  }
  if (contexts[0]?.path !== path) throw new Error('GitHub has no text patch for the selected file. Use its loaded diff instead.');
  // Detect a push during pagination/source reads before trusting any line reference.
  const after = await githubJSON(root, token, signal);
  if (after.head?.sha !== head) throw new Error('New commits arrived while reading the PR. Reload GitHub and try again.');
  return { ...contexts[0], related: contexts.slice(1), scope, warnings, partial: contexts.some(item => item.partial) || warnings.length > 0 };
}
