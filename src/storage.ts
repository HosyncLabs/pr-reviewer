import { isCategory, isImplementationGroup, type Category, type ClassificationRule, type ImplementationGroup } from './classifier';
import { AI_STATUS_NOTICE, DEFAULT_AI_LANGUAGE, DEFAULT_AI_MODEL, PREFERENCES_NOTICE, isAILanguage, type AILanguage, type ExtensionRequest, type ExtensionResponse } from './ai-protocol';

export type RepositoryPreferences = {
  overrides: Record<string, Category>;
  implementationOverrides: Record<string, ImplementationGroup>;
  rules: ClassificationRule[];
};
export const preferenceKey = (repository: string) => `pr-reviewer:repo:${repository.toLowerCase()}`;
const overridePrefix = (repository: string) => `${preferenceKey(repository)}:file:`;
const implementationPrefix = (repository: string) => `${preferenceKey(repository)}:implementation:`;

const AI_SETTINGS_KEY = 'pr-reviewer:ai-settings';
export type AISettings = { apiKey: string; enabled: boolean; model: string; language: AILanguage };
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
  const response: ExtensionResponse = await chrome.runtime.sendMessage(message);
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
  const apiKey = typeof stored?.apiKey === 'string' && stored.apiKey.length <= 512 ? stored.apiKey : '';
  const model = typeof stored?.model === 'string' && /^[a-z\d][a-z\d._:-]{0,99}$/i.test(stored.model) ? stored.model : DEFAULT_AI_MODEL;
  const language = isAILanguage(stored.language) ? stored.language : DEFAULT_AI_LANGUAGE;
  return { apiKey, model, language, enabled: stored?.enabled === true && !!apiKey };
}

export async function saveAISettings(input: { apiKey?: string; enabled: boolean; model: string; language?: AILanguage }): Promise<void> {
  if (input.language !== undefined && !isAILanguage(input.language)) throw new Error('Choose English or Spanish for AI responses.');
  const current = await loadAISettings();
  const apiKey = input.apiKey === undefined ? current.apiKey : input.apiKey.trim();
  const model = input.model.trim() || DEFAULT_AI_MODEL;
  const language = input.language ?? current.language;
  if (apiKey.length > 512) throw new Error('The API key is too long.');
  if (!/^[a-z\d][a-z\d._:-]{0,99}$/i.test(model)) throw new Error('Enter a valid OpenAI model name.');
  if (input.enabled && !apiKey) throw new Error('Add an API key before enabling AI.');
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: { apiKey, model, language, enabled: input.enabled && !!apiKey } });
  await chrome.storage.session.set({ [AI_STATUS_NOTICE]: { nonce: crypto.randomUUID() } });
}

export async function removeAIKey(): Promise<void> {
  const { model } = await loadAISettings();
  await saveAISettings({ apiKey: '', enabled: false, model });
}

export const isAISettingsChange = (changes: Record<string, chrome.storage.StorageChange>) => Object.hasOwn(changes, AI_SETTINGS_KEY);
