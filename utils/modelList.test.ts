import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { normalizeApiBaseUrl, normalizeApiCredential } from './apiConfigNormalize';
import { extractModelCatalog, extractModelIds, getModelProtocolInfo, normalizeModelIds } from './modelList';

describe('model list normalization', () => {
    it('keeps strings and common object identifiers without leaking objects into the UI', () => {
        expect(normalizeModelIds([
            'gpt-4.1',
            { id: 'claude-sonnet-4' },
            { model: 'gemini-2.5-pro' },
            { name: 'deepseek-chat' },
            { unexpected: true },
            null,
            7,
            'gpt-4.1',
        ])).toEqual(['gpt-4.1', 'claude-sonnet-4', 'gemini-2.5-pro', 'deepseek-chat']);
    });

    it('accepts OpenAI-compatible and nested gateway response shapes', () => {
        expect(extractModelIds({ data: [{ id: 'gpt-4.1' }] })).toEqual(['gpt-4.1']);
        expect(extractModelIds({ data: { models: [{ model_name: 'nested-model' }] } })).toEqual(['nested-model']);
    });
});

describe('model protocol metadata', () => {
    it('preserves endpoint types across all supported response envelopes', () => {
        const models = [{ id: 'dual', supported_endpoint_types: ['gemini', 'openai'] }];
        for (const data of [models, { data: models }, { models }, { data: { models } }, { data: { data: models } }]) {
            expect(extractModelCatalog(data)).toEqual([{ id: 'dual', supportedEndpointTypes: ['gemini', 'openai'] }]);
            expect(extractModelIds(data)).toEqual(['dual']);
        }
    });

    it('merges duplicate IDs without changing the string list or input objects', () => {
        const input = [' same ', { id: 'same', supported_endpoint_types: [' Gemini ', '', null, 'gemini'] },
            { name: 'same', supported_endpoint_types: ['openai'] }];
        const before = JSON.stringify(input);
        expect(extractModelCatalog(input)).toEqual([{ id: 'same', supportedEndpointTypes: ['gemini', 'openai'] }]);
        expect(normalizeModelIds(input)).toEqual(['same']);
        expect(JSON.stringify(input)).toBe(before);
    });

    it('does not infer support from names, missing fields, or unrecognized endpoint types', () => {
        const models = extractModelCatalog([
            'gemini-named-but-unknown',
            { id: 'missing' },
            { id: 'empty', supported_endpoint_types: [] },
            { id: 'malformed', supported_endpoint_types: 'gemini' },
            { id: 'invalid-items', supported_endpoint_types: [null, 1, {}] },
            { id: 'other', supported_endpoint_types: ['openai-response', 'anthropic'] },
        ]);
        for (const model of [undefined, ...models]) {
            expect(getModelProtocolInfo(model, 'openai-compatible')).toEqual({ formats: [], suggestedFormat: null });
            expect(getModelProtocolInfo(model, 'gemini-native')).toEqual({ formats: [], suggestedFormat: null });
        }
    });

    it('suggests only the explicitly advertised alternate protocol', () => {
        const [native, chat, dual] = extractModelCatalog([
            { id: 'native', supported_endpoint_types: ['gemini'] },
            { id: 'chat', supported_endpoint_types: ['openai'] },
            { id: 'dual', supported_endpoint_types: ['openai', 'gemini'] },
        ]);
        expect(getModelProtocolInfo(native, 'openai-compatible')).toEqual({ formats: ['gemini-native'], suggestedFormat: 'gemini-native' });
        expect(getModelProtocolInfo(chat, 'gemini-native')).toEqual({ formats: ['openai-compatible'], suggestedFormat: 'openai-compatible' });
        expect(getModelProtocolInfo(native, 'gemini-native').suggestedFormat).toBeNull();
        expect(getModelProtocolInfo(chat, 'openai-compatible').suggestedFormat).toBeNull();
        for (const format of ['openai-compatible', 'gemini-native'] as const) {
            expect(getModelProtocolInfo(dual, format)).toEqual({ formats: ['openai-compatible', 'gemini-native'], suggestedFormat: null });
        }
    });
});

