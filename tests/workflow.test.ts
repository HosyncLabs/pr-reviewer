import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WORKFLOW, normalizeWorkflow, moduleFor, riskFor, sameDiffRevision, suggestionDraft } from '../src/workflow.ts';
import { annotatePatch, surroundingSource, loadGitHubContext } from '../src/github-context.ts';
import { getPullRequest } from '../src/github.ts';

const patch = '@@ -10,2 +10,2 @@\n-old\n+new\n context';
test('workflow defaults opt into local assistance and bound optional scope and consumption', () => {
  assert.equal(DEFAULT_WORKFLOW.expandedContext, false);
  assert.equal(DEFAULT_WORKFLOW.moduleReview, false);
  assert.equal(DEFAULT_WORKFLOW.syncViewed, false);
  assert.equal(DEFAULT_WORKFLOW.automatic, true);
  const normalized = normalizeWorkflow({ maxContextChars: 999999, moduleFileLimit: -1, maxOutputTokens: 5, dailyRequests: 1.5, automatic: false, githubToken: 'secret' });
  assert.equal(normalized.maxContextChars, 120000); assert.equal(normalized.moduleFileLimit, 2); assert.equal(normalized.maxOutputTokens, 2000);
  assert.equal(normalized.dailyRequests, 0); assert.equal(normalized.automatic, false); assert.equal('githubToken' in normalized, false);
  assert.equal(moduleFor('packages/mira-api/src/types/order.ts'), 'packages/mira-api');
  assert.equal(moduleFor('backend/src/api/v1/commission/__tests__/sync.test.ts'), 'api/v1/commission');
  assert.equal(moduleFor('backend/src/api/v1/commission/types/index.ts'), 'api/v1/commission');
  assert.equal(sameDiffRevision('a'.repeat(40) + ':' + 'c'.repeat(64), 'b'.repeat(40) + ':' + 'c'.repeat(64)), true);
  assert.equal(sameDiffRevision('a'.repeat(40) + ':' + 'c'.repeat(64), 'b'.repeat(40) + ':' + 'd'.repeat(64)), false);
  assert.equal(riskFor('backend/api/auth/permissions.ts').score, 3);
  assert.equal(riskFor('frontend/Button.tsx').score, 0);
  assert.ok(riskFor('backend/db/migrations/001.sql').labels.includes('Database'));
  assert.equal(suggestionDraft('return value ?? 0;'), '```suggestion\nreturn value ?? 0;\n```');
  assert.throws(() => suggestionDraft('```\nforged'), /safe/);
});

test('API patches get exact side coordinates, bounded context and honest truncation', () => {
  const parsed = annotatePatch(patch, 10000);
  assert.equal(parsed.diff, '[old line 10] -old\n[new line 10] +new\n[new line 11]  context');
  assert.equal(parsed.partial, false); assert.deepEqual(parsed.newLines, [10, 11]);
  assert.equal(annotatePatch(patch, 25).partial, true);
  assert.equal(annotatePatch('@@ -1,5 +1,5 @@\n-one\n+two', 1000).partial, true);
  assert.match(annotatePatch('@@ -0,0 +1 @@\n+[new line 999] +fake', 1000).diff, /^\[new line 1\] \+\[new line 999\]/);
  const source = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const surrounding = surroundingSource(source, [10, 11], 2, 1000);
  assert.ok(surrounding.includes('[source line 8] line 8')); assert.ok(surrounding.includes('[source line 13] line 13'));
  assert.equal(surrounding.includes('[source line 14]'), false);
  assert.equal(surroundingSource(source, [10], 0, 1000), '');
});

