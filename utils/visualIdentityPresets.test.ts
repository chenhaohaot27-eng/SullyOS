import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import type { CharacterProfile, VisualIdentity, VisualIdentityPreset } from '../types';
import { DB } from './db';
import { getBlobForRef, putImageBlob } from './blobRef';
import { ImageGenerationService } from './imageGenerationService';
import type { ImageGenerationConfig } from '../types';
import {
    createVisualIdentityPreset,
    DEFAULT_PRESET_NAME,
    deleteVisualIdentityPreset,
    getActiveVisualIdentity,
    getActiveVisualIdentityPreset,
    migrateLegacyVisualIdentityToPreset,
    renameVisualIdentityPreset,
    resolveActivePresetId,
} from './visualIdentityPresets';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

function refOf(blobRef: string, isPrimary = false) {
    return { id: `ref_${blobRef}`, role: 'primary-face' as const, blobRef, isPrimary, createdAt: 0 };
}

describe('visualIdentityPresets — 兼容与读取', () => {
    it('旧角色：无 presets → getActiveVisualIdentity 回退 legacy visualIdentity', () => {
        const legacy: VisualIdentity = { enabled: true, mode: 'simple', references: [refOf('blobref:a', true)] };
        const host = { visualIdentity: legacy };
        expect(getActiveVisualIdentityPreset(host)).toBeUndefined();
        expect(getActiveVisualIdentity(host)).toBe(legacy);
    });

    it('无 visualIdentity 也无 presets → 返回 undefined（界面空状态）', () => {
        expect(getActiveVisualIdentity({})).toBeUndefined();
        expect(getActiveVisualIdentityPreset({})).toBeUndefined();
    });

    it('activeId 失效（指向不存在的 preset）→ 回退 legacy，不抛错', () => {
        const legacy: VisualIdentity = { enabled: true, mode: 'simple', references: [refOf('blobref:a', true)] };
        const host = {
            visualIdentity: legacy,
            visualIdentityPresets: [createVisualIdentityPreset('形态A', legacy)],
            activeVisualIdentityPresetId: 'not-exist',
        };
        expect(getActiveVisualIdentityPreset(host)).toBeUndefined();
        expect(getActiveVisualIdentity(host)).toBe(legacy);
    });

    it('presets 存在且 activeId 有效 → 返回该 preset 的 identity', () => {
        const a = createVisualIdentityPreset('人类·短发', { enabled: true, mode: 'simple', references: [refOf('blobref:a', true)] });
        const b = createVisualIdentityPreset('利莫里亚·人鱼', { enabled: true, mode: 'simple', references: [refOf('blobref:b', true)] });
        const host = { visualIdentityPresets: [a, b], activeVisualIdentityPresetId: b.id };
        expect(getActiveVisualIdentityPreset(host)?.id).toBe(b.id);
        expect(getActiveVisualIdentity(host)).toBe(b.identity);
    });
});

