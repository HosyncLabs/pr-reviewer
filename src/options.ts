import { AI_LANGUAGE_LABELS, AI_PROVIDERS, isAILanguage, isAIProvider, sendExtensionMessage, type AIProvider } from './ai-protocol';
import { loadAISettings, removeAIKey, saveAISettings, type AISettings, loadWorkflowTrusted } from './storage';
import { WORKFLOW_KEY, DEFAULT_WORKFLOW, NUMBER_LIMITS, normalizeWorkflow, type WorkflowOptions } from './workflow';

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
let workflow: Awaited<ReturnType<typeof loadWorkflowTrusted>>;
const optionLabels: Record<string, [string, string]> = {
  persistProgress: ['Save progress and notes', 'Remember reviewed/dismissed blocks, files, private notes, and your last file. Changed diffs reopen for review.'],
  nextPending: ['Next pending navigation', 'Show a next pending button and completion counts per module.'],
  syncViewed: ['Sync file completion with GitHub Viewed', 'When you mark a whole file reviewed or pending, update its native Viewed checkbox when available.'],
  riskPriority: ['Prioritize sensitive paths', 'Access, money, database and deletion paths come first. These are path heuristics, separate from change volume.'],
  findingDetails: ['Show finding type, severity and evidence', 'Distinguish possible bugs, questions, and suggestions.'],
  suggestions: ['Enable Add suggestion', 'Open an editable GitHub suggestion for a verified single changed line.'],
  checklist: ['Enable repository checklists', 'Track your criteria per file and include them in AI instructions.'],
  automatic: ['Analyze automatically when opening files', 'Turn off to generate reviews only when you press Analyze file.'],
  expandedContext: ['Use GitHub API diff and surrounding source', 'Opt in to sending more code to the selected AI provider, bounded by the limits below.'],
  moduleReview: ['Enable module review', 'Show a manual Analyze module action and optional related-file selection across packages.'],
  cacheReviews: ['Cache AI reviews locally', 'Reuse identical provider/model/language/context reviews across reloads. Refresh review bypasses the cache.'],
};
for (const [key, [label, hint]] of Object.entries(optionLabels)) {
  const container = document.createElement('div');
  const control = document.createElement('input'); control.type = 'checkbox'; control.id = `workflow-${key}`;
  const heading = document.createElement('label'); heading.className = 'checkbox'; heading.append(control, document.createTextNode(label));
  const help = document.createElement('p'); help.className = 'hint'; help.textContent = hint;
  container.append(heading, help); document.querySelector('#workflow-options')!.append(container);
}
const limitLabels = { maxContextChars: 'Maximum context characters', maxOutputTokens: 'Maximum output tokens', dailyRequests: 'Daily AI requests (0 = unlimited, resets at UTC midnight)', moduleFileLimit: 'Maximum files per module analysis', contextLines: 'Surrounding lines per change (0 = diff only)' };
for (const [key, [min, max]] of Object.entries(NUMBER_LIMITS)) {
  const heading = document.createElement('label'); heading.htmlFor = `workflow-${key}`; heading.textContent = limitLabels[key as keyof typeof limitLabels];
  const control = document.createElement('input'); control.type = 'number'; control.id = heading.htmlFor; control.min = String(min); control.max = String(max); control.required = true;
  document.querySelector('#workflow-limits')!.append(heading, control);
}
const githubToken = document.querySelector<HTMLInputElement>('#github-token')!;
const checklistRepo = document.querySelector<HTMLInputElement>('#checklist-repo')!;
const checklistItems = document.querySelector<HTMLTextAreaElement>('#checklist-items')!;
checklistRepo.addEventListener('change', () => { checklistItems.value = workflow?.checklists[checklistRepo.value.trim().toLowerCase()]?.join('\n') ?? ''; });
function showWorkflow() {
  for (const [key, value] of Object.entries(workflow.options)) {
    const control = document.querySelector<HTMLInputElement>(`#workflow-${key}`)!;
    if (typeof value === 'boolean') control.checked = value; else control.value = String(value);
  }
  githubToken.value = '';
  document.querySelector('#github-token-state')!.textContent = workflow.githubToken ? 'A GitHub token is saved. Leave blank to keep it.' : 'No GitHub token saved.';
  (document.querySelector('#remove-github-token') as HTMLButtonElement).disabled = !workflow.githubToken;
}
function readWorkflow(): WorkflowOptions {
  const values = Object.fromEntries(Object.entries(DEFAULT_WORKFLOW).map(([key, value]) => {
    const control = document.querySelector<HTMLInputElement>(`#workflow-${key}`)!;
    return [key, typeof value === 'boolean' ? control.checked : Number(control.value)];
  }));
  return normalizeWorkflow(values);
}

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
      response.status.configured === !!settings.apiKey && response.status.enabled === settings.enabled &&
      !!response.status.options && JSON.stringify(normalizeWorkflow(response.status.options)) === JSON.stringify(workflow.options) &&
      response.status.githubConfigured === !!workflow.githubToken;
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
  document.querySelector('#ai-privacy')!.textContent = `Each AI analysis sends the selected path and diff/context to ${catalog.label}. Automatic analysis and expanded scope are configurable below. The diff may be incomplete. ${catalog.label} API charges apply. The extension does not post comments or change your review.`;
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
    workflow = await loadWorkflowTrusted(); showWorkflow();
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
  const options = readWorkflow();
  const repository = checklistRepo.value.trim().toLowerCase();
  if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) return message('Enter a repository as owner/repo.', true);
  const checklists = { ...workflow.checklists };
  if (repository) checklists[repository] = checklistItems.value.split('\n').map(item => item.trim()).filter(Boolean).slice(0, 20).map(item => item.slice(0, 300));
  if (targetEnabled && !replacement && !configured) return message('Add an API key before enabling AI.', true);
  if (!/^[a-z\d][a-z\d._:-]{0,99}$/i.test(modelName)) return message(`Enter a valid ${catalog.label} model name.`, true);
  if (!isAILanguage(responseLanguage)) return message('Choose English or Español for the AI response language.', true);
  save.disabled = true;
  remove.disabled = true;
  provider.disabled = true;
  message('Saving…');
  try {
    // Request optional access directly from this user gesture, before any storage await.
    const origins = [...(targetEnabled ? [catalog.origin] : []), ...(options.expandedContext || options.moduleReview ? ['https://api.github.com/*'] : [])];
    if (origins.length && !await chrome.permissions.request({ origins })) {
      message(`${catalog.label} access was not allowed. Your settings were not changed.`, true); return;
    }
    await saveAISettings({ workflow: options, githubToken: githubToken.value || undefined, checklists, provider: selected, apiKey: replacement || undefined, enabled: targetEnabled, model: modelName, language: responseLanguage });
    settings = await loadAISettings();
    workflow = await loadWorkflowTrusted(); showWorkflow();
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
    workflow = await loadWorkflowTrusted(); showWorkflow();
    enabled.checked = settings.enabled;
    showProvider(selected);
    message(`${catalog.label} API key removed.${selected === settings.provider ? ' AI is disabled.' : ''}`);
  } catch { message('Could not remove the API key. Reload the extension and try again.', true); }
  finally { save.disabled = false; provider.disabled = false; updateKeyState(); }
});

void load();

document.querySelector('#remove-github-token')!.addEventListener('click', async () => {
  try { await chrome.storage.local.set({ [WORKFLOW_KEY]: { ...workflow, githubToken: '' } });
    workflow = await loadWorkflowTrusted(); showWorkflow();
    await chrome.storage.session.set({ 'pr-reviewer:ai-status-change': { nonce: crypto.randomUUID() } });
    message('GitHub token removed. Public repositories can still use API context.');
  } catch { message('Could not remove the GitHub token.', true); }
});
for (const kind of ['cache', 'progress']) document.querySelector(`#clear-${kind}`)!.addEventListener('click', async () => {
  try {
    const values = await chrome.storage.local.get(null);
    for (const key of Object.keys(values).filter(key => key.startsWith(`pr-reviewer:${kind}:`))) await chrome.storage.local.remove(key);
    message(kind === 'cache' ? 'Cached reviews cleared.' : 'Saved progress and notes cleared. Reload GitHub to update the panel.');
  } catch { message('Could not clear local data.', true); }
});
