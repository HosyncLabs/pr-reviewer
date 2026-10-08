import { AI_LANGUAGE_LABELS, AI_PROVIDERS, isAILanguage, isAIProvider, sendExtensionMessage, type AIProvider } from './ai-protocol';
import { loadAISettings, removeAIKey, saveAISettings, type AISettings } from './storage';

const form = document.querySelector<HTMLFormElement>('#settings')!;
const provider = document.querySelector<HTMLSelectElement>('#provider')!;
const apiKey = document.querySelector<HTMLInputElement>('#api-key')!;
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const model = document.querySelector<HTMLSelectElement>('#model')!;
const language = document.querySelector<HTMLSelectElement>('#language')!;
const customModel = document.querySelector<HTMLInputElement>('#custom-model')!;
const customModelField = document.querySelector<HTMLElement>('#custom-model-field')!;
const savedKey = document.querySelector<HTMLElement>('#saved-key')!;
const status = document.querySelector<HTMLElement>('#status')!;
const save = document.querySelector<HTMLButtonElement>('#save')!;
const remove = document.querySelector<HTMLButtonElement>('#remove-key')!;
let settings: AISettings;
let configured = false;
const reloadWarning = 'Reload PR Reviewer in chrome://extensions, then reload GitHub to apply the saved AI provider, model, and response language.';

function message(text: string, failed = false) {
  status.textContent = text;
  status.classList.toggle('error', failed);
}

async function workerUsesSettings(settings: AISettings): Promise<boolean> {
  try {
    const response = await sendExtensionMessage({ type: 'ai-status' });
    return response.ok && !!response.status &&
      (response.status.provider === settings.provider || response.status.provider === undefined && settings.provider === 'openai') &&
      response.status.model === settings.model && response.status.language === settings.language &&
      response.status.configured === !!settings.apiKey && response.status.enabled === settings.enabled;
  } catch { return false; }
}

function updateKeyState() {
  savedKey.textContent = configured ? 'An API key is saved. Leave this field blank to keep it.' : 'No API key is saved.';
  remove.disabled = !configured;
}

function setModel(value: string) {
  const preset = [...model.options].some(option => option.value !== 'custom' && option.value === value);
  model.value = preset ? value : 'custom';
  customModel.value = preset ? '' : value;
  customModelField.hidden = preset;
}

function showProvider(selected: AIProvider) {
  const catalog = AI_PROVIDERS[selected];
  configured = !!settings.providers[selected].apiKey;
  apiKey.value = '';
  document.querySelector('label[for="api-key"]')!.textContent = `${catalog.label} API key`;
  document.querySelector('label[for="model"]')!.textContent = `${catalog.label} model`;
  const keyLink = document.querySelector<HTMLAnchorElement>('#key-help')!;
  keyLink.href = catalog.keyUrl;
  keyLink.textContent = `Get ${selected === 'openai' ? 'an' : 'a'} ${catalog.label} API key`;
  document.querySelector('#model-hint')!.textContent = `Your selection is used for every file review. Availability depends on your ${catalog.label} account.`;
  document.querySelector('#custom-model-hint')!.textContent = selected === 'openai' ?
    'Use a model that supports Responses structured outputs and low reasoning effort.' : 'Use a model that supports structured JSON output.';
  customModel.placeholder = `Enter a ${catalog.label} model ID`;
  document.querySelector('.notice')!.textContent = `When enabled, opening a file sends its path and available diff to ${catalog.label}. The diff may be incomplete. ${catalog.label} API charges apply. The extension does not post comments or change your review.`;
  model.replaceChildren(...catalog.models.map(id => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${id}${id === catalog.defaultModel ? ' (default)' : ''}`;
    return option;
  }));
  const custom = document.createElement('option');
  custom.value = 'custom'; custom.textContent = 'Custom model…'; model.append(custom);
  setModel(settings.providers[selected].model);
  updateKeyState();
}

provider.addEventListener('change', () => {
  if (settings && isAIProvider(provider.value)) { showProvider(provider.value); message('Save settings to use this provider.'); }
});

model.addEventListener('change', () => {
  customModelField.hidden = model.value !== 'custom';
  if (!customModelField.hidden) customModel.focus();
});

async function load() {
  try {
    settings = await loadAISettings();
    provider.value = settings.provider;
    enabled.checked = settings.enabled;
    language.value = settings.language;
    showProvider(settings.provider);
    if (!await workerUsesSettings(settings)) message(reloadWarning, true);
    save.disabled = false;
  } catch { message('Could not load secure settings. Reload the extension and try again.', true); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const selected = provider.value;
  if (!isAIProvider(selected)) return message('Choose OpenAI, Gemini, or Claude.', true);
  const catalog = AI_PROVIDERS[selected];
  const replacement = apiKey.value.trim();
  const modelName = model.value === 'custom' ? customModel.value.trim() : model.value;
  const responseLanguage = language.value;
  const targetEnabled = enabled.checked;
  if (targetEnabled && !replacement && !configured) return message('Add an API key before enabling AI.', true);
  if (!/^[a-z\d][a-z\d._:-]{0,99}$/i.test(modelName)) return message(`Enter a valid ${catalog.label} model name.`, true);
  if (!isAILanguage(responseLanguage)) return message('Choose English or Español for the AI response language.', true);
  save.disabled = true;
  remove.disabled = true;
  provider.disabled = true;
  message('Saving…');
  try {
    // Request optional access directly from this user gesture, before any storage await.
    if (targetEnabled && !await chrome.permissions.request({ origins: [catalog.origin] })) {
      message(`${catalog.label} access was not allowed. Your settings were not changed.`, true);
      return;
    }
    await saveAISettings({ provider: selected, apiKey: replacement || undefined, enabled: targetEnabled, model: modelName, language: responseLanguage });
    settings = await loadAISettings();
    enabled.checked = settings.enabled;
    language.value = settings.language;
    showProvider(selected);
    const applied = await workerUsesSettings(settings);
    message(applied ? `Settings saved. Provider: ${catalog.label}. Model: ${modelName}. Response language: ${AI_LANGUAGE_LABELS[responseLanguage]}. AI is ${targetEnabled ? 'enabled' : 'disabled'}.` : reloadWarning, !applied);
  } catch { message('Could not save secure settings. Reload the extension and try again.', true); }
  finally { save.disabled = false; provider.disabled = false; updateKeyState(); }
});

remove.addEventListener('click', async () => {
  const selected = provider.value;
  if (!isAIProvider(selected)) return;
  const catalog = AI_PROVIDERS[selected];
  save.disabled = true;
  remove.disabled = true;
  provider.disabled = true;
  try {
    await removeAIKey(selected);
    await chrome.permissions.remove({ origins: [catalog.origin] }).catch(() => undefined);
    settings = await loadAISettings();
    enabled.checked = settings.enabled;
    showProvider(selected);
    message(`${catalog.label} API key removed.${selected === settings.provider ? ' AI is disabled.' : ''}`);
  } catch { message('Could not remove the API key. Reload the extension and try again.', true); }
  finally { save.disabled = false; provider.disabled = false; updateKeyState(); }
});

void load();
