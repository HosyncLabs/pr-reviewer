import { classifyImplementation, getBackendModule, getFrontendModule, getPackageModule } from './classifier';

export type WorkflowOptions = {
  persistProgress: boolean; nextPending: boolean; syncViewed: boolean; riskPriority: boolean;
  findingDetails: boolean; suggestions: boolean; checklist: boolean; automatic: boolean;
  expandedContext: boolean; moduleReview: boolean; cacheReviews: boolean;
  maxContextChars: number; maxOutputTokens: number; dailyRequests: number; moduleFileLimit: number; contextLines: number;
};
export const DEFAULT_WORKFLOW: WorkflowOptions = {
  persistProgress: true, nextPending: true, syncViewed: false, riskPriority: false,
  findingDetails: true, suggestions: true, checklist: false, automatic: true,
  expandedContext: false, moduleReview: false, cacheReviews: true,
  maxContextChars: 60000, maxOutputTokens: 4000, dailyRequests: 0, moduleFileLimit: 12, contextLines: 30,
};
export const WORKFLOW_KEY = 'pr-reviewer:workflow';
export const PROGRESS_NOTICE = 'pr-reviewer:progress-change';
export type FileProgress = { revision: string; reviewed: boolean; note: string; blocks: Record<string, 'reviewed' | 'dismissed'>; checks: Record<string, boolean> };
export type ReviewProgress = { files: Record<string, FileProgress>; lastFile: string };
export const EMPTY_PROGRESS: ReviewProgress = { files: {}, lastFile: '' };
export const emptyFileProgress = (revision = ''): FileProgress => ({ revision, reviewed: false, note: '', blocks: {}, checks: {} });
export const NUMBER_LIMITS = { maxContextChars: [10000, 120000], maxOutputTokens: [2000, 8000], dailyRequests: [0, 1000], moduleFileLimit: [2, 30], contextLines: [0, 100] } as const;
export function normalizeWorkflow(value: unknown): WorkflowOptions {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const options = { ...DEFAULT_WORKFLOW };
  for (const key of Object.keys(options) as (keyof WorkflowOptions)[]) {
    const item = raw[key];
    if (typeof options[key] === 'boolean') { if (typeof item === 'boolean') (options as Record<string, unknown>)[key] = item; }
    else {
      const [min, max] = NUMBER_LIMITS[key as keyof typeof NUMBER_LIMITS];
      if (typeof item === 'number' && Number.isSafeInteger(item)) (options as Record<string, unknown>)[key] = Math.max(min, Math.min(max, item));
    }
  }
  return options;
}
export function moduleFor(path: string): string {
  const group = classifyImplementation(path);
  return getPackageModule(path) || (group === 'backend' || /(?:^|\/)(backend|server|api)\//i.test(path) ? getBackendModule(path) : getFrontendModule(path)) || path.split('/').slice(0, -1).join('/') || 'Repository root';
}
export function riskFor(path: string): { score: number; labels: string[] } {
  const rules: [RegExp, string, number][] = [
    [/(?:^|[\/._-])(auth\w*|permission\w*|roles?|session|token|tenant)(?:[\/._-]|$)/i, 'Access / isolation', 3],
    [/(?:^|[\/._-])(payments?|billing|invoice|currency|commission|checkout)(?:[\/._-]|$)/i, 'Money', 3],
    [/\.sql$|(?:^|\/)(migrations?|schema)(?:\/|$)/i, 'Database', 2],
    [/(?:^|[\/._-])(delete|remove|purge|cleanup)(?:[\/._-]|$)/i, 'Deletion', 2],
  ];
  const matches = rules.filter(([pattern]) => pattern.test(path));
  return { score: Math.max(0, ...matches.map(([, , score]) => score)), labels: matches.map(([, label]) => label) };
}
export async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function blockKey(item: { text: string; lines: unknown[]; kind?: string; severity?: string; evidence?: string; suggestion?: unknown }): string {
  // The full identity prevents collisions and keeps marks independent of array order.
  return JSON.stringify([item.text, item.lines, item.kind, item.severity, item.evidence, item.suggestion]);
}
export function suggestionDraft(code: string): string {
  if (!code.trim() || code.length > 1900 || code.includes('```')) throw new Error('A safe, nonempty suggestion is required.');
  return '```suggestion\n' + code + '\n```';
}

export const sameDiffRevision = (previous: string, next: string) => /^[a-f\d]*:[a-f\d]{64}$/i.test(previous) && /^[a-f\d]*:[a-f\d]{64}$/i.test(next) && previous.split(':').at(-1) === next.split(':').at(-1);