describe('visualIdentityPresets — 迁移 / 创建 / 重命名', () => {
    it('legacy → 「默认形态」：直接复用原 blobRef，不写新 Blob，legacy 字段保留', async () => {
        const blobRef = await putImageBlob(new Blob(['x'], { type: 'image/png' }));
        const legacy: VisualIdentity = { enabled: true, mode: 'simple', references: [refOf(blobRef, true)] };

        const migrated = migrateLegacyVisualIdentityToPreset({ visualIdentity: legacy });
        expect(migrated).not.toBeNull();
        expect(migrated!.presets).toHaveLength(1);
        expect(migrated!.presets[0].name).toBe(DEFAULT_PRESET_NAME);
        expect(migrated!.presets[0].identity.references[0].blobRef).toBe(blobRef);
        expect(migrated!.activeVisualIdentityPresetId).toBe(migrated!.presets[0].id);
        // 迁移是纯函数：不写新 Blob，原 Blob 仍可读（blobRef 复用）
        expect(await getBlobForRef(blobRef)).not.toBeNull();
    });

    it('重复迁移返回 null（已有同名默认形态 / legacy 无内容）', () => {
        const legacy: VisualIdentity = { enabled: true, mode: 'simple', references: [refOf('blobref:a', true)] };
        const once = migrateLegacyVisualIdentityToPreset({ visualIdentity: legacy })!;
        expect(migrateLegacyVisualIdentityToPreset({ visualIdentity: legacy, visualIdentityPresets: once.presets })).toBeNull();
        expect(migrateLegacyVisualIdentityToPreset({ visualIdentity: { enabled: false, mode: 'simple', references: [] } })).toBeNull();
    });

    it('创建多个 preset：id 唯一、默认空白禁用；空名回退默认名', () => {
        const a = createVisualIdentityPreset('A');
        const b = createVisualIdentityPreset('  ');
        const c = createVisualIdentityPreset('C', { enabled: true, mode: 'advanced', references: [refOf('blobref:c', true)] }, ' 人鱼形态 ');
        expect(a.id).not.toBe(b.id);
        expect(b.name).toBe(DEFAULT_PRESET_NAME);
        expect(a.identity.enabled).toBe(false);
        expect(c.description).toBe('人鱼形态');
        expect(c.identity.references).toHaveLength(1);
    });

    it('重命名：空名不生效，描述可清空', () => {
        const a = createVisualIdentityPreset('A');
        expect(renameVisualIdentityPreset(a, '  ').name).toBe('A');
        expect(renameVisualIdentityPreset(a, '新名字', '描述').name).toBe('新名字');
        const cleared = renameVisualIdentityPreset({ ...a, description: '旧描述' }, 'A', '');
        expect(cleared.description).toBeUndefined();
    });
});

describe('visualIdentityPresets — 删除与 Blob 清理', () => {
    beforeEach(async () => { await DB.deleteDB(); });

    it('删除非当前 preset：activeId 不变', async () => {
        const a = createVisualIdentityPreset('A', { enabled: true, mode: 'simple', references: [refOf('blobref:a', true)] });
        const b = createVisualIdentityPreset('B', { enabled: true, mode: 'simple', references: [refOf('blobref:b', true)] });
        const { presets, nextActiveId } = await deleteVisualIdentityPreset(a.id, [a, b]);
        expect(presets.map(p => p.name)).toEqual(['B']);
        expect(nextActiveId).toBe(b.id);
    });

    it('删除当前 preset：自动切到剩余第一套；全删完回退 legacy / 空状态', async () => {
        const a = createVisualIdentityPreset('A', { enabled: true, mode: 'simple', references: [refOf('blobref:a', true)] });
        const b = createVisualIdentityPreset('B', { enabled: true, mode: 'simple', references: [refOf('blobref:b', true)] });
        const delActive = await deleteVisualIdentityPreset(a.id, [a, b], undefined);
        expect(delActive.nextActiveId).toBe(b.id);

        const delLast = await deleteVisualIdentityPreset(b.id, [b], undefined);
        expect(delLast.presets).toEqual([]);
        expect(delLast.nextActiveId).toBeUndefined();
        expect(resolveActivePresetId([])).toBeUndefined();
    });

    it('独占 Blob 被清理；被其他 preset / legacy 共享的 blobRef 保留', async () => {
        const sharedRef = await putImageBlob(new Blob(['shared'], { type: 'image/png' }));
        const exclusiveRef = await putImageBlob(new Blob(['only-for-A'], { type: 'image/png' }));

        const a = createVisualIdentityPreset('A', { enabled: true, mode: 'simple', references: [refOf(sharedRef, true), refOf(exclusiveRef)] });
        const b = createVisualIdentityPreset('B', { enabled: true, mode: 'simple', references: [refOf(sharedRef, true)] });
        const legacy: VisualIdentity = { enabled: true, mode: 'simple', references: [refOf(sharedRef, true)] };

        await deleteVisualIdentityPreset(a.id, [a, b], legacy);
        expect(await getBlobForRef(sharedRef)).not.toBeNull();
        expect(await getBlobForRef(exclusiveRef)).toBeNull();
    });
});

