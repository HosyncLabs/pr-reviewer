import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { AI_PROVIDERS, AI_STATUS_NOTICE, DEFAULT_AI_MODEL, isAIProvider, type AIProvider } from '../src/ai-protocol.ts';

const [html, bundle] = await Promise.all([
  readFile(new URL('../dist/options.html', import.meta.url), 'utf8'),
  readFile(new URL('../dist/options.js', import.meta.url), 'utf8'),
]);
const settingsKey = 'pr-reviewer:ai-settings';
type Settings = { apiKey: string; enabled: boolean; model: string; language?: 'en' | 'es' };
type Profiles = Record<AIProvider, { apiKey: string; model: string }>;
type ProfileSettings = { provider: AIProvider; providers: Profiles; enabled: boolean; language: 'en' | 'es' };
type WorkerMode = 'current' | 'old-language' | 'old-provider' | 'old-model' | 'old-response-language';
const activeSettings = (stored: Record<string, unknown>): Settings => {
  const raw = stored[settingsKey] as Partial<ProfileSettings & Settings> | undefined;
  const provider = isAIProvider(raw?.provider) ? raw.provider : 'openai';
  const profile = raw?.providers?.[provider] ?? (provider === 'openai' ? raw : undefined);
  return { apiKey: profile?.apiKey ?? '', model: profile?.model ?? AI_PROVIDERS[provider].defaultModel, enabled: raw?.enabled === true && !!profile?.apiKey, language: raw?.language ?? 'en' };
};
const confirmation = (model: string, provider: AIProvider = 'openai', language = 'Español', enabled = true) =>
  `Settings saved. Provider: ${AI_PROVIDERS[provider].label}. Model: ${model}. Response language: ${language}. AI is ${enabled ? 'enabled' : 'disabled'}.`;
const warning = 'Reload PR Reviewer in chrome://extensions, then reload GitHub to apply the saved AI provider, model, and response language.';
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Options did not reach the expected state.');
};

function optionsPage(stored: Record<string, unknown>, workerMode: WorkerMode = 'current') {
  const errors: Error[] = [];
  const notices: Record<string, unknown>[] = [];
  let locked = false;
  let reads = 0;
  let writes = 0;
  let permissions = 0;
  let permissionAllowed = true;
  const requested: string[][] = [];
  const revoked: string[][] = [];
  const operations: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: 'chrome-extension://reviewer-extension/options.html', runScripts: 'outside-only', virtualConsole });
  const { window } = dom;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID });
  Object.assign(window, {
    fetch: () => assert.fail('The options page must not make API requests'),
    chrome: {
      runtime: { sendMessage: async (message: { type: string }) => {
        assert.equal(message.type, 'ai-status', 'The options compatibility check is read-only');
        const settings = activeSettings(stored);
        const provider = (stored[settingsKey] as Partial<ProfileSettings> | undefined)?.provider ?? 'openai';
        return { ok: true, status: {
          configured: !!settings.apiKey,
          enabled: settings.enabled,
          model: workerMode === 'old-model' ? 'old-model' : settings.model,
          ...(workerMode === 'old-provider' ? {} : { provider }),
          ...(workerMode === 'old-language' ? {} : { language: workerMode === 'old-response-language' ? 'en' : settings.language }),
        } };
      } },
      permissions: {
        request: async (request: { origins: string[] }) => { requested.push([...request.origins]); operations.push('permission'); permissions++; return permissionAllowed; },
        remove: async (request: { origins: string[] }) => { revoked.push([...request.origins]); return true; },
      },
      storage: {
        local: {
          setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => { assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); locked = true; },
          get: async (key: string) => { assert.ok(locked); reads++; operations.push('read'); return { [key]: structuredClone(stored[key]) }; },
          set: async (values: Record<string, unknown>) => { assert.ok(locked); writes++; operations.push('write'); Object.assign(stored, structuredClone(values)); },
        },
        session: {
          setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => assert.equal(accessLevel, 'TRUSTED_AND_UNTRUSTED_CONTEXTS'),
          set: async (values: Record<string, unknown>) => notices.push(structuredClone(values)),
        },
      },
    },
  });
  window.eval(bundle);
  const document = window.document;
  return {
    dom, window, document, errors, notices, requested, revoked, operations,
    provider: document.querySelector<HTMLSelectElement>('#provider')!,
    model: document.querySelector<HTMLSelectElement>('#model')!,
    language: document.querySelector<HTMLSelectElement>('#language')!,
    custom: document.querySelector<HTMLInputElement>('#custom-model')!,
    customField: document.querySelector<HTMLElement>('#custom-model-field')!,
    key: document.querySelector<HTMLInputElement>('#api-key')!,
    enabled: document.querySelector<HTMLInputElement>('#enabled')!,
    save: document.querySelector<HTMLButtonElement>('#save')!,
    remove: document.querySelector<HTMLButtonElement>('#remove-key')!,
    status: document.querySelector<HTMLElement>('#status')!,
    counts: () => ({ reads, writes, permissions }),
    submit: () => document.querySelector<HTMLFormElement>('#settings')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    select(value: string) { this.model.value = value; this.model.dispatchEvent(new window.Event('change', { bubbles: true })); },
    choose(value: AIProvider) { this.provider.value = value; this.provider.dispatchEvent(new window.Event('change', { bubbles: true })); },
    allowPermission(value: boolean) { permissionAllowed = value; },
  };
}