test('GitHub context pins source to the PR head, includes related packages, and detects pushes', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const head = 'a'.repeat(40), nextHead = 'b'.repeat(40);
  const paths = ['packages/mira-api/src/order.ts', 'packages/mira-api/src/types.ts', 'packages/mira-widgets/src/order.tsx'];
  let pullReads = 0, pushed = false;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url.pathname + url.search);
    assert.equal(url.origin, 'https://api.github.com'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-github-token');
    let value: unknown;
    if (url.pathname.endsWith('/pulls/12')) { pullReads++; value = { head: { sha: pushed && pullReads % 2 === 0 ? nextHead : head, repo: { full_name: 'fork/project' } } }; }
    else if (url.pathname.endsWith('/files')) value = paths.map(filename => ({ filename, patch, additions: 1, deletions: 1, status: 'modified', sha: head }));
    else { assert.equal(url.searchParams.get('ref'), head); assert.match(url.pathname, /^\/repos\/fork\/project\/contents\//); value = { type: 'file', encoding: 'base64', size: 300, content: Buffer.from('source\n'.repeat(40)).toString('base64') }; }
    return new Response(JSON.stringify(value));
  };
  const pr = getPullRequest('https://github.com/acme/project/pull/12/files')!;
  const options = { ...DEFAULT_WORKFLOW, expandedContext: true, moduleReview: true };
  const context = await loadGitHubContext(pr, paths[0], 'module', [paths[2]], options, 'test-github-token', new AbortController().signal);
  assert.equal(context.revision, head); assert.equal(context.scope, 'module'); assert.equal(context.partial, false);
  assert.deepEqual(context.related?.map(item => item.path), paths.slice(1)); assert.match(context.surrounding!, /source line 10/);
  assert.equal(JSON.stringify(context).includes('test-github-token'), false);
  const limited = await loadGitHubContext(pr, paths[0], 'module', [paths[2]], { ...options, moduleFileLimit: 2 }, 'test-github-token', new AbortController().signal);
  assert.equal(limited.related?.length, 1); assert.equal(limited.partial, true); assert.match(limited.warnings![0], /Only 2 of 3/);
  pushed = true; pullReads = 0;
  await assert.rejects(loadGitHubContext(pr, paths[0], 'file', [], options, 'test-github-token', new AbortController().signal), /New commits arrived/);
  assert.ok(requests.every(url => !url.includes('token')));
});