// Execute the actual small Settings handlers with deferred offline responses.
// This exercises their race guards without mounting the unrelated OS services.
const settingsAst = ts.createSourceFile('Settings.tsx',
    readFileSync(new URL('../apps/Settings.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function settingsValue(name: string, bindings: Record<string, unknown>): any {
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) expression = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(settingsAst);
    if (!expression) throw new Error(`Settings declaration missing: ${name}`);
    const source = ts.createPrinter().printNode(ts.EmitHint.Expression, expression, settingsAst);
    const compiled = ts.transpileModule(`const value = ${source};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(bindings), `${compiled}\nreturn value;`)(...Object.values(bindings));
}

function settingsHarness() {
    const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
    const state = { model: 'user-picked-model', models: [] as string[], catalog: null as any, loading: false, status: '', format: 'openai-compatible', testResult: {} as unknown };
    const source = {};
    const bindings = {
        localUrl: 'https://fixture.invalid/v1', localKey: 'fixture-key', localModel: state.model,
        localApiFormat: state.format, modelCatalogSource: source,
        modelCatalogSourceRef: { current: source }, modelCatalogRequestRef: { current: null as AbortController | null },
        normalizeApiBaseUrl, normalizeApiCredential, extractModelCatalog,
        safeResponseJson: (response: Response) => response.json(),
        fetch: vi.fn((_url: string, options: RequestInit) => new Promise<Response>(resolve => {
            pending.push({ resolve, signal: options.signal as AbortSignal });
        })),
        console: { error: vi.fn() },
        setModelCatalog: vi.fn(value => { state.catalog = value; }),
        setAvailableModels: vi.fn(value => { state.models = value; }),
        setLocalModel: vi.fn(value => { state.model = value; }),
        setIsLoadingModels: vi.fn(value => { state.loading = value; }),
        setStatusMsg: vi.fn(value => { state.status = value; }),
        setShowModelModal: vi.fn(),
        setLocalApiFormat: vi.fn(value => { state.format = value; }),
        setTestApiResult: vi.fn(value => { state.testResult = value; }),
        commitApiConfig: vi.fn(), updateApiConfig: vi.fn(),
    };
    const run = () => settingsValue('fetchModels', bindings)() as Promise<void>;
    return { bindings, pending, state, run };
}
const modelResponse = (id: string) => new Response(JSON.stringify({ data: [{ id, supported_endpoint_types: ['gemini'] }] }));

describe('Settings model catalog isolation', () => {
    it('refreshes metadata without replacing a user-entered model', async () => {
        const h = settingsHarness();
        const request = h.run();
        h.pending[0].resolve(modelResponse('catalog-model'));
        await request;
        expect(h.state.models).toEqual(['catalog-model']);
        expect(h.state.catalog.entries[0].supportedEndpointTypes).toEqual(['gemini']);
        expect(h.state.model).toBe('user-picked-model');
        expect(h.bindings.setLocalModel).not.toHaveBeenCalled();
        expect(h.bindings.commitApiConfig).not.toHaveBeenCalled();
    });

    it.each(['localUrl', 'localKey'] as const)('ignores a late result after %s changes, including its loading cleanup', async field => {
        const h = settingsHarness();
        const oldRequest = h.run();
        h.bindings[field] += '-changed';
        h.bindings.modelCatalogSource = {};
        h.bindings.modelCatalogSourceRef.current = h.bindings.modelCatalogSource;
        const newRequest = h.run();
        expect(h.pending[0].signal.aborted).toBe(true);
        // The mock deliberately ignores abort: identity guards must still work.
        h.pending[0].resolve(modelResponse('obsolete'));
        await oldRequest;
        expect(h.state.models).toEqual([]);
        expect(h.state.loading).toBe(true);
        h.pending[1].resolve(modelResponse('current'));
        await newRequest;
        expect(h.state.models).toEqual(['current']);
        expect(h.state.loading).toBe(false);
    });

    it('does not let an older same-source request overwrite a newer result or error state', async () => {
        const h = settingsHarness();
        const oldRequest = h.run();
        const newRequest = h.run();
        h.pending[1].resolve(modelResponse('current'));
        await newRequest;
        const status = h.state.status;
        h.pending[0].resolve(new Response('obsolete error', { status: 400 }));
        await oldRequest;
        expect(h.state.models).toEqual(['current']);
        expect(h.state.status).toBe(status);
        expect(h.bindings.console.error).not.toHaveBeenCalled();
    });

    it('hides old capability metadata as soon as the URL/token source identity changes', () => {
        const source = {};
        const bindings = { useMemo: (read: () => unknown) => read(), modelCatalogSource: source,
            modelCatalog: { source, entries: extractModelCatalog([{ id: 'native', supported_endpoint_types: ['gemini'] }]) } };
        expect(settingsValue('currentModelCatalog', bindings).has('native')).toBe(true);
        expect(settingsValue('currentModelCatalog', { ...bindings, modelCatalogSource: {} }).size).toBe(0);
    });

    it('applies the explicit suggestion only to the draft and clears the old test result', () => {
        const h = settingsHarness();
        settingsValue('applySuggestedModelFormat', { ...h.bindings,
            currentModelProtocol: { suggestedFormat: 'gemini-native' } })();
        expect(h.state.format).toBe('gemini-native');
        expect(h.state.testResult).toBeNull();
        expect(h.state.model).toBe('user-picked-model');
        expect(h.bindings.fetch).not.toHaveBeenCalled();
        expect(h.bindings.commitApiConfig).not.toHaveBeenCalled();
        expect(h.bindings.updateApiConfig).not.toHaveBeenCalled();
    });
});
