import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)),
  'utf8',
);
const hookSource = source.slice(source.indexOf('export const useChatAI'));
const postProcessSource = readFileSync(
  fileURLToPath(new URL('./applyAssistantPostProcessing.ts', import.meta.url)),
  'utf8',
);

describe('useChatAI unified completion wiring', () => {
  it('routes every main-chat completion through completeChat', () => {
    expect(hookSource.match(/completeChat\(/g) ?? []).toHaveLength(7);
    expect(hookSource).not.toMatch(/safeFetchJson\s*\(/);
    expect(hookSource).not.toContain('/chat/completions');
  });

  it('leaves the two independent emotion-eval requests on their existing path', () => {
    expect(source.match(/safeFetchJson\s*\(/g) ?? []).toHaveLength(2);
  });

  it('keeps private-chat second-pass post-processing on the same unified client', () => {
    expect(postProcessSource.match(/completeChat\(/g) ?? []).toHaveLength(15);
    expect(postProcessSource).not.toMatch(/safeFetchJson\s*\(/);
    expect(postProcessSource).not.toContain('/chat/completions');
  });

  it('passes apiFormat without inferring it from the model name', () => {
    expect(hookSource).toMatch(/const mainCompletionConfig = \{[\s\S]*?apiFormat: effectiveApi\.apiFormat/);
    expect(hookSource).toContain("const openAiCompatible = effectiveApi.apiFormat !== 'gemini-native'");
    expect(hookSource).not.toMatch(/gemini.*model|model.*gemini/i);
  });

  it('preserves provider state in all three native tool loops', () => {
    expect(hookSource.match(/buildAssistantToolFollowUpMessage\(/g) ?? []).toHaveLength(3);
  });

  it('keeps OpenAI-only compatibility retries away from Native errors', () => {
    expect(hookSource).toMatch(/openAiCompatible && shouldRetryClaudeProxyCompatibility/);
    expect(hookSource).toMatch(/if \(!openAiCompatible \|\| !mcpOnly/);
  });
});
