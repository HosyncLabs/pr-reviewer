import { WORKFLOW_KEY, normalizeWorkflow, type WorkflowOptions } from './workflow';
import { isCategory, isImplementationGroup, type Category, type ClassificationRule, type ImplementationGroup } from './classifier';
import { AI_PROVIDERS, AI_STATUS_NOTICE, DEFAULT_AI_LANGUAGE, PREFERENCES_NOTICE, isAILanguage, isAIProvider, sendExtensionMessage, type AILanguage, type AIProvider, type ExtensionRequest } from './ai-protocol';

export type RepositoryPreferences = {
  overrides: Record<string, Category>;
  implementationOverrides: Record<string, ImplementationGroup>;
  rules: ClassificationRule[];
};
export const preferenceKey = (repository: string) => `pr-reviewer:repo:${repository.toLowerCase()}`;
const overridePrefix = (repository: string) => `${preferenceKey(repository)}:file:`;
const implementationPrefix = (repository: string) => `${preferenceKey(repository)}:implementation:`;

const AI_SETTINGS_KEY = 'pr-reviewer:ai-settings';
export type AIProviderSettings = { apiKey: string; model: string };
export type AISettings = AIProviderSettings & { provider: AIProvider; providers: Record<AIProvider, AIProviderSettings>; enabled: boolean; language: AILanguage };
let accessReady: Promise<void> | undefined;

/** Only extension pages and the worker may call these trusted storage helpers. */
export function secureStorage(): Promise<void> {
  accessReady ??= Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }),
  ]).then(() => undefined);
  return accessReady;
}

export async function loadPreferencesTrusted(repository: string): Promise<RepositoryPreferences> {
  await secureStorage();
  const result = await chrome.storage.local.get(null);
  const key = preferenceKey(repository);
  const stored = result[key];
  const overrides: Record<string, Category> = Object.create(null);
  const implementationOverrides: Record<string, ImplementationGroup> = Object.create(null);
  const prefix = overridePrefix(repository);
  const groupPrefix = implementationPrefix(repository);
  for (const [name, category] of Object.entries(result)) {
    if (name.startsWith(prefix) && isCategory(category)) overrides[name.slice(prefix.length)] = category;
    if (name.startsWith(groupPrefix) && isImplementationGroup(category)) implementationOverrides[name.slice(groupPrefix.length)] = category;
  }
  const rawRules = stored && typeof stored === 'object' && 'rules' in stored ? stored.rules : undefined;
  const rules = Array.isArray(rawRules) ? rawRules.filter((rule: unknown): rule is ClassificationRule =>
    !!rule && typeof rule === 'object' && 'pattern' in rule && typeof rule.pattern === 'string' &&
    'category' in rule && isCategory(rule.category)) : [];
  return { overrides, implementationOverrides, rules };
}

export async function saveOverrideTrusted(repository: string, path: string, category: Category | null) {
  await secureStorage();
  // Each path has its own storage key: corrections from different tabs do not overwrite one another.
  const key = overridePrefix(repository) + path;
  if (category) await chrome.storage.local.set({ [key]: category });
  else await chrome.storage.local.remove(key);
  await chrome.storage.session.set({ [PREFERENCES_NOTICE]: { repository: repository.toLowerCase(), nonce: crypto.randomUUID() } });
  return loadPreferencesTrusted(repository);
}

export async function saveImplementationOverrideTrusted(repository: string, path: string, group: ImplementationGroup | null) {
  await secureStorage();
  const key = implementationPrefix(repository) + path;
  if (group) await chrome.storage.local.set({ [key]: group });
  else await chrome.storage.local.remove(key);
  await chrome.storage.session.set({ [PREFERENCES_NOTICE]: { repository: repository.toLowerCase(), nonce: crypto.randomUUID() } });
  return loadPreferencesTrusted(repository);
}

async function requestPreferences(message: ExtensionRequest): Promise<RepositoryPreferences> {
  const response = await sendExtensionMessage(message);
  if (!response?.ok) throw new Error(response?.error ?? 'The extension is unavailable. Reload this GitHub tab.');
  if (!response.preferences) throw new Error('Could not load your local preferences.');
  return response.preferences;
}

export const loadPreferences = (repository: string) => requestPreferences({ type: 'preferences-load', repository });
export const saveOverride = (repository: string, path: string, category: Category | null) =>
  requestPreferences({ type: 'preferences-category', repository, path, category });
export const saveImplementationOverride = (repository: string, path: string, group: ImplementationGroup | null) =>
  requestPreferences({ type: 'preferences-implementation', repository, path, group });

