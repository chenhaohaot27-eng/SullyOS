import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { APIConfig } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel, normalizeChatApiFormat } from './apiConfigNormalize';
import type { ApiConnectionTestResult } from './apiConnectionTest';
import { apiSettingsDraftMatches, formatApiSettingsTestResult, normalizeApiSettingsDraft } from './apiSettingsDraft';

const saved: APIConfig = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'model-a' };
const success: ApiConnectionTestResult = { status: 'success', reply: 'OK', finishReason: 'stop' };

describe('main API draft comparison', () => {
    it('compares normalized request values and existing defaults, not raw form text', () => {
        expect(apiSettingsDraftMatches(saved, {
            baseUrl: ' \u200Bhttps://fixture.invalid/v1/\uFEFF ', apiKey: ' fixture-key\u200B ', model: '\u200Bmodel-a ',
            apiFormat: 'openai-compatible', stream: false, geminiNonStream: false, temperature: 0.85,
        })).toBe(true);
        expect(normalizeApiSettingsDraft(saved)).toMatchObject({ apiFormat: 'openai-compatible', stream: false, geminiNonStream: false, temperature: 0.85 });
    });

    it.each([
        { baseUrl: 'https://other.invalid/v1' }, { apiKey: 'other-fixture-key' }, { model: 'model-b' },
        { apiFormat: 'gemini-native' as const }, { stream: true }, { geminiNonStream: true }, { temperature: 0 },
    ])('detects a changed main API field: %j', changed => {
        expect(apiSettingsDraftMatches(saved, { ...saved, ...changed })).toBe(false);
    });

    it('ignores unrelated API sections and never changes either input', () => {
        const original = Object.freeze({ ...saved, stream: false });
        const edited = { ...original, minimaxApiKey: 'unrelated-fixture-key' };
        expect(apiSettingsDraftMatches(original, edited)).toBe(true);
        expect(original).toEqual({ ...saved, stream: false });
    });

    it('distinguishes a tested draft from an applied configuration without changing the response', () => {
        expect(formatApiSettingsTestResult(success, true)).toContain('测试通过，保存后应用');
        expect(formatApiSettingsTestResult(success, false)).toContain('连接成功');
        expect(success).toEqual({ status: 'success', reply: 'OK', finishReason: 'stop' });
        for (const status of ['limit', 'empty', 'error'] as const) {
            expect(formatApiSettingsTestResult({ ...success, status }, true)).not.toContain('测试通过');
        }
    });
});

