import { describe, expect, it } from 'vitest';
import {
  normalizeApiBaseUrl,
  normalizeApiConfig,
  normalizeApiCredential,
  normalizeChatApiFormat,
} from './apiConfigNormalize';

describe('API config normalization', () => {
  it('defaults missing or invalid chat formats to OpenAI-compatible', () => {
    expect(normalizeChatApiFormat(undefined)).toBe('openai-compatible');
    expect(normalizeChatApiFormat('unexpected')).toBe('openai-compatible');
    expect(normalizeChatApiFormat('gemini-native')).toBe('gemini-native');
  });

  it('removes pasted whitespace and invisible edge characters from credentials', () => {
    expect(normalizeApiCredential(' \n\u200Bsk-example\u2060\r ')).toBe('sk-example');
  });

  it('normalizes the base URL without touching its path', () => {
    expect(normalizeApiBaseUrl('  https://api.example.com/v1///\u200B ')).toBe('https://api.example.com/v1');
  });

  it('keeps unrelated API settings intact', () => {
    expect(normalizeApiConfig({
      baseUrl: ' https://api.example.com/v1/ ',
      apiKey: '\uFEFFsk-test\u200B',
      model: ' gpt-test ',
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: ' https://vision.example.com/v1/// ',
        apiKey: '\u200Bvision-key\u2060',
        model: ' vision-model ',
      },
    })).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      apiFormat: 'openai-compatible',
      model: 'gpt-test',
      stream: true,
      temperature: 0.7,
      minimaxApiKey: 'mini-key',
      visionApi: {
        enabled: true,
        baseUrl: 'https://vision.example.com/v1',
        apiKey: 'vision-key',
        model: 'vision-model',
      },
    });
  });

  it('preserves Gemini Native through storage round-trip while old storage defaults to OpenAI', () => {
    const nativeSaved = JSON.stringify({
      baseUrl: 'https://api.relayrouter.ai',
      apiKey: 'test-key',
      model: 'gemini-2.5-pro',
      apiFormat: 'gemini-native',
    });
    expect(normalizeApiConfig(JSON.parse(nativeSaved)).apiFormat).toBe('gemini-native');

    const legacySaved = JSON.stringify({ baseUrl: 'https://legacy.example/v1', apiKey: 'k', model: 'm' });
    expect(normalizeApiConfig(JSON.parse(legacySaved)).apiFormat).toBe('openai-compatible');
  });
});