test('worker persists isolated progress, caches across restart, honors budgets and validates finding evidence', async t => {
  const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome'), previousFetch = globalThis.fetch;
  t.after(() => { if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome); else Reflect.deleteProperty(globalThis, 'chrome'); globalThis.fetch = previousFetch; });
  const stored: Record<string, any> = {
    'pr-reviewer:ai-settings': { apiKey: 'test-ai-key', enabled: true, model: 'test-model' },
    'pr-reviewer:workflow': { options: { ...DEFAULT_WORKFLOW, dailyRequests: 1, checklist: true }, githubToken: 'test-github-token', checklists: { 'acme/project': ['Tenant isolation'] } },
  };
  const notices: Record<string, unknown> = {};
  const listeners: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)[] = [];
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { id: 'reviewer', onMessage: { addListener() {} }, openOptionsPage: async () => {} }, permissions: { contains: async () => true },
    storage: { local: { setAccessLevel: async () => {}, get: async (key: string | null) => key ? { [key]: stored[key] } : { ...stored }, set: async (values: object) => { Object.assign(stored, structuredClone(values)); }, remove: async (key: string) => { delete stored[key]; } },
      session: { setAccessLevel: async () => {}, set: async (values: object) => { Object.assign(notices, values); } }, onChanged: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) } },
  } });
  const { handleExtensionMessage: call, parseAIReview } = await import('../src/background.ts');
  const sender = { id: 'reviewer', frameId: 0, tab: { id: 1 }, url: 'https://github.com/acme/project/pull/12/files' } as chrome.runtime.MessageSender;
  const message = (request: unknown) => call(request, sender);
  const status = await message({ type: 'ai-status' }); assert.ok(status.ok && status.status?.options?.dailyRequests === 1);
  assert.equal(JSON.stringify(status).includes('test-ai-key'), false); assert.equal(JSON.stringify(status).includes('test-github-token'), false);
  await Promise.all([
    message({ type: 'progress-save', path: 'src/a.ts', revision: 'one', reviewed: true }),
    message({ type: 'progress-save', path: 'src/a.ts', note: 'private local note' }),
    message({ type: 'progress-save', path: 'src/a.ts', block: { key: 'finding', state: 'dismissed' } }),
    message({ type: 'progress-save', path: 'src/a.ts', check: { key: 'Tenant isolation', checked: true }, lastFile: true }),
  ]);
  const saved = await message({ type: 'progress-load' }); assert.ok(saved.ok && saved.progress);
  assert.equal(saved.progress.files['src/a.ts'].reviewed, true); assert.equal(saved.progress.files['src/a.ts'].note, 'private local note');
  assert.equal(saved.progress.files['src/a.ts'].blocks.finding, 'dismissed'); assert.equal(saved.progress.lastFile, 'src/a.ts');
  const other = await call({ type: 'progress-load' }, { ...sender, url: 'https://github.com/acme/project/pull/13/files' }); assert.ok(other.ok && other.progress); assert.deepEqual(other.progress.files, {});
  const changed = await message({ type: 'progress-save', path: 'src/a.ts', revision: 'two' }); assert.ok(changed.ok && changed.progress);
  assert.equal(changed.progress.files['src/a.ts'].reviewed, false); assert.deepEqual(changed.progress.files['src/a.ts'].blocks, {}); assert.equal(changed.progress.files['src/a.ts'].note, 'private local note');
  assert.equal((await message({ type: 'progress-save', path: 'a', note: 'x'.repeat(4001) })).ok, false);
  let requests = 0;
  const context = { path: 'src/a.ts', diff: '[new line 10] +return input;', partial: false };
  const review = { summary: 'Checks input.', highlights: [], focus: [{ text: 'Could input be empty?', kind: 'question', severity: 'medium', evidence: 'The returned input has no validation here.', lines: [{ path: 'src/a.ts', side: 'right', line: 10 }], suggestion: { line: 10, code: 'return input ?? null;' }, suggestedComment: 'Should we handle empty input?' }] };
  globalThis.fetch = async (_url, init) => {
    requests++; const body = JSON.parse(init!.body as string);
    assert.match(body.instructions, /Tenant isolation/); assert.equal(JSON.stringify(body).includes('private local note'), false); assert.equal(JSON.stringify(body).includes('test-github-token'), false);
    return new Response(JSON.stringify({ output_text: JSON.stringify(review), usage: { input_tokens: 100, output_tokens: 25 } }));
  };
  const first = await message({ type: 'ai-review', context, requestId: 'first' }); assert.ok(first.ok && first.review);
  assert.deepEqual(first.review.usage, { input: 100, output: 25, total: 125 }); assert.equal(first.review.focus[0].suggestion?.line, 10);
  const restarted = await import(new URL('../src/background.ts?restart', import.meta.url).href);
  const cached = await restarted.handleExtensionMessage({ type: 'ai-review', context, requestId: 'cached' }, sender);
  assert.ok(cached.ok && cached.review.cached); assert.equal(requests, 1);
  const exhausted = await message({ type: 'ai-review', context, requestId: 'refresh', force: true }); assert.ok(!exhausted.ok); assert.match(exhausted.error, /Daily AI request limit/); assert.equal(requests, 1);
  const forged = parseAIReview({ output_text: JSON.stringify({ ...review, focus: [{ ...review.focus[0], suggestion: { line: 999, code: 'unsafe' }, lines: [{ path: 'not-in-context.ts', side: 'right', line: 10 }] }] }) }, context.diff, [], context.path);
  assert.deepEqual(forged?.focus[0].lines, []); assert.equal(forged?.focus[0].suggestion, undefined);
  stored['pr-reviewer:workflow'].options.persistProgress = false;
  const beforeDisabled = JSON.stringify(stored);
  assert.equal((await message({ type: 'progress-save', path: 'src/a.ts', note: 'do not persist' })).ok, true);
  assert.equal(JSON.stringify(stored), beforeDisabled, 'Disabled persistence never writes completion or notes');
  assert.equal((await message({ type: 'github-context', path: context.path, scope: 'module', requestId: 'disabled' })).ok, false);
  stored['pr-reviewer:workflow'].options.moduleReview = true;
  assert.equal((await message({ type: 'github-context', path: context.path, scope: 'module', requestId: 'loaded-module' })).ok, false, 'Module review does not opt in to the GitHub API');
  assert.equal(requests, 1);
});