// Execute the actual small Settings expressions with deferred offline replies.
// This checks result races without mounting unrelated OS services or calling a provider.
const source = ts.createSourceFile('Settings.tsx', readFileSync(new URL('../apps/Settings.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function settingsValue(name: string, bindings: Record<string, unknown>): any {
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) expression = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!expression) throw new Error(`Missing Settings expression: ${name}`);
    const text = ts.createPrinter().printNode(ts.EmitHint.Expression, expression, source);
    const compiled = ts.transpileModule(`const value = ${text};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(bindings), `${compiled}\nreturn value;`)(...Object.values(bindings));
}

function settingsHarness() {
    const pending: Array<(result: ApiConnectionTestResult) => void> = [];
    const state = { testing: false, result: null as { source: object; result: ApiConnectionTestResult } | null };
    let memo: object;
    let dependencies: unknown[] | undefined;
    const useMemo = (factory: () => object, next: unknown[]) => {
        if (!dependencies || next.some((value, index) => !Object.is(value, dependencies![index]))) {
            memo = factory();
            dependencies = next;
        }
        return memo;
    };
    const bindings = {
        localUrl: saved.baseUrl, localKey: saved.apiKey, localModel: 'model-b', localApiFormat: 'openai-compatible',
        localStream: false, localGeminiNonStream: false, localTemperature: 0.85,
        apiTestSource: {}, apiTestSourceRef: { current: {} },
        normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel, normalizeChatApiFormat, normalizeApiSettingsDraft,
        setTestingApi: vi.fn(value => { state.testing = value; }),
        setTestApiResult: vi.fn(value => { state.result = value; }),
        runApiConnectionTest: vi.fn((_config: unknown, _stream: boolean) => new Promise<ApiConnectionTestResult>(resolve => pending.push(resolve))),
        commitApiConfig: vi.fn(), updateApiConfig: vi.fn(),
    };
    const refresh = () => {
        const draftApiSettings = settingsValue('draftApiSettings', bindings);
        bindings.apiTestSource = settingsValue('apiTestSource', { draftApiSettings, useMemo });
        bindings.apiTestSourceRef.current = bindings.apiTestSource;
        return draftApiSettings;
    };
    refresh();
    const run = () => settingsValue('handleTestApi', bindings)() as Promise<void>;
    const visible = () => settingsValue('currentTestApiResult', { testApiResult: state.result, apiTestSource: bindings.apiTestSource });
    return { bindings, pending, state, refresh, run, visible };
}

describe('Settings test result ownership', () => {
    it('tests the draft once without applying it and updates the wording after that same draft is saved', async () => {
        const h = settingsHarness();
        const task = h.run();
        expect(h.state.testing).toBe(true);
        expect(h.bindings.runApiConnectionTest).toHaveBeenCalledWith({ ...saved, model: 'model-b', apiFormat: 'openai-compatible', geminiNonStream: false }, false);
        h.pending[0](success);
        await task;
        expect(h.visible()).toEqual(success);
        const draft = h.refresh();
        expect(formatApiSettingsTestResult(h.visible(), !apiSettingsDraftMatches(draft, saved))).toContain('保存后应用');
        expect(formatApiSettingsTestResult(h.visible(), !apiSettingsDraftMatches(draft, { ...saved, model: 'model-b' }))).toContain('连接成功');
        expect(h.bindings.commitApiConfig).not.toHaveBeenCalled();
        expect(h.bindings.updateApiConfig).not.toHaveBeenCalled();
        expect(h.bindings.runApiConnectionTest).toHaveBeenCalledTimes(1);
        expect(h.state.testing).toBe(false);
    });

    it.each([
        ['localUrl', 'https://other.invalid/v1'], ['localKey', 'other-fixture-key'], ['localModel', 'model-c'],
        ['localApiFormat', 'gemini-native'], ['localStream', true], ['localGeminiNonStream', true], ['localTemperature', 0.4],
    ] as const)('ignores a late response after %s changes and never starts another test automatically', async (field, value) => {
        const h = settingsHarness();
        const task = h.run();
        Object.assign(h.bindings, { [field]: value });
        h.refresh();
        h.pending[0](success);
        await task;
        expect(h.visible()).toBeNull();
        expect(h.state.result).toBeNull();
        expect(h.state.testing).toBe(false);
        expect(h.bindings.runApiConnectionTest).toHaveBeenCalledTimes(1);
    });

    it('hides completed results after editing and does not revive them when the earlier value is restored', async () => {
        const h = settingsHarness();
        const task = h.run();
        h.pending[0](success);
        await task;
        expect(h.visible()).toEqual(success);
        h.bindings.localModel = 'model-c';
        h.refresh();
        expect(h.visible()).toBeNull();
        h.bindings.localModel = 'model-b';
        h.refresh();
        expect(h.visible()).toBeNull();
        expect(h.bindings.runApiConnectionTest).toHaveBeenCalledTimes(1);
    });

    it('keeps the result when only whitespace and trailing URL slashes change', async () => {
        const h = settingsHarness();
        const task = h.run();
        h.bindings.localUrl += '/';
        h.bindings.localKey += ' ';
        h.bindings.localModel = ' ' + h.bindings.localModel;
        h.refresh();
        h.pending[0](success);
        await task;
        expect(h.visible()).toEqual(success);
    });
});
