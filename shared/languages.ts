export const LANGUAGES = {
  'zh-CN': { label: '简体中文', name: 'Simplified Chinese' },
  en: { label: '英语', name: 'English' },
  fr: { label: '法语', name: 'French' },
  ru: { label: '俄语', name: 'Russian' },
  ja: { label: '日语', name: 'Japanese' },
} as const;
export type TargetLanguage = keyof typeof LANGUAGES;
export type SourceLanguage = 'auto' | TargetLanguage;
export interface LanguagePair { sourceLanguage: SourceLanguage; targetLanguage: TargetLanguage }
export const DEFAULT_LANGUAGES: LanguagePair = { sourceLanguage: 'auto', targetLanguage: 'zh-CN' };
export function parseLanguages(value: unknown): LanguagePair {
  const pair = value as Partial<LanguagePair> | null;
  const sourceLanguage = pair?.sourceLanguage ?? 'auto';
  const targetLanguage = pair?.targetLanguage ?? 'zh-CN';
  if ((sourceLanguage !== 'auto' && !Object.hasOwn(LANGUAGES, sourceLanguage)) || !Object.hasOwn(LANGUAGES, targetLanguage)) throw new Error('请选择支持的翻译语言。');
  return { sourceLanguage, targetLanguage };
}
export function languageCode(value: string) { return value.toLowerCase().split('-')[0]; }
