import type { Category, ImplementationGroup } from './classifier';
import type { RepositoryPreferences } from './storage';

export const CONTENT_VERSION = '0.2.0';
export const DEFAULT_AI_MODEL = 'gpt-6-luna';
export type AIProvider = 'openai' | 'gemini' | 'claude';
export const isAIProvider = (value: unknown): value is AIProvider => value === 'openai' || value === 'gemini' || value === 'claude';
export const AI_PROVIDERS: Record<AIProvider, { label: string; origin: string; defaultModel: string; models: string[]; keyUrl: string }> = {
  openai: {
    label: 'OpenAI', origin: 'https://api.openai.com/*', defaultModel: DEFAULT_AI_MODEL,
    models: [DEFAULT_AI_MODEL, 'gpt-6.1-sol', 'gpt-6-astra'], keyUrl: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    label: 'Gemini', origin: 'https://generativelanguage.googleapis.com/*', defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'], keyUrl: 'https://aistudio.google.com/apikey',
  },
  claude: {
    label: 'Claude', origin: 'https://api.anthropic.com/*', defaultModel: 'claude-sonnet-5-5',
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], keyUrl: 'https://platform.claude.com/settings/keys',
  },
};
export type AILanguage = 'en' | 'es';
export const DEFAULT_AI_LANGUAGE: AILanguage = 'en';
export const AI_LANGUAGE_LABELS: Record<AILanguage, string> = { en: 'English', es: 'Español' };
export const isAILanguage = (value: unknown): value is AILanguage => value === 'en' || value === 'es';
export const AI_STATUS_NOTICE = 'pr-reviewer:ai-status-change';
export const PREFERENCES_NOTICE = 'pr-reviewer:preferences-change';
export const EXTENSION_RELOAD_NOTICE = 'PR Reviewer was updated or reloaded. Reload this GitHub tab to reconnect.';
export type AIReviewContext = { path: string; diff: string; partial: boolean };
export type AIReviewLine = { side: 'left' | 'right'; line: number };
export type AIReviewComment = { text: string; lines: AIReviewLine[] };
export type AIReviewResult = { summary: string; highlights: AIReviewComment[]; focus: AIReviewComment[] };
export type AIStatus = { configured: boolean; enabled: boolean; model: string; language: AILanguage; provider?: AIProvider };

export type ExtensionRequest =
  | { type: 'ai-status' }
  | { type: 'ai-open-settings' }
  | { type: 'ai-review'; context: AIReviewContext; requestId: string }
  | { type: 'ai-cancel'; requestId: string }
  | { type: 'preferences-load'; repository: string }
  | { type: 'preferences-category'; repository: string; path: string; category: Category | null }
  | { type: 'preferences-implementation'; repository: string; path: string; group: ImplementationGroup | null };

export type ExtensionResponse =
  | { ok: true; status?: AIStatus; review?: AIReviewResult; preferences?: RepositoryPreferences }
  | { ok: false; error: string };

export async function sendExtensionMessage(message: ExtensionRequest): Promise<ExtensionResponse> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (cause) {
    if (/extension context invalidated/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw new Error(EXTENSION_RELOAD_NOTICE);
    }
    throw cause;
  }
}