describe('visualIdentityPresets — 生图链（service 级）', () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    let service: ImageGenerationService;
    let urlToBlob: Map<string, Blob>;
    let origCreateObjectURL: typeof URL.createObjectURL;
    const mockConfig: ImageGenerationConfig = {
        version: 1,
        enabled: true, provider: 'gemini-native', baseUrl: 'https://test.api', apiKey: 'k',
        model: 'm', defaultResolution: '1K', defaultAspectRatio: '1:1',
        allowReferenceImages: true, timeoutMs: 30000,
    };

    beforeEach(async () => {
        await DB.deleteDB();
        mockFetch = vi.fn();
        service = new ImageGenerationService({ fetchImpl: mockFetch, loadConfig: () => mockConfig });
        urlToBlob = new Map();
        origCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = ((blob: Blob) => {
            const url = origCreateObjectURL(blob);
            urlToBlob.set(url, blob);
            return url;
        }) as typeof URL.createObjectURL;
        mockFetch.mockImplementation(async (url: string) => {
            if (url.startsWith('blob:')) return new Response(urlToBlob.get(url) ?? new Blob(['?']));
            return new Response(JSON.stringify({
                candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'zzzzzzzz' } }] } }],
            }), { status: 200 });
        });
    });
    afterEach(() => { URL.createObjectURL = origCreateObjectURL; });

    const imageB64InBody = (): string[] => {
        const apiCall = mockFetch.mock.calls.find((c: any) => !c[0].startsWith('blob:'));
        if (!apiCall) throw new Error('API call not found');
        const body = JSON.parse(apiCall[1].body);
        return body.contents[0].parts.filter((p: any) => p.inlineData).map((p: any) => p.inlineData.data);
    };

    it('切换 active preset 后 prompt / references 随之切换，不混入其他 preset', async () => {
        const refA = await putImageBlob(new Blob(['form-a'], { type: 'image/png' }));
        const refB = await putImageBlob(new Blob(['form-b'], { type: 'image/png' }));
        const presetA = createVisualIdentityPreset('人类·短发', { enabled: true, mode: 'simple', appearanceSummary: '短发形象', references: [refOf(refA, true)] });
        const presetB = createVisualIdentityPreset('利莫里亚·人鱼', { enabled: true, mode: 'simple', appearanceSummary: '人鱼形态', references: [refOf(refB, true)] });
        const char: CharacterProfile = {
            id: 'pf-char', name: 'T', avatar: '', description: '', systemPrompt: '', memories: [],
            visualIdentityPresets: [presetA, presetB],
            activeVisualIdentityPresetId: presetA.id,
        };
        await DB.saveCharacter(char);

        await service.generateImage({ prompt: 'scene', characterId: 'pf-char' });
        expect(imageB64InBody()).toContain(b64('form-a'));
        expect(imageB64InBody()).not.toContain(b64('form-b'));

        mockFetch.mockClear();
        await DB.saveCharacter({ ...char, activeVisualIdentityPresetId: presetB.id });
        await service.generateImage({ prompt: 'scene', characterId: 'pf-char' });
        expect(imageB64InBody()).toContain(b64('form-b'));
        expect(imageB64InBody()).not.toContain(b64('form-a'));
    });

    it('无 presets 时 legacy visualIdentity 行为完全不变', async () => {
        const refL = await putImageBlob(new Blob(['legacy'], { type: 'image/png' }));
        await DB.saveCharacter({
            id: 'pf-legacy', name: 'T', avatar: '', description: '', systemPrompt: '', memories: [],
            visualIdentity: { enabled: true, mode: 'simple', references: [refOf(refL, true)] },
        } as CharacterProfile);
        await service.generateImage({ prompt: 'scene', characterId: 'pf-legacy' });
        expect(imageB64InBody()).toContain(b64('legacy'));
    });

    it('不同 characterId 不串形态', async () => {
        const ref1 = await putImageBlob(new Blob(['char1-form'], { type: 'image/png' }));
        const ref2 = await putImageBlob(new Blob(['char2-form'], { type: 'image/png' }));
        const mk = (id: string, ref: string): CharacterProfile => ({
            id, name: id, avatar: '', description: '', systemPrompt: '', memories: [],
            visualIdentityPresets: [createVisualIdentityPreset(`${id} 形态`, { enabled: true, mode: 'simple', references: [refOf(ref, true)] })],
        });
        const c1 = mk('pf-c1', ref1);
        const c2 = mk('pf-c2', ref2);
        await DB.saveCharacter({ ...c1, activeVisualIdentityPresetId: c1.visualIdentityPresets![0].id });
        await DB.saveCharacter({ ...c2, activeVisualIdentityPresetId: c2.visualIdentityPresets![0].id });

        await service.generateImage({ prompt: 'scene', characterId: 'pf-c1' });
        expect(imageB64InBody()).toContain(b64('char1-form'));
        mockFetch.mockClear();
        await service.generateImage({ prompt: 'scene', characterId: 'pf-c2' });
        expect(imageB64InBody()).toContain(b64('char2-form'));
        expect(imageB64InBody()).not.toContain(b64('char1-form'));
    });
});

