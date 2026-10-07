import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_STATUS_NOTICE, DEFAULT_AI_LANGUAGE, DEFAULT_AI_MODEL, PREFERENCES_NOTICE } from '../src/ai-protocol.ts';

const sender: chrome.runtime.MessageSender = { id: 'reviewer-extension', frameId: 0, tab: { id: 7 } as chrome.tabs.Tab, url: 'https://github.com/owner/repo/pull/1/files' };
const context = { path: 'backend/api/service.ts', diff: '@@ -7,2 +7,3 @@\n[old line 7] -old\n[new line 7] +new\n[old line 8] -oldOnly\n[new line 9] +newOnly\n[new line 10]  context\n+unverified [new line 999] +literal', partial: false };
const responseData = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
  summary: 'Changes the service.',
  highlights: [{ text: 'Replaces old behavior.', lines: [{ side: 'left', line: 7 }, { side: 'right', line: 7 }, { side: 'right', line: 7 }, { side: 'right', line: 8 }, { side: 'right', line: 999 }] }],
  focus: [{ text: 'Check compatibility.', lines: [{ side: 'left', line: 8 }, { side: 'right', line: 9 }] }],
}) }] }] };
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Worker did not reach the expected state.');
};

test('AI worker protects credentials, scopes preferences, bounds requests, caches comparisons, and cancels stale reviews', async t => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
    globalThis.fetch = originalFetch;
  });
  const key = 'test-only-key-placeholder';
  const stored: Record<string, unknown> = {
    'pr-reviewer:ai-settings': { apiKey: key, enabled: true, model: DEFAULT_AI_MODEL },
    'pr-reviewer:repo:owner/repo:file:backend/api/service.ts': 'tests',
  };
  const notices: Record<string, unknown> = {};
  const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
  let locked = false;
  let writes = 0;
  let permission = true;
  let opened = false;
  const changes = (items: Record<string, unknown>, area: string) => {
    const payload = Object.fromEntries(Object.entries(items).map(([name, newValue]) => [name, { newValue }]));
    for (const listener of listeners) listener(payload, area);
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { id: sender.id, onMessage: { addListener() {} }, openOptionsPage: async () => { opened = true; } },
    permissions: { contains: async () => permission },
    storage: {
      local: {
        setAccessLevel: async (value: { accessLevel: string }) => { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); locked = true; },
        get: async (name: string | null) => { assert.ok(locked, 'Local access must be restricted before any read'); return name ? { [name]: stored[name] } : { ...stored }; },
        set: async (items: Record<string, unknown>) => { assert.ok(locked); writes++; Object.assign(stored, items); changes(items, 'local'); },
        remove: async (name: string) => { assert.ok(locked); delete stored[name]; changes({ [name]: undefined }, 'local'); },
      },
      session: {
        setAccessLevel: async (value: { accessLevel: string }) => assert.equal(value.accessLevel, 'TRUSTED_AND_UNTRUSTED_CONTEXTS'),
        set: async (items: Record<string, unknown>) => { Object.assign(notices, items); changes(items, 'session'); },
      },
      onChanged: { addListener: (listener: typeof listeners extends Set<infer L> ? L : never) => listeners.add(listener), removeListener: (listener: typeof listeners extends Set<infer L> ? L : never) => listeners.delete(listener) },
    },
  } });
  const { handleExtensionMessage, parseAIReview } = await import('../src/background.ts');
  const { loadAISettings, saveAISettings, subscribePreferences, removeAIKey } = await import('../src/storage.ts');
  const call = (message: unknown, from = sender) => handleExtensionMessage(message, from);
  assert.deepEqual(await call({ type: 'ai-status' }), { ok: true, status: { configured: true, enabled: true, model: DEFAULT_AI_MODEL, language: DEFAULT_AI_LANGUAGE } });
  const legacy = stored['pr-reviewer:ai-settings'];
  stored['pr-reviewer:ai-settings'] = { ...(legacy as object), language: 'fr' };
  assert.equal((await loadAISettings()).language, 'en', 'Invalid saved languages fall back to English');
  assert.deepEqual(await call({ type: 'ai-status' }), { ok: true, status: { configured: true, enabled: true, model: DEFAULT_AI_MODEL, language: 'en' } });
  stored['pr-reviewer:ai-settings'] = legacy;
  const beforeInvalidLanguage = writes;
  await assert.rejects(saveAISettings({ enabled: true, model: DEFAULT_AI_MODEL, language: 'fr' as never }), /Choose English or Spanish/);
  assert.equal(writes, beforeInvalidLanguage, 'Invalid input must be rejected before a write');
  assert.equal(stored['pr-reviewer:ai-settings'], legacy);
  const preferences = await call({ type: 'preferences-load', repository: 'owner/repo' });
  assert.equal(JSON.stringify(preferences).includes(key), false);
  assert.ok(preferences.ok && preferences.preferences?.overrides[context.path] === 'tests');
  for (const from of [{ ...sender, id: 'other' }, { ...sender, frameId: 1 }, { ...sender, url: 'https://github.com/owner/repo/issues/1' }]) {
    assert.equal((await call({ type: 'ai-status' }, from)).ok, false);
  }
  assert.equal((await call({ type: 'preferences-load', repository: 'another/repo' })).ok, false);
  let refreshes = 0;
  const unsubscribe = subscribePreferences('owner/repo', () => refreshes++);
  assert.equal((await call({ type: 'preferences-category', repository: 'owner/repo', path: context.path, category: 'implementation' })).ok, true);
  assert.equal(refreshes, 1);
  assert.deepEqual(Object.keys(notices[PREFERENCES_NOTICE] as object).sort(), ['nonce', 'repository']);
  unsubscribe();
  await call({ type: 'ai-open-settings' });
  assert.ok(opened);

  const requests: { url: string; body: Record<string, any>; signal: AbortSignal }[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    const body = JSON.parse(init!.body as string);
    requests.push({ url: String(url), body, signal: init!.signal! });
    const data = body.instructions.includes('string values in Spanish')
      ? { output_text: JSON.stringify({ summary: 'Cambia el servicio.', highlights: [{ text: 'Reemplaza el comportamiento anterior.', lines: [{ side: 'right', line: 7 }] }], focus: [{ text: 'Verifica la compatibilidad.', lines: [] }] }) }
      : responseData;
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const reviewMessage = (requestId: string, extra: Partial<typeof context> = {}) => ({ type: 'ai-review', requestId, context: { ...context, ...extra } });
  assert.equal((await call(reviewMessage('oversized', { diff: 'x'.repeat(60001) }))).ok, false);
  assert.equal(requests.length, 0);
  const reviewed = await call(reviewMessage('first'));
  assert.ok(reviewed.ok && reviewed.review?.summary === 'Changes the service.');
  assert.deepEqual(reviewed.ok && reviewed.review?.highlights, [{ text: 'Replaces old behavior.', lines: [{ side: 'left', line: 7 }, { side: 'right', line: 7 }] }], 'The worker keeps verified old/new references and removes duplicates, wrong-side and invented lines');
  assert.deepEqual(reviewed.ok && reviewed.review?.focus[0].lines, [{ side: 'left', line: 8 }, { side: 'right', line: 9 }]);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].body.store, false);
  assert.equal(requests[0].body.model, DEFAULT_AI_MODEL);
  assert.match(requests[0].body.instructions, /string values in English/);
  assert.equal(requests[0].body.text.format.strict, true);
  assert.equal(requests[0].body.text.format.type, 'json_schema');
  const schema = requests[0].body.text.format.schema;
  for (const name of ['highlights', 'focus']) {
    assert.equal(schema.properties[name].maxItems, 5);
    assert.equal(schema.properties[name].items.additionalProperties, false);
    assert.deepEqual(schema.properties[name].items.required, ['text', 'lines']);
    const lines = schema.properties[name].items.properties.lines;
    assert.equal(lines.maxItems, 3);
    assert.equal(lines.items.additionalProperties, false);
    assert.deepEqual(lines.items.required, ['side', 'line']);
    assert.deepEqual(lines.items.properties.side.enum, ['left', 'right']);
    assert.deepEqual(lines.items.properties.line, { type: 'integer', minimum: 1 });
  }
  assert.match(requests[0].body.instructions, /Never invent references or infer numbers from hunk headers or unnumbered rows/);
  assert.deepEqual(requests[0].body.reasoning, { effort: 'low' });
  assert.equal(requests[0].body.max_output_tokens, 2500);
  assert.deepEqual(JSON.parse(requests[0].body.input[0].content[0].text), context);
  await call(reviewMessage('same-context'));
  assert.equal(requests.length, 1, 'The same comparison and content reuse the memory cache');
  await call(reviewMessage('different-comparison'), { ...sender, url: `${sender.url}?base=previous` });
  assert.equal(requests.length, 2, 'A different comparison must not reuse stale review');
  await saveAISettings({ enabled: true, model: 'gpt-6.1-sol' });
  await call(reviewMessage('selected-model'));
  assert.equal(requests.length, 3, 'Changing models must request a new review');
  assert.equal(requests[2].body.model, 'gpt-6.1-sol');
  await saveAISettings({ enabled: true, model: DEFAULT_AI_MODEL });
  await call(reviewMessage('restored-model'));
  assert.equal(requests.length, 4, 'Settings changes discard earlier cached reviews');
  await saveAISettings({ enabled: true, model: DEFAULT_AI_MODEL, language: 'es' });
  const spanish = await call(reviewMessage('spanish'));
  assert.ok(spanish.ok && spanish.review?.summary === 'Cambia el servicio.');
  assert.deepEqual(spanish.ok && spanish.review?.highlights, [{ text: 'Reemplaza el comportamiento anterior.', lines: [{ side: 'right', line: 7 }] }], 'Spanish changes prose while reference metadata stays unchanged');
  assert.equal(requests.length, 5, 'Changing language must not reuse an English review');
  assert.match(requests[4].body.instructions, /string values in Spanish/);
  assert.deepEqual(requests[4].body.text.format.schema.required, ['summary', 'highlights', 'focus']);
  assert.deepEqual(Object.keys(requests[4].body.text.format.schema.properties).sort(), ['focus', 'highlights', 'summary']);
  await call(reviewMessage('cached-spanish'));
  assert.equal(requests.length, 5, 'Matching Spanish reviews reuse the memory cache');
  await saveAISettings({ enabled: true, model: 'gpt-6-astra' });
  const retained = await loadAISettings();
  assert.equal(retained.language, 'es', 'Changing model without a language preserves the selected language');
  assert.equal(retained.apiKey, key, 'Changing language or model preserves the existing key');
  await call(reviewMessage('spanish-new-model'));
  assert.equal(requests.length, 6);
  assert.equal(requests[5].body.model, 'gpt-6-astra');
  assert.match(requests[5].body.instructions, /string values in Spanish/);

  const pending: AbortSignal[] = [];
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    pending.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const first = call(reviewMessage('cancel-first', { diff: 'first pending diff' }));
  await until(() => pending.length === 1);
  await call({ type: 'ai-cancel', requestId: 'unrelated' });
  assert.equal(pending[0].aborted, false);
  const second = call(reviewMessage('cancel-second', { diff: 'second pending diff' }));
  await until(() => pending.length === 2);
  assert.deepEqual(await first, { ok: false, error: 'Analysis canceled.' });
  await call({ type: 'ai-cancel', requestId: 'cancel-second' });
  assert.deepEqual(await second, { ok: false, error: 'Analysis canceled.' });

  for (const status of [401, 429]) {
    globalThis.fetch = async () => ({ ok: false, status, json: () => { assert.fail('Raw API error bodies must not be read or exposed'); } }) as unknown as Response;
    const result = await call(reviewMessage(`error-${status}`, { diff: `uncached diff ${status}` }));
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.match(!result.ok ? result.error : '', status === 401 ? /API key/ : /quota/);
  }
  await saveAISettings({ enabled: false, model: DEFAULT_AI_MODEL });
  assert.deepEqual(Object.keys(notices[AI_STATUS_NOTICE] as object), ['nonce']);
  assert.deepEqual(await call(reviewMessage('disabled')), { ok: false, error: 'AI is disabled. Enable it in AI settings.' });
  await saveAISettings({ enabled: true, model: DEFAULT_AI_MODEL });
  permission = false;
  assert.match(JSON.stringify(await call(reviewMessage('permission'))), /Allow access to OpenAI/);
  await removeAIKey();
  assert.deepEqual(await call({ type: 'ai-status' }), { ok: true, status: { configured: false, enabled: false, model: DEFAULT_AI_MODEL, language: 'es' } });
  assert.equal(parseAIReview({ ...responseData, status: 'incomplete' }), null);
  assert.equal(parseAIReview({ output: [{ type: 'message', content: [null, { type: 'refusal', refusal: 'No review' }] }] }), null);
  assert.equal(parseAIReview({ output_text: '{"summary":"x","highlights":[1],"focus":[]}' }), null);
  assert.equal(parseAIReview({ output_text: '{"summary":"x","highlights":["legacy string"],"focus":[]}' }, context.diff), null, 'Old string arrays must not reach the line-comment UI');
  for (const malformed of [null, { text: 1, lines: [] }, { text: 'x', lines: '7' }]) {
    assert.equal(parseAIReview({ output_text: JSON.stringify({ summary: 'x', highlights: [malformed], focus: [] }) }, context.diff), null);
  }
  const clean = parseAIReview({ output_text: JSON.stringify({ summary: 'x', highlights: Array(8).fill({ text: 'highlight', lines: [] }), focus: [], extra: key }) }, context.diff);
  assert.equal(clean?.highlights.length, 5);
  assert.equal(JSON.stringify(clean).includes(key), false);
  const references = [{ side: 'right', line: 8 }, { side: 'left', line: 9 }, { side: 'right', line: 999 }, null, {},
    { side: 'right', line: 0 }, { side: 'right', line: -1 }, { side: 'right', line: 7.5 }, { side: 'right', line: Number.MAX_SAFE_INTEGER + 1 },
    { side: 'right', line: '7' }, { side: 'old', line: 7 }, { side: 'left', line: 7 }, { side: 'left', line: 7 },
    { side: 'right', line: 7 }, { side: 'left', line: 8 }, { side: 'right', line: 9 }, { side: 'right', line: 10 }];
  const referenced = { output_text: JSON.stringify({ summary: ' Keeps service.ts. ', highlights: [{ text: ' Check oldOnly in backend/api/service.ts. ', lines: references }], focus: [{ text: 'Available diff only.', lines: [] }] }) };
  assert.deepEqual(parseAIReview(referenced, context.diff), {
    summary: 'Keeps service.ts.',
    highlights: [{ text: 'Check oldOnly in backend/api/service.ts.', lines: [{ side: 'left', line: 7 }, { side: 'right', line: 7 }, { side: 'left', line: 8 }] }],
    focus: [{ text: 'Available diff only.', lines: [] }],
  }, 'Only exact positive, safe, unique canonical references survive, capped at three per point');
  assert.deepEqual(parseAIReview(referenced)?.highlights[0].lines, [], 'Without a diff there are no verified line references');
  const unsafeAnnotation = '[new line 9007199254740992] +unverified\n[new line 07] +unverified\n[new line 7]unverified\n[new line 7] code';
  assert.deepEqual(parseAIReview(referenced, unsafeAnnotation)?.highlights[0].lines, [], 'Malformed or unsafe annotations never make a reference valid');
});
