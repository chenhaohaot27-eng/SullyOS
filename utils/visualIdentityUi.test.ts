import { describe, it, expect } from 'vitest';
import type { CharacterProfile, VisualIdentity, VisualIdentityReference } from '../types';
import { DB } from './db';
import { getBlobForRef } from './blobRef';
import { addVisualIdentityReference, createDefaultVisualIdentity, normalizeVisualIdentity } from './visualIdentity';
import {
    clampVisualIdentityReferenceUpload,
    joinTraitInput,
    MAX_VISUAL_IDENTITY_REFERENCES,
    parseTraitInput,
    removeVisualIdentityReferenceFromList,
    setPrimaryVisualIdentityReference,
    setVisualIdentityMode,
    updateVisualIdentityReferenceRole,
} from './visualIdentityUi';

const mkRef = (id: string, isPrimary = false): VisualIdentityReference => ({
    id,
    role: 'other',
    blobRef: 'blobref:stub',
    isPrimary,
    createdAt: 0,
});

const mkVi = (refs: VisualIdentityReference[], mode: 'simple' | 'advanced' = 'simple'): VisualIdentity => ({
    ...createDefaultVisualIdentity(),
    mode,
    references: refs,
});

describe('visualIdentityUi — 简易/精细模式切换', () => {
    it('simple → advanced 保留参考图与字段', () => {
        const vi = mkVi([mkRef('a', true)]);
        vi.appearanceSummary = 'summary';
        const next = setVisualIdentityMode(vi, 'advanced');
        expect(next.mode).toBe('advanced');
        expect(next.references).toHaveLength(1);
        expect(next.references[0].isPrimary).toBe(true);
        expect(next.appearanceSummary).toBe('summary');
    });

    it('advanced → simple 且无主图时自动提升第一张为主图', () => {
        const vi = mkVi([mkRef('a'), mkRef('b')], 'advanced');
        const next = setVisualIdentityMode(vi, 'simple');
        expect(next.mode).toBe('simple');
        expect(next.references[0].isPrimary).toBe(true);
        expect(next.references[1].isPrimary).toBeFalsy();
    });

    it('同模式切换是幂等的（返回原引用）', () => {
        const vi = mkVi([mkRef('a', true)]);
        expect(setVisualIdentityMode(vi, 'simple')).toBe(vi);
    });
});

describe('visualIdentityUi — 主图设置 / 删除 / role', () => {
    it('设主图后同一时间只有一张主图', () => {
        const refs = [mkRef('a'), mkRef('b'), mkRef('c')];
        const next = setPrimaryVisualIdentityReference(refs, 'b');
        expect(next.map(r => !!r.isPrimary)).toEqual([false, true, false]);
    });

    it('删除主图时自动提升第一张剩余图为主图', () => {
        const refs = [mkRef('a', true), mkRef('b'), mkRef('c')];
        const next = removeVisualIdentityReferenceFromList(refs, 'a');
        expect(next.map(r => r.id)).toEqual(['b', 'c']);
        expect(next[0].isPrimary).toBe(true);
        expect(next[1].isPrimary).toBeFalsy();
    });

    it('删除非主图不影响现有主图', () => {
        const refs = [mkRef('a', true), mkRef('b')];
        const next = removeVisualIdentityReferenceFromList(refs, 'b');
        expect(next).toHaveLength(1);
        expect(next[0].id).toBe('a');
        expect(next[0].isPrimary).toBe(true);
    });
});