test('built options persist response language and models without exposing or replacing a blank API key', async t => {
  const key = 'test-only-existing-key';
  const stored: Record<string, unknown> = { [settingsKey]: { apiKey: key, enabled: true, model: DEFAULT_AI_MODEL } };
  const pages: ReturnType<typeof optionsPage>[] = [];
  t.after(() => pages.forEach(page => page.dom.window.close()));
  const fresh = optionsPage({});
  pages.push(fresh);
  await until(() => !fresh.save.disabled);
  assert.equal(fresh.language.value, 'en', 'New settings default to English');
  const reopen = async () => {
    const page = optionsPage(stored);
    pages.push(page);
    await until(() => !page.save.disabled);
    assert.equal(page.key.type, 'password');
    assert.equal(page.key.value, '', 'Stored API keys must never prefill the input');
    const existingKey = activeSettings(stored).apiKey;
    if (existingKey) assert.equal(page.document.body.textContent?.includes(existingKey), false);
    assert.deepEqual(page.errors, []);
    return page;
  };
  const current = await reopen();
  assert.deepEqual([...current.model.options].map(option => option.value), [DEFAULT_AI_MODEL, 'gpt-6.1-sol', 'gpt-6-astra', 'custom']);
  assert.equal(current.model.closest('details'), null, 'Model selection must remain visible');
  assert.equal(current.model.value, DEFAULT_AI_MODEL);
  assert.equal(current.customField.hidden, true);
  assert.equal(current.language.value, 'en', 'Legacy settings default to English');
  assert.equal(current.document.querySelector('label[for="language"]')?.textContent, 'AI response language');
  assert.deepEqual([...current.language.options].map(option => [option.value, option.textContent]), [['en', 'English'], ['es', 'Español']]);
  current.language.value = 'es';
  current.submit();
  await until(() => current.counts().writes === 1 && !current.save.disabled);
  assert.deepEqual(activeSettings(stored), { apiKey: key, enabled: true, model: DEFAULT_AI_MODEL, language: 'es' });
  const migrated = stored[settingsKey] as ProfileSettings;
  assert.deepEqual(Object.keys(migrated).sort(), ['enabled', 'language', 'provider', 'providers']);
  assert.equal(migrated.provider, 'openai');
  assert.deepEqual(migrated.providers, {
    openai: { apiKey: key, model: DEFAULT_AI_MODEL },
    gemini: { apiKey: '', model: AI_PROVIDERS.gemini.defaultModel },
    claude: { apiKey: '', model: AI_PROVIDERS.claude.defaultModel },
  }, 'Legacy credentials migrate only into OpenAI');
  assert.equal(current.status.textContent, confirmation(DEFAULT_AI_MODEL));
  assert.equal((await reopen()).language.value, 'es');
  for (const preset of ['gpt-6.1-sol', 'gpt-6-astra']) {
    current.select(preset);
    const before = current.counts().writes;
    current.submit();
    await until(() => current.counts().writes === before + 1 && !current.save.disabled);
    assert.deepEqual(activeSettings(stored), { apiKey: key, enabled: true, model: preset, language: 'es' });
    assert.equal(current.status.textContent, confirmation(preset));
    const restored = await reopen();
    assert.equal(restored.model.value, preset);
    assert.equal(restored.custom.value, '');
    assert.equal(restored.customField.hidden, true);
    assert.equal(restored.language.value, 'es');
  }
  const invalidLanguage = current.document.createElement('option');
  invalidLanguage.value = 'fr';
  current.language.append(invalidLanguage);
  current.language.value = 'fr';
  const beforeInvalidLanguage = current.counts();
  current.submit();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(current.counts(), beforeInvalidLanguage, 'An unsupported language must fail before storage or permissions');
  assert.ok(current.status.classList.contains('error'));
  assert.match(current.status.textContent!, /English|Spanish|language/i);
  current.language.value = 'es';
  invalidLanguage.remove();
  current.select('custom');
  assert.equal(current.customField.hidden, false);
  current.custom.value = '   ';
  const beforeInvalid = current.counts();
  current.submit();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(current.counts(), beforeInvalid, 'An empty custom model must fail before storage or permissions');
  assert.equal(current.status.textContent, 'Enter a valid OpenAI model name.');
  assert.ok(current.status.classList.contains('error'));

  const custom = 'gpt-6-luna-test-snapshot';
  current.custom.value = ` ${custom} `;
  const beforeCustom = current.counts().writes;
  current.submit();
  await until(() => current.counts().writes === beforeCustom + 1 && !current.save.disabled);
  assert.deepEqual(activeSettings(stored), { apiKey: key, enabled: true, model: custom, language: 'es' });
  assert.equal(current.status.textContent, confirmation(custom));
  const restoredCustom = await reopen();
  assert.equal(restoredCustom.model.value, 'custom');
  assert.equal(restoredCustom.custom.value, custom);
  assert.equal(restoredCustom.customField.hidden, false);
  assert.equal(restoredCustom.language.value, 'es');
  restoredCustom.key.value = 'test-only-replacement-key';
  restoredCustom.submit();
  await until(() => restoredCustom.counts().writes === 1 && !restoredCustom.save.disabled);
  assert.equal(restoredCustom.key.value, '', 'The password input is cleared after saving a replacement');
  assert.equal(activeSettings(stored).apiKey, 'test-only-replacement-key');
  const beforeRemove = restoredCustom.counts().writes;
  restoredCustom.remove.click();
  await until(() => restoredCustom.counts().writes === beforeRemove + 1 && !restoredCustom.save.disabled);
  assert.deepEqual(activeSettings(stored), { apiKey: '', enabled: false, model: custom, language: 'es' });
  const removed = await reopen();
  assert.equal(removed.language.value, 'es');
  assert.equal(removed.model.value, 'custom');
  assert.equal(removed.custom.value, custom);
  assert.equal(removed.remove.disabled, true);
  for (const page of pages) {
    for (const origins of page.requested) assert.deepEqual(origins, [AI_PROVIDERS.openai.origin]);
    for (const notice of page.notices) {
      assert.deepEqual(Object.keys(notice), [AI_STATUS_NOTICE]);
      assert.deepEqual(Object.keys(notice[AI_STATUS_NOTICE] as object), ['nonce']);
      assert.equal(typeof (notice[AI_STATUS_NOTICE] as { nonce: unknown }).nonce, 'string');
    }
    assert.deepEqual(page.errors, []);
  }
});

