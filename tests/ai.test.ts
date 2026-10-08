import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_PROVIDERS, AI_STATUS_NOTICE, DEFAULT_AI_LANGUAGE, DEFAULT_AI_MODEL, PREFERENCES_NOTICE, type AIProvider } from '../src/ai-protocol.ts';

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

test('AI worker protects credentials, scopes preferences, isolates providers, bounds requests, caches comparisons, and cancels stale reviews', async t => {
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
  const permissionRequests: string[][] = [];
  let opened = false;
  const changes = (items: Record<string, unknown>, area: string) => {
    const payload = Object.fromEntries(Object.entries(items).map(([name, newValue]) => [name, { newValue }]));
    for (const listener of listeners) listener(payload, area);
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { id: sender.id, onMessage: { addListener() {} }, openOptionsPage: async () => { opened = true; } },
    permissions: { contains: async (request: { origins: string[] }) => { permissionRequests.push(request.origins); return permission; } },
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
  assert.deepEqual(await call({ type: 'ai-status' }), { ok: true, status: { configured: true, enabled: true, model: DEFAULT_AI_MODEL, language: DEFAULT_AI_LANGUAGE, provider: 'openai' } });
  const legacy = stored['pr-reviewer:ai-settings'];
  stored['pr-reviewer:ai-settings'] = { ...(legacy as object), language: 'fr' };
  assert.equal((await loadAISettings()).language, 'en', 'Invalid saved languages fall back to English');
  assert.deepEqual(await call({ type: 'ai-status' }), { ok: true, status: { configured: true, enabled: true, model: DEFAULT_AI_MODEL, language: 'en', provider: 'openai' } });
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

  const requests: { url: string; body: Record<string, any>; signal: AbortSignal; headers: Record<string, string> }[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${key}`);
    const body = JSON.parse(init!.body as string);
    requests.push({ url: String(url), body, signal: init!.signal!, headers: init!.headers as Record<string, string> });
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

  const reviewText = responseData.output[0].content[0].text;
  const providerResponse = (provider: AIProvider) => provider === 'gemini'
    ? { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ thought: true, text: '{"summary":"Not the review"}' }, { text: reviewText }] } }] }
    : provider === 'claude'
      ? { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Not the review' }, { type: 'text', text: reviewText }] }
      : responseData;
  for (const provider of ['gemini', 'claude'] as const) {
    const profileKey = `${provider}-test-only-key-placeholder`;
    const model = AI_PROVIDERS[provider].defaultModel;
    await saveAISettings({ provider, apiKey: profileKey, enabled: true, model, language: 'es' });
    await saveAISettings({ provider, apiKey: '   ', enabled: true, model });
    assert.equal((await loadAISettings()).apiKey, profileKey, 'A blank direct settings save preserves the selected provider key');
    const status = await call({ type: 'ai-status' });
    assert.deepEqual(status, { ok: true, status: { configured: true, enabled: true, model, language: 'es', provider } });
    assert.equal(JSON.stringify(status).includes(profileKey), false);
    let envelope: unknown = providerResponse(provider);
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.method, 'POST');
      assert.equal(init.redirect, 'error');
      requests.push({ url: String(url), body: JSON.parse(init!.body as string), signal: init!.signal!, headers: init!.headers as Record<string, string> });
      return new Response(JSON.stringify(envelope), { status: 200 });
    };
    const before: number = requests.length;
    const result = await call(reviewMessage(`${provider}-review`));
    assert.deepEqual(result, reviewed, 'Every provider uses the same exact-line whitelist, including distinct old/new numbers');
    assert.deepEqual(permissionRequests.at(-1), [AI_PROVIDERS[provider].origin]);
    const request = requests.at(-1)!;
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.equal(request.headers.Authorization, undefined, 'Other providers must not receive the OpenAI credential header');
    assert.equal(JSON.stringify(request.body).includes(profileKey), false, 'Credentials belong only in headers');
    if (provider === 'gemini') {
      assert.equal(request.url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
      assert.equal(request.headers['x-goog-api-key'], profileKey);
      assert.equal(request.headers['x-api-key'], undefined);
      assert.match(request.body.systemInstruction.parts[0].text, /string values in Spanish/);
      assert.deepEqual(JSON.parse(request.body.contents[0].parts[0].text), context);
      assert.equal(request.body.contents[0].role, 'user');
      assert.equal(request.body.generationConfig.maxOutputTokens, 4000);
      assert.equal(request.body.generationConfig.responseFormat.text.mimeType, 'application/json');
      assert.deepEqual(request.body.generationConfig.responseFormat.text.schema, schema);
      assert.equal(request.body.generationConfig.responseMimeType, undefined);
      assert.equal(request.body.generationConfig.responseJsonSchema, undefined);
    } else {
      assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
      assert.equal(request.headers['x-api-key'], profileKey);
      assert.equal(request.headers['x-goog-api-key'], undefined);
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      assert.equal(request.headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.equal(request.body.model, model);
      assert.equal(request.body.max_tokens, 4000);
      assert.match(request.body.system, /string values in Spanish/);
      assert.deepEqual(JSON.parse(request.body.messages[0].content), context);
      assert.equal(request.body.messages[0].role, 'user');
      assert.equal(request.body.output_config.format.type, 'json_schema');
      const transport = request.body.output_config.format.schema;
      assert.equal(transport.additionalProperties, false);
      assert.deepEqual(transport.required, ['summary', 'highlights', 'focus']);
      for (const name of ['highlights', 'focus']) {
        assert.equal(transport.properties[name].maxItems, undefined);
        assert.equal(transport.properties[name].items.additionalProperties, false);
        const lines = transport.properties[name].items.properties.lines;
        assert.equal(lines.maxItems, undefined);
        assert.deepEqual(lines.items.properties.line, { type: 'integer' });
        assert.equal(lines.items.additionalProperties, false);
      }
    }
    await call(reviewMessage(`${provider}-cached`));
    assert.equal(requests.length, before + 1, 'Completed reviews reuse only the selected provider cache');
    const badEnvelopes: unknown[] = provider === 'gemini' ? [
      { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: reviewText }] } }] },
      { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: reviewText }] } }] },
      { promptFeedback: { blockReason: 'SAFETY' }, ...providerResponse(provider) },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: reviewText }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{broken' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [null, { text: reviewText }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { role: 'user', parts: [{ text: reviewText }] } }] },
      { candidates: [] },
    ] : [
      { ...providerResponse(provider), stop_reason: 'max_tokens' },
      { ...providerResponse(provider), stop_reason: 'refusal' },
      { ...providerResponse(provider), stop_reason: 'model_context_window_exceeded' },
      { ...providerResponse(provider), content: [{ type: 'refusal', text: reviewText }] },
      { ...providerResponse(provider), content: [{ type: 'thinking', thinking: reviewText }] },
      { ...providerResponse(provider), content: [{ type: 'text', text: '{broken' }] },
      { ...providerResponse(provider), role: 'user' },
    ];
    for (const [index, bad] of badEnvelopes.entries()) {
      envelope = bad;
      const result = await call(reviewMessage(`${provider}-bad-${index}`, { diff: `${context.diff}\n${provider} envelope ${index}` }));
      assert.match(!result.ok ? result.error : '', new RegExp(`${AI_PROVIDERS[provider].label} returned an incomplete or unexpected review`));
    }
    for (const httpStatus of [400, 401, 403, 404, 429, 503]) {
      let attempts = 0;
      globalThis.fetch = async url => {
        attempts++;
        assert.equal(new URL(String(url)).origin, new URL(AI_PROVIDERS[provider].origin).origin, 'Failures must never fall back to another provider');
        return { ok: false, status: httpStatus, json: () => assert.fail('Raw API errors must not be read or exposed') } as unknown as Response;
      };
      const result = await call(reviewMessage(`${provider}-http-${httpStatus}`, { diff: `${context.diff}\n${provider} error ${httpStatus}` }));
      assert.equal(result.ok, false);
      assert.match(!result.ok ? result.error : '', new RegExp(AI_PROVIDERS[provider].label));
      assert.equal(JSON.stringify(result).includes(profileKey), false);
      assert.equal(attempts, 1);
    }
    permission = false;
    globalThis.fetch = async () => { assert.fail('Denied provider permission must prevent fetching'); };
    assert.match(JSON.stringify(await call(reviewMessage(`${provider}-permission`))), new RegExp(`Allow access to ${AI_PROVIDERS[provider].label}`));
    assert.deepEqual(permissionRequests.at(-1), [AI_PROVIDERS[provider].origin]);
    permission = true;
    await removeAIKey(provider);
    assert.match(JSON.stringify(await call(reviewMessage(`${provider}-missing-key`))), new RegExp(`Add your ${AI_PROVIDERS[provider].label} API key`));
    await saveAISettings({ provider, apiKey: profileKey, enabled: true, model });
  }

  // Keep the same model and input while switching without a storage event to isolate the cache's provider component.
  const profiles = (await loadAISettings()).providers;
  let selectedProvider: AIProvider = 'openai';
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init!.body as string), signal: init!.signal!, headers: init!.headers as Record<string, string> });
    return new Response(JSON.stringify(providerResponse(selectedProvider)), { status: 200 });
  };
  const beforeProviderCache = requests.length;
  for (const provider of ['openai', 'gemini', 'claude', 'openai'] as const) {
    selectedProvider = provider;
    stored['pr-reviewer:ai-settings'] = { provider, enabled: true, language: 'en', providers: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { ...profile, model: 'shared-test-model' }])) };
    assert.equal((await call(reviewMessage(`${provider}-cache-scope`, { path: 'provider-cache.ts' }))).ok, true);
  }
  assert.equal(requests.length, beforeProviderCache + 3, 'Identical model/input across providers stay isolated, while returning to one provider reuses its own review');

  await saveAISettings({ provider: 'gemini', enabled: true, model: AI_PROVIDERS.gemini.defaultModel });
  let settingsSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    settingsSignal = init!.signal!;
    settingsSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const changingProvider = call(reviewMessage('settings-cancel', { diff: 'pending provider review' }));
  await until(() => !!settingsSignal);
  await saveAISettings({ provider: 'openai', enabled: true, model: DEFAULT_AI_MODEL, language: 'es' });
  assert.deepEqual(await changingProvider, { ok: false, error: 'Analysis canceled.' }, 'Changing provider aborts the previous provider request');
  assert.ok((settingsSignal as unknown as AbortSignal).aborted);

  await saveAISettings({ enabled: false, model: DEFAULT_AI_MODEL });
  assert.deepEqual(Object.keys(notices[AI_STATUS_NOTICE] as object), ['nonce']);
  assert.deepEqual(await call(reviewMessage('disabled')), { ok: false, error: 'AI is disabled. Enable it in AI settings.' });
  await saveAISettings({ enabled: true, model: DEFAULT_AI_MODEL });
  permission = false;
  assert.match(JSON.stringify(await call(reviewMessage('permission'))), /Allow access to OpenAI/);
  await removeAIKey();
  assert.deepEqual(await call({ type: 'ai-status' }), { ok: true, status: { configured: false, enabled: false, model: DEFAULT_AI_MODEL, language: 'es', provider: 'openai' } });
  assert.equal(parseAIReview({ ...responseData, status: 'incomplete' }), null);
  assert.equal(parseAIReview({ output: [{ type: 'message', content: [null, { type: 'refusal', refusal: 'No review' }] }] }), null);
  assert.equal(parseAIReview({ ...responseData, output_text: reviewText, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No review' }] }] }, context.diff), null, 'A refusal cannot be bypassed by a second text field');
  assert.equal(parseAIReview({ ...responseData, status: 'in_progress' }, context.diff), null);
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