describe('visualIdentityUi — 上传上限与特质解析', () => {
    it('参考图总数上限为 5 张，超出部分被拒绝', () => {
        expect(MAX_VISUAL_IDENTITY_REFERENCES).toBe(5);
        expect(clampVisualIdentityReferenceUpload(0, 7)).toEqual({ accepted: 5, rejected: 2 });
        expect(clampVisualIdentityReferenceUpload(3, 4)).toEqual({ accepted: 2, rejected: 2 });
        expect(clampVisualIdentityReferenceUpload(5, 1)).toEqual({ accepted: 0, rejected: 1 });
    });

    it('特质文本支持换行 / 中英文逗号 / 顿号 / 分号分隔', () => {
        expect(parseTraitInput('银白长发\n琥珀瞳，高马尾、冷静；佩剑')).toEqual(['银白长发', '琥珀瞳', '高马尾', '冷静', '佩剑']);
        expect(parseTraitInput('   \n  ')).toEqual([]);
        expect(joinTraitInput(['a', 'b'])).toBe('a\nb');
        expect(joinTraitInput(undefined)).toBe('');
    });
});

describe('visualIdentityUi — blobRef 存储链路（UI 上传走同一 helper）', () => {
    it('addVisualIdentityReference 返回 blobref: 令牌且 Blob 可回读', async () => {
        const blob = new Blob(['ui-upload-bytes'], { type: 'image/png' });
        const ref = await addVisualIdentityReference(blob, 'front', true);
        expect(ref.blobRef.startsWith('blobref:')).toBe(true);
        expect(ref.role).toBe('front');
        expect(ref.isPrimary).toBe(true);
        const restored = await getBlobForRef(ref.blobRef);
        expect(restored).not.toBeNull();
        expect(await restored!.text()).toBe('ui-upload-bytes');
    });
});

describe('visualIdentityUi — visualIdentity 按 characterId 隔离（DB 往返）', () => {
    it('两个角色的 visualIdentity 互不串扰', async () => {
        const refA = await addVisualIdentityReference(new Blob(['char-a'], { type: 'image/png' }), 'primary-face', true);
        const refB = await addVisualIdentityReference(new Blob(['char-b'], { type: 'image/png' }), 'full-body', true);

        const base = (id: string, name: string): CharacterProfile => ({
            id, name, avatar: '', description: '', systemPrompt: '', memories: [],
        });
        await DB.saveCharacter({ ...base('vi-iso-a', 'A'), visualIdentity: { enabled: true, mode: 'simple', references: [refA] } });
        await DB.saveCharacter({ ...base('vi-iso-b', 'B'), visualIdentity: { enabled: true, mode: 'advanced', references: [refB] } });

        const all = await DB.getAllCharacters();
        const loadedA = all.find(c => c.id === 'vi-iso-a');
        const loadedB = all.find(c => c.id === 'vi-iso-b');

        expect(loadedA?.visualIdentity?.references[0].blobRef).toBe(refA.blobRef);
        expect(loadedB?.visualIdentity?.references[0].blobRef).toBe(refB.blobRef);
        expect(loadedA?.visualIdentity?.references[0].blobRef).not.toBe(loadedB?.visualIdentity?.references[0].blobRef);
        expect(loadedA?.visualIdentity?.mode).toBe('simple');
        expect(loadedB?.visualIdentity?.mode).toBe('advanced');

        await DB.deleteCharacter('vi-iso-a');
        await DB.deleteCharacter('vi-iso-b');
    });
});

describe('visualIdentityUi — 旧角色兼容（无 visualIdentity 字段）', () => {
    it('normalizeVisualIdentity(undefined) 产出默认禁用结构，界面可直接渲染', () => {
        const vi = normalizeVisualIdentity(undefined);
        expect(vi.enabled).toBe(false);
        expect(vi.mode).toBe('simple');
        expect(vi.references).toEqual([]);
    });

    it('缺 references / mode 的脏数据也能被规范化', () => {
        const vi = normalizeVisualIdentity({ enabled: true, mode: undefined as unknown as 'simple', references: undefined as unknown as [] });
        expect(vi.mode).toBe('simple');
        expect(vi.references).toEqual([]);
    });
});

describe('visualIdentityUi — role 更新', () => {
    it('精细模式下可更新单张参考图 role', () => {
        const refs = [mkRef('a')];
        const next = updateVisualIdentityReferenceRole(refs, 'a', 'full-body');
        expect(next[0].role).toBe('full-body');
    });
});
