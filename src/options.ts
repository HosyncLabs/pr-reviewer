import { AI_LANGUAGE_LABELS, isAILanguage, OPENAI_ORIGIN, type AILanguage, type ExtensionResponse } from './ai-protocol';
import { loadAISettings, removeAIKey, saveAISettings } from './storage';

const form = document.querySelector<HTMLFormElement>('#settings')!;
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
let configured = false;
const reloadWarning = 'Reload PR Reviewer in chrome://extensions, then reload GitHub to apply the saved AI response language.';

function message(text: string, failed = false) {
  status.textContent = text;
  status.classList.toggle('error', failed);
}

async function workerUsesLanguage(responseLanguage: AILanguage): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ai-status' }) as ExtensionResponse;
    return response.ok && response.status?.language === responseLanguage;
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

model.addEventListener('change', () => {
  customModelField.hidden = model.value !== 'custom';
  if (!customModelField.hidden) customModel.focus();
});

async function load() {
  try {
    const settings = await loadAISettings();
    configured = !!settings.apiKey;
    enabled.checked = settings.enabled;
    setModel(settings.model);
    language.value = settings.language;
    updateKeyState();
    if (!await workerUsesLanguage(settings.language)) message(reloadWarning, true);
    save.disabled = false;
  } catch { message('Could not load secure settings. Reload the extension and try again.', true); }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const replacement = apiKey.value.trim();
  const modelName = model.value === 'custom' ? customModel.value.trim() : model.value;
  const responseLanguage = language.value;
  if (enabled.checked && !replacement && !configured) return message('Add an API key before enabling AI.', true);
  if (!/^[a-z\d][a-z\d._:-]{0,99}$/i.test(modelName)) return message('Enter a valid OpenAI model name.', true);
  if (!isAILanguage(responseLanguage)) return message('Choose English or Español for the AI response language.', true);
  save.disabled = true;
  remove.disabled = true;
  message('Saving…');
  try {
    // Request optional access directly from this user gesture, before any storage await.
    if (enabled.checked && !await chrome.permissions.request({ origins: [OPENAI_ORIGIN] })) {
      message('OpenAI access was not allowed. Your settings were not changed.', true);
      return;
    }
    await saveAISettings({ apiKey: replacement || undefined, enabled: enabled.checked, model: modelName, language: responseLanguage });
    configured = !!replacement || configured;
    apiKey.value = '';
    setModel(modelName);
    const applied = await workerUsesLanguage(responseLanguage);
    message(applied ? `Settings saved. Model: ${modelName}. Response language: ${AI_LANGUAGE_LABELS[responseLanguage]}. AI is ${enabled.checked ? 'enabled' : 'disabled'}.` : reloadWarning, !applied);
  } catch { message('Could not save secure settings. Reload the extension and try again.', true); }
  finally { save.disabled = false; updateKeyState(); }
});

remove.addEventListener('click', async () => {
  save.disabled = true;
  remove.disabled = true;
  try {
    await removeAIKey();
    await chrome.permissions.remove({ origins: [OPENAI_ORIGIN] }).catch(() => undefined);
    configured = false;
    enabled.checked = false;
    apiKey.value = '';
    message('API key removed. AI is disabled.');
  } catch { message('Could not remove the API key. Reload the extension and try again.', true); }
  finally { save.disabled = false; updateKeyState(); }
});

void load();