export function subscribePreferences(repository: string, callback: () => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const notice = changes[PREFERENCES_NOTICE]?.newValue;
    if (area === 'session' && notice && typeof notice === 'object' && 'repository' in notice && notice.repository === repository.toLowerCase()) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function loadAISettings(): Promise<AISettings> {
  await secureStorage();
  const value = (await chrome.storage.local.get(AI_SETTINGS_KEY))[AI_SETTINGS_KEY];
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawProfiles = stored.providers && typeof stored.providers === 'object' ? stored.providers as Record<string, unknown> : {};
  const providers = Object.fromEntries((Object.keys(AI_PROVIDERS) as AIProvider[]).map(provider => {
    const raw = rawProfiles[provider];
    // Legacy flat credentials belong to OpenAI, regardless of the selected provider.
    const profile = raw && typeof raw === 'object' ? raw as Record<string, unknown> : provider === 'openai' ? stored : {};
    const apiKey = typeof profile.apiKey === 'string' && profile.apiKey.length <= 512 ? profile.apiKey : '';
    const model = typeof profile.model === 'string' && /^[a-z\d][a-z\d._:-]{0,99}$/i.test(profile.model) ? profile.model : AI_PROVIDERS[provider].defaultModel;
    return [provider, { apiKey, model }];
  })) as Record<AIProvider, AIProviderSettings>;
  const provider = isAIProvider(stored.provider) ? stored.provider : 'openai';
  const language = isAILanguage(stored.language) ? stored.language : DEFAULT_AI_LANGUAGE;
  return { ...providers[provider], provider, providers, language, enabled: stored.enabled === true && !!providers[provider].apiKey };
}

export async function saveAISettings(input: { provider?: AIProvider; apiKey?: string; enabled: boolean; model: string; language?: AILanguage; workflow?: WorkflowOptions; githubToken?: string; checklists?: Record<string, string[]> }): Promise<void> {
  if (input.provider !== undefined && !isAIProvider(input.provider)) throw new Error('Choose OpenAI, Gemini, or Claude.');
  if (input.language !== undefined && !isAILanguage(input.language)) throw new Error('Choose English or Spanish for AI responses.');
  const current = await loadAISettings();
  const provider = input.provider ?? current.provider;
  const apiKey = input.apiKey?.trim() || current.providers[provider].apiKey;
  const model = input.model.trim() || AI_PROVIDERS[provider].defaultModel;
  const language = input.language ?? current.language;
  if (apiKey.length > 512) throw new Error('The API key is too long.');
  if (!/^[a-z\d][a-z\d._:-]{0,99}$/i.test(model)) throw new Error(`Enter a valid ${AI_PROVIDERS[provider].label} model name.`);
  if (input.enabled && !apiKey) throw new Error('Add an API key before enabling AI.');
  const providers = { ...current.providers, [provider]: { apiKey, model } };
  if (input.githubToken !== undefined && input.githubToken.length > 512) throw new Error('The GitHub token is too long.');
  const extra = input.workflow ? { [WORKFLOW_KEY]: { options: normalizeWorkflow(input.workflow), githubToken: input.githubToken?.trim() || (await loadWorkflowTrusted()).githubToken, checklists: input.checklists ?? (await loadWorkflowTrusted()).checklists } } : {};
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: { provider, providers, language, enabled: input.enabled && !!apiKey }, ...extra });
  await chrome.storage.session.set({ [AI_STATUS_NOTICE]: { nonce: crypto.randomUUID() } });
}

export async function removeAIKey(provider?: AIProvider): Promise<void> {
  if (provider !== undefined && !isAIProvider(provider)) throw new Error('Choose OpenAI, Gemini, or Claude.');
  const current = await loadAISettings();
  const selected = provider ?? current.provider;
  const providers = { ...current.providers, [selected]: { ...current.providers[selected], apiKey: '' } };
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: {
    provider: current.provider, providers, language: current.language,
    enabled: selected === current.provider ? false : current.enabled,
  } });
  await chrome.storage.session.set({ [AI_STATUS_NOTICE]: { nonce: crypto.randomUUID() } });
}

export const isAISettingsChange = (changes: Record<string, chrome.storage.StorageChange>) => Object.hasOwn(changes, AI_SETTINGS_KEY) || Object.hasOwn(changes, WORKFLOW_KEY);

export async function loadWorkflowTrusted(): Promise<{ options: WorkflowOptions; githubToken: string; checklists: Record<string, string[]> }> {
  await secureStorage();
  const raw = ((await chrome.storage.local.get(WORKFLOW_KEY))[WORKFLOW_KEY] ?? {}) as Record<string, unknown>;
  const checklists: Record<string, string[]> = Object.create(null);
  if (raw.checklists && typeof raw.checklists === 'object') for (const [repo, list] of Object.entries(raw.checklists)) {
    if (/^[\w.-]+\/[\w.-]+$/.test(repo) && Array.isArray(list)) checklists[repo.toLowerCase()] = list.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 20).map(item => item.trim().slice(0, 300));
  }
  return { options: normalizeWorkflow(raw.options), githubToken: typeof raw.githubToken === 'string' && raw.githubToken.length <= 512 ? raw.githubToken : '', checklists };
}