test('built options warn about an old worker while preserving saved language, model and key', async t => {
  const settings = { apiKey: 'test-only-compatibility-key', enabled: true, model: 'gpt-6.1-sol', language: 'es' };
  const stored: Record<string, unknown> = { [settingsKey]: settings };
  const old = optionsPage(stored, 'old-language');
  t.after(() => old.dom.window.close());
  await until(() => !old.save.disabled && old.status.textContent === warning);
  assert.equal(old.language.value, 'es');
  assert.equal(old.model.value, settings.model);
  assert.equal(old.key.value, '');
  assert.ok(old.status.classList.contains('error'));
  assert.equal(old.counts().writes, 0);
  assert.equal(old.counts().permissions, 0);
  old.submit();
  await until(() => old.counts().writes === 1 && !old.save.disabled);
  assert.deepEqual(activeSettings(stored), settings);
  assert.equal(old.status.textContent, warning);
  assert.ok(old.status.classList.contains('error'));
  assert.equal(old.key.value, '');
  assert.equal(old.document.body.textContent?.includes(settings.apiKey), false);

  const updated = optionsPage(stored);
  t.after(() => updated.dom.window.close());
  await until(() => !updated.save.disabled);
  assert.equal(updated.language.value, 'es');
  assert.equal(updated.status.classList.contains('error'), false);
  updated.submit();
  await until(() => updated.counts().writes === 1 && !updated.save.disabled);
  assert.equal(updated.status.textContent, confirmation(settings.model));
  assert.equal(updated.status.classList.contains('error'), false);
  assert.deepEqual(activeSettings(stored), settings);
  assert.deepEqual(old.errors, []);
  assert.deepEqual(updated.errors, []);
});

