export const MODEL_VENDORS = {
  deepseek: {
    label: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-flash', label: 'DeepSeek Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
  },
  gemini: {
    label: 'Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon' },
      { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon' },
    ],
  },
} as const;

export type ModelVendor = keyof typeof MODEL_VENDORS;
export interface CatalogModel { id: string; label: string }

export function isModelVendor(value: unknown): value is ModelVendor {
  return value === 'deepseek' || value === 'gemini';
}