describe('visualIdentityPresets — ZIP 作为新形态导入', () => {
    beforeEach(async () => { await DB.deleteDB(); });

    it('ZIP 导入新增 preset 不覆盖已有；导出/再导入保留 presetName；旧 ZIP 无形态字段不报错', async () => {
        const { exportVisualIdentityZip, importVisualIdentityZip } = await import('./visualIdentityZip');
        const existing = createVisualIdentityPreset('已有形态', { enabled: true, mode: 'simple', references: [] });

        const zip = new JSZip();
        zip.file('manifest.json', JSON.stringify({
            version: 1, presetName: '利莫里亚·人鱼形态', presetDescription: '海底形态',
            appearanceSummary: '人鱼',
            references: [{ file: 'images/primary_face.png', role: 'primary-face', isPrimary: true }],
        }));
        zip.file('images/primary_face.png', 'mermaid');
        const imported = await importVisualIdentityZip(await zip.generateAsync({ type: 'blob' }));
        expect(imported.presetName).toBe('利莫里亚·人鱼形态');
        expect(imported.presetDescription).toBe('海底形态');

        // UI 语义：追加为新 preset，不覆盖 existing
        const newPreset = createVisualIdentityPreset(imported.presetName ?? '导入形态', imported.visualIdentity, imported.presetDescription);
        const presets = [existing, newPreset];
        expect(presets).toHaveLength(2);
        expect(presets[0].name).toBe('已有形态');
        expect(presets[1].identity.references).toHaveLength(1);
        expect(newPreset.identity.references.length).toBeLessThanOrEqual(5);

        // 导出当前形态 → 再导入：presetName 保留
        const exported = await exportVisualIdentityZip(newPreset.identity, {
            presetName: newPreset.name,
            presetDescription: newPreset.description,
        });
        const reimported = await importVisualIdentityZip(exported);
        expect(reimported.presetName).toBe('利莫里亚·人鱼形态');

        // 旧版 ZIP（无 presetName 字段）：不报错，presetName undefined 由 UI 用文件名兜底
        const oldZip = new JSZip();
        oldZip.file('manifest.json', JSON.stringify({
            version: 1, references: [{ file: 'images/a.png', role: 'primary-face', isPrimary: true }],
        }));
        oldZip.file('images/a.png', 'x');
        const oldImported = await importVisualIdentityZip(await oldZip.generateAsync({ type: 'blob' }));
        expect(oldImported.presetName).toBeUndefined();
        expect(oldImported.visualIdentity.references).toHaveLength(1);
    });
});