test('built options keep provider profiles isolated and scope permission grants and removals', async t => {
  const initial: ProfileSettings = {
    provider: 'openai', enabled: true, language: 'es', providers: {
      openai: { apiKey: 'test-only-openai-key', model: DEFAULT_AI_MODEL },
      gemini: { apiKey: 'test-only-gemini-key', model: 'gemini-custom-snapshot' },
      claude: { apiKey: 'test-only-claude-key', model: AI_PROVIDERS.claude.defaultModel },
    },
  };
  const stored: Record<string, unknown> = { [settingsKey]: structuredClone(initial) };
  const pages: ReturnType<typeof optionsPage>[] = [];
  t.after(() => pages.forEach(page => page.dom.window.close()));
  const current = optionsPage(stored);
  pages.push(current);
  await until(() => !current.save.disabled);
  current.key.value = 'unsaved-openai-key';
  const beforeSwitch = current.counts();
  current.choose('gemini');
  assert.equal(current.key.value, '', 'Switching providers clears a typed key');
  assert.equal(current.model.value, 'custom');
  assert.equal(current.custom.value, initial.providers.gemini.model);
  assert.equal(current.document.querySelector('label[for="api-key"]')?.textContent, 'Gemini API key');
  assert.equal(current.document.querySelector<HTMLAnchorElement>('#key-help')?.href, AI_PROVIDERS.gemini.keyUrl);
  assert.ok(current.document.querySelector('.notice')?.textContent?.includes('Gemini API charges'));
  assert.deepEqual(current.counts(), beforeSwitch);
  assert.deepEqual(stored[settingsKey], initial, 'Provider selection is not applied until Save');
  current.key.value = 'unsaved-gemini-key';
  current.choose('claude');
  assert.equal(current.key.value, '');
  assert.equal(current.model.value, AI_PROVIDERS.claude.defaultModel);
  assert.equal(current.custom.value, '');
  assert.deepEqual([...current.model.options].map(option => option.value), [...AI_PROVIDERS.claude.models, 'custom']);
  current.choose('gemini');
  current.key.value = '   ';
  const beforeSave = current.counts().writes;
  const beforeOperations = current.operations.length;
  current.submit();
  current.enabled.checked = false;
  current.language.value = 'en';
  await until(() => current.counts().writes === beforeSave + 1 && !current.save.disabled);
  const geminiSaved = stored[settingsKey] as ProfileSettings;
  assert.equal(geminiSaved.provider, 'gemini');
  assert.deepEqual(geminiSaved.providers, initial.providers, 'A blank key retains the selected provider and every other profile');
  assert.equal(geminiSaved.language, 'es');
  assert.equal(geminiSaved.enabled, true, 'The submitted values are captured before awaiting permission');
  assert.equal(current.enabled.checked, true);
  assert.equal(current.language.value, 'es');
  assert.equal(current.operations[beforeOperations], 'permission', 'Permission is requested directly before storage awaits');
  assert.deepEqual(current.requested, [[AI_PROVIDERS.gemini.origin]]);
  assert.equal(current.status.textContent, confirmation(initial.providers.gemini.model, 'gemini'));
  assert.equal(current.key.value, '');
  const reopened = optionsPage(stored);
  pages.push(reopened);
  await until(() => !reopened.save.disabled);
  assert.equal(reopened.provider.value, 'gemini');
  assert.equal(reopened.model.value, 'custom');
  assert.equal(reopened.custom.value, initial.providers.gemini.model);
  assert.equal(reopened.key.value, '');

  current.choose('claude');
  current.select('custom');
  current.custom.value = 'claude-custom-snapshot';
  current.key.value = 'test-only-new-claude-key';
  const beforeClaude = current.counts().writes;
  current.submit();
  await until(() => current.counts().writes === beforeClaude + 1 && !current.save.disabled);
  const claudeSaved = stored[settingsKey] as ProfileSettings;
  assert.equal(claudeSaved.provider, 'claude');
  assert.deepEqual(claudeSaved.providers.openai, initial.providers.openai);
  assert.deepEqual(claudeSaved.providers.gemini, initial.providers.gemini);
  assert.deepEqual(claudeSaved.providers.claude, { apiKey: 'test-only-new-claude-key', model: 'claude-custom-snapshot' });
  assert.deepEqual(current.requested.at(-1), [AI_PROVIDERS.claude.origin]);
  assert.equal(current.key.value, '');

  current.choose('gemini');
  const beforeRemoveGemini = current.counts().writes;
  current.remove.click();
  await until(() => current.counts().writes === beforeRemoveGemini + 1 && !current.save.disabled);
  const geminiRemoved = stored[settingsKey] as ProfileSettings;
  assert.equal(geminiRemoved.provider, 'claude');
  assert.equal(geminiRemoved.enabled, true, 'Removing an inactive provider does not disable the active provider');
  assert.deepEqual(geminiRemoved.providers.gemini, { apiKey: '', model: initial.providers.gemini.model });
  assert.deepEqual(geminiRemoved.providers.claude, claudeSaved.providers.claude);
  assert.deepEqual(current.revoked, [[AI_PROVIDERS.gemini.origin]]);
  assert.equal(current.status.textContent, 'Gemini API key removed.');
  assert.equal(current.remove.disabled, true);
  current.choose('claude');
  const beforeRemoveClaude = current.counts().writes;
  current.remove.click();
  await until(() => current.counts().writes === beforeRemoveClaude + 1 && !current.save.disabled);
  const claudeRemoved = stored[settingsKey] as ProfileSettings;
  assert.equal(claudeRemoved.enabled, false);
  assert.deepEqual(claudeRemoved.providers.claude, { apiKey: '', model: 'claude-custom-snapshot' });
  assert.deepEqual(claudeRemoved.providers.openai, initial.providers.openai);
  assert.equal(claudeRemoved.language, 'es');
  assert.deepEqual(current.revoked.at(-1), [AI_PROVIDERS.claude.origin]);
  assert.equal(current.status.textContent, 'Claude API key removed. AI is disabled.');

  current.choose('gemini');
  current.enabled.checked = true;
  current.key.value = 'test-only-denied-gemini-key';
  current.allowPermission(false);
  const beforeDenied = current.counts();
  const beforeDeniedStorage = structuredClone(stored);
  current.submit();
  await until(() => !current.save.disabled);
  assert.equal(current.counts().reads, beforeDenied.reads);
  assert.equal(current.counts().writes, beforeDenied.writes);
  assert.deepEqual(stored, beforeDeniedStorage);
  assert.equal(current.status.textContent, 'Gemini access was not allowed. Your settings were not changed.');
  assert.deepEqual(current.requested.at(-1), [AI_PROVIDERS.gemini.origin]);
  for (const page of pages) {
    for (const profile of Object.values(initial.providers)) assert.equal(page.document.body.textContent?.includes(profile.apiKey), false);
    assert.equal(page.document.body.textContent?.includes('test-only-new-claude-key'), false);
    for (const notice of page.notices) assert.deepEqual(Object.keys(notice[AI_STATUS_NOTICE] as object), ['nonce']);
    assert.deepEqual(page.errors, []);
  }
});

