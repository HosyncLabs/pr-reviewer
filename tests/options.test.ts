import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { AI_STATUS_NOTICE, DEFAULT_AI_MODEL, OPENAI_ORIGIN } from '../src/ai-protocol.ts';

const [html, bundle] = await Promise.all([
  readFile(new URL('../dist/options.html', import.meta.url), 'utf8'),
  readFile(new URL('../dist/options.js', import.meta.url), 'utf8'),
]);
const settingsKey = 'pr-reviewer:ai-settings';
type Settings = { apiKey: string; enabled: boolean; model: string; language?: 'en' | 'es' };
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Options did not reach the expected state.');
};

function optionsPage(stored: Record<string, unknown>, oldWorker = false) {
  const errors: Error[] = [];
  const notices: Record<string, unknown>[] = [];
  let locked = false;
  let reads = 0;
  let writes = 0;
  let permissions = 0;
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
        const settings = stored[settingsKey] as Partial<Settings> | undefined;
        return { ok: true, status: {
          configured: !!settings?.apiKey,
          enabled: settings?.enabled === true && !!settings?.apiKey,
          model: settings?.model ?? DEFAULT_AI_MODEL,
          ...(oldWorker ? {} : { language: settings?.language ?? 'en' }),
        } };
      } },
      permissions: {
        request: async (request: { origins: string[] }) => { assert.deepEqual([...request.origins], [OPENAI_ORIGIN]); permissions++; return true; },
        remove: async () => true,
      },
      storage: {
        local: {
          setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => { assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); locked = true; },
          get: async (key: string) => { assert.ok(locked); reads++; return { [key]: structuredClone(stored[key]) }; },
          set: async (values: Record<string, unknown>) => { assert.ok(locked); writes++; Object.assign(stored, structuredClone(values)); },
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
    dom, window, document, errors, notices,
    model: document.querySelector<HTMLSelectElement>('#model')!,
    language: document.querySelector<HTMLSelectElement>('#language')!,
    custom: document.querySelector<HTMLInputElement>('#custom-model')!,
    customField: document.querySelector<HTMLElement>('#custom-model-field')!,
    key: document.querySelector<HTMLInputElement>('#api-key')!,
    save: document.querySelector<HTMLButtonElement>('#save')!,
    remove: document.querySelector<HTMLButtonElement>('#remove-key')!,
    status: document.querySelector<HTMLElement>('#status')!,
    counts: () => ({ reads, writes, permissions }),
    submit: () => document.querySelector<HTMLFormElement>('#settings')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    select(value: string) { this.model.value = value; this.model.dispatchEvent(new window.Event('change', { bubbles: true })); },
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
    const existingKey = (stored[settingsKey] as Settings).apiKey;
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
  assert.deepEqual(stored[settingsKey], { apiKey: key, enabled: true, model: DEFAULT_AI_MODEL, language: 'es' });
  assert.equal(current.status.textContent, `Settings saved. Model: ${DEFAULT_AI_MODEL}. Response language: Español. AI is enabled.`);
  assert.equal((await reopen()).language.value, 'es');
  for (const preset of ['gpt-6.1-sol', 'gpt-6-astra']) {
    current.select(preset);
    const before = current.counts().writes;
    current.submit();
    await until(() => current.counts().writes === before + 1 && !current.save.disabled);
    assert.deepEqual(stored[settingsKey], { apiKey: key, enabled: true, model: preset, language: 'es' });
    assert.equal(current.status.textContent, `Settings saved. Model: ${preset}. Response language: Español. AI is enabled.`);
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
  assert.deepEqual(stored[settingsKey], { apiKey: key, enabled: true, model: custom, language: 'es' });
  assert.equal(current.status.textContent, `Settings saved. Model: ${custom}. Response language: Español. AI is enabled.`);
  const restoredCustom = await reopen();
  assert.equal(restoredCustom.model.value, 'custom');
  assert.equal(restoredCustom.custom.value, custom);
  assert.equal(restoredCustom.customField.hidden, false);
  assert.equal(restoredCustom.language.value, 'es');
  restoredCustom.key.value = 'test-only-replacement-key';
  restoredCustom.submit();
  await until(() => restoredCustom.counts().writes === 1 && !restoredCustom.save.disabled);
  assert.equal(restoredCustom.key.value, '', 'The password input is cleared after saving a replacement');
  assert.equal((stored[settingsKey] as Settings).apiKey, 'test-only-replacement-key');
  const beforeRemove = restoredCustom.counts().writes;
  restoredCustom.remove.click();
  await until(() => restoredCustom.counts().writes === beforeRemove + 1 && !restoredCustom.save.disabled);
  assert.deepEqual(stored[settingsKey], { apiKey: '', enabled: false, model: custom, language: 'es' });
  const removed = await reopen();
  assert.equal(removed.language.value, 'es');
  assert.equal(removed.model.value, 'custom');
  assert.equal(removed.custom.value, custom);
  assert.equal(removed.remove.disabled, true);
  for (const page of pages) {
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
  const warning = 'Reload PR Reviewer in chrome://extensions, then reload GitHub to apply the saved AI response language.';
  const old = optionsPage(stored, true);
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
  assert.deepEqual(stored[settingsKey], settings);
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
  assert.equal(updated.status.textContent, `Settings saved. Model: ${settings.model}. Response language: Español. AI is enabled.`);
  assert.equal(updated.status.classList.contains('error'), false);
  assert.deepEqual(stored[settingsKey], settings);
  assert.deepEqual(old.errors, []);
  assert.deepEqual(updated.errors, []);
});