test('built options require a worker with matching provider, model and language', async t => {
  const profiles: Profiles = {
    openai: { apiKey: 'test-only-compat-openai-key', model: DEFAULT_AI_MODEL },
    gemini: { apiKey: 'test-only-compat-gemini-key', model: AI_PROVIDERS.gemini.defaultModel },
    claude: { apiKey: '', model: AI_PROVIDERS.claude.defaultModel },
  };
  const pages: ReturnType<typeof optionsPage>[] = [];
  t.after(() => pages.forEach(page => page.dom.window.close()));
  for (const mode of ['old-provider', 'old-model', 'old-response-language'] as const) {
    const stored: Record<string, unknown> = { [settingsKey]: { provider: 'gemini', providers: profiles, enabled: true, language: 'es' } };
    const page = optionsPage(stored, mode);
    pages.push(page);
    await until(() => !page.save.disabled);
    assert.equal(page.status.textContent, warning);
    assert.ok(page.status.classList.contains('error'));
    assert.equal(page.provider.value, 'gemini');
    assert.equal(page.counts().writes, 0);
    assert.equal(page.counts().permissions, 0);
  }
  const compatible = optionsPage({ [settingsKey]: { provider: 'openai', providers: profiles, enabled: true, language: 'es' } }, 'old-provider');
  pages.push(compatible);
  await until(() => !compatible.save.disabled);
  assert.equal(compatible.status.textContent, '', 'An otherwise matching old OpenAI worker may omit the provider field');
  assert.equal(compatible.status.classList.contains('error'), false);
  for (const page of pages) assert.deepEqual(page.errors, []);
});
