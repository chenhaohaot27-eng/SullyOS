import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import type { CharacterProfile, VisualIdentity } from '../types';
import { DB } from './db';
import { getBlobForRef } from './blobRef';
import { addVisualIdentityReference } from './visualIdentity';
import { exportVisualIdentityZip, importVisualIdentityZip, VISUAL_IDENTITY_MANIFEST_NAME } from './visualIdentityZip';

async function countBlobAssets(): Promise<number> {
    return (await DB.getAllAssets()).length;
}

/** 构造一个带 manifest 的标准包 Blob */
async function buildStandardZip(): Promise<Blob> {
    const zip = new JSZip();
    zip.file(VISUAL_IDENTITY_MANIFEST_NAME, JSON.stringify({
        version: 1,
        appearanceSummary: '银发琥珀瞳',
        fixedTraits: ['银白长发', '琥珀色瞳孔'],
        variableTraits: ['服装随场景'],
        identityStrength: 'strict',
        references: [
            { file: 'images/primary_face.png', role: 'primary-face', isPrimary: true },
            { file: 'images/full_body.jpg', role: 'full-body' },
        ],
    }));
    zip.file('images/primary_face.png', 'face-bytes');
    zip.file('images/full_body.jpg', 'body-bytes');
    return zip.generateAsync({ type: 'blob' });
}

/** 构造无 manifest 的普通 ZIP（images: string[]） */
async function buildPlainZip(images: string[]): Promise<Blob> {
    const zip = new JSZip();
    for (const name of images) zip.file(name, `bytes-of-${name}`);
    return zip.generateAsync({ type: 'blob' });
}

describe('visualIdentityZip — 标准包导出 / 导入', () => {
    beforeEach(async () => {
        await DB.deleteDB();
    });

    it('导出 → 再次导入：字段与图片完整恢复，blobRef 全新写入', async () => {
        const refA = await addVisualIdentityReference(new Blob(['face-data'], { type: 'image/png' }), 'primary-face', true);
        const refB = await addVisualIdentityReference(new Blob(['body-data'], { type: 'image/png' }), 'full-body');
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            appearanceSummary: '导出测试外观',
            fixedTraits: ['黑长直'],
            variableTraits: ['穿搭'],
            identityStrength: 'balanced',
            references: [refA, refB],
        };

        const zipBlob = await exportVisualIdentityZip(vi);
        expect(zipBlob.size).toBeGreaterThan(0);

        const result = await importVisualIdentityZip(zipBlob);
        expect(result.hadManifest).toBe(true);
        expect(result.skippedFiles).toEqual([]);

        const restored = result.visualIdentity;
        expect(restored.mode).toBe('advanced');
        expect(restored.appearanceSummary).toBe('导出测试外观');
        expect(restored.fixedTraits).toEqual(['黑长直']);
        expect(restored.variableTraits).toEqual(['穿搭']);
        expect(restored.identityStrength).toBe('balanced');
        expect(restored.references).toHaveLength(2);
        expect(restored.references[0].role).toBe('primary-face');
        expect(restored.references[0].isPrimary).toBe(true);
        expect(restored.references[1].role).toBe('full-body');

        // blobRef 是全新令牌且图片内容可回读
        expect(restored.references.map(r => r.blobRef)).not.toContain(refA.blobRef);
        const blob0 = await getBlobForRef(restored.references[0].blobRef);
        expect(await blob0!.text()).toBe('face-data');
        const blob1 = await getBlobForRef(restored.references[1].blobRef);
        expect(await blob1!.text()).toBe('body-data');
    });
});

describe('visualIdentityZip — 标准 manifest 字段恢复', () => {
    beforeEach(async () => {
        await DB.deleteDB();
    });

    it('导入标准包恢复主图 / role / 文字字段，未标主图时自动提升第一张', async () => {
        const result = await importVisualIdentityZip(await buildStandardZip());
        const vi = result.visualIdentity;
        expect(vi.enabled).toBe(true);
        expect(vi.mode).toBe('advanced');
        expect(vi.appearanceSummary).toBe('银发琥珀瞳');
        expect(vi.fixedTraits).toEqual(['银白长发', '琥珀色瞳孔']);
        expect(vi.variableTraits).toEqual(['服装随场景']);
        expect(vi.identityStrength).toBe('strict');
        expect(vi.references.map(r => r.role)).toEqual(['primary-face', 'full-body']);
        expect(vi.references[0].isPrimary).toBe(true);
        const blob = await getBlobForRef(vi.references[0].blobRef);
        expect(await blob!.text()).toBe('face-bytes');
    });

    it('非法 role 规范化为 other，不报错', async () => {
        const zip = new JSZip();
        zip.file(VISUAL_IDENTITY_MANIFEST_NAME, JSON.stringify({
            version: 1,
            references: [{ file: 'images/a.png', role: 'not-a-role', isPrimary: true }],
        }));
        zip.file('images/a.png', 'x');
        const result = await importVisualIdentityZip(await zip.generateAsync({ type: 'blob' }));
        expect(result.visualIdentity.references[0].role).toBe('other');
    });
});

describe('visualIdentityZip — 普通 ZIP（无 manifest）人工整理流程', () => {
    beforeEach(async () => {
        await DB.deleteDB();
    });

    it('提取图片：role=other、首图自动主图、hadManifest=false', async () => {
        const result = await importVisualIdentityZip(await buildPlainZip(['a.png', 'b.jpg', 'c.webp']));
        expect(result.hadManifest).toBe(false);
        expect(result.visualIdentity.references).toHaveLength(3);
        expect(result.visualIdentity.references.every(r => r.role === 'other')).toBe(true);
        expect(result.visualIdentity.references[0].isPrimary).toBe(true);
        expect(result.visualIdentity.references[1].isPrimary).toBeFalsy();
        expect(result.skippedFiles).toEqual([]);
        const blob = await getBlobForRef(result.visualIdentity.references[1].blobRef);
        expect(await blob!.text()).toBe('bytes-of-b.jpg');
    });

    it('无图片 ZIP 明确报错且不写任何 Blob', async () => {
        const before = await countBlobAssets();
        const zip = new JSZip();
        zip.file('notes.txt', 'hello');
        await expect(importVisualIdentityZip(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow(/没有找到图片/);
        expect(await countBlobAssets()).toBe(before);
    });

    it('超过 5 张：只导入 5 张，其余进入 skippedFiles 提示用户选择', async () => {
        const result = await importVisualIdentityZip(
            await buildPlainZip(['1.png', '2.png', '3.png', '4.png', '5.png', '6.png', '7.png']),
        );
        expect(result.visualIdentity.references).toHaveLength(5);
        expect(result.skippedFiles).toEqual(['6.png', '7.png']);
    });

    it('manifest 超过 5 条 references：同样截断到 5 张', async () => {
        const zip = new JSZip();
        const refs = Array.from({ length: 6 }, (_, i) => ({ file: `images/${i}.png`, role: 'other' as const }));
        for (let i = 0; i < 6; i++) zip.file(`images/${i}.png`, `b${i}`);
        zip.file(VISUAL_IDENTITY_MANIFEST_NAME, JSON.stringify({ version: 1, references: refs }));
        const result = await importVisualIdentityZip(await zip.generateAsync({ type: 'blob' }));
        expect(result.visualIdentity.references).toHaveLength(5);
        expect(result.skippedFiles).toEqual(['images/5.png']);
    });
});

describe('visualIdentityZip — 失败不残留孤儿 Blob', () => {
    beforeEach(async () => {
        await DB.deleteDB();
    });

    it('manifest 引用缺失文件：报错并清理已写入的 Blob', async () => {
        const before = await countBlobAssets();
        const zip = new JSZip();
        zip.file(VISUAL_IDENTITY_MANIFEST_NAME, JSON.stringify({
            version: 1,
            references: [
                { file: 'images/ok.png', role: 'primary-face', isPrimary: true },
                { file: 'images/missing.png', role: 'front' },
            ],
        }));
        zip.file('images/ok.png', 'good');
        // 故意不写 images/missing.png

        await expect(importVisualIdentityZip(await zip.generateAsync({ type: 'blob' })))
            .rejects.toThrow(/缺少图片/);
        expect(await countBlobAssets()).toBe(before);
    });

    it('manifest 损坏（非法 JSON）：明确报错且不写 Blob', async () => {
        const before = await countBlobAssets();
        const zip = new JSZip();
        zip.file(VISUAL_IDENTITY_MANIFEST_NAME, '{not json');
        zip.file('images/a.png', 'x');
        await expect(importVisualIdentityZip(await zip.generateAsync({ type: 'blob' })))
            .rejects.toThrow(/manifest/);
        expect(await countBlobAssets()).toBe(before);
    });

    it('非 ZIP 文件：明确报错', async () => {
        await expect(importVisualIdentityZip(new Blob(['plain text'], { type: 'text/plain' })))
            .rejects.toThrow(/ZIP/);
    });
});

describe('visualIdentityZip — 按 characterId 隔离与旧角色兼容', () => {
    beforeEach(async () => {
        await DB.deleteDB();
    });

    it('导入结果只写指定角色，其他角色 visualIdentity 不受影响', async () => {
        const mk = (id: string, name: string): CharacterProfile => ({
            id, name, avatar: '', description: '', systemPrompt: '', memories: [],
        });
        await DB.saveCharacter(mk('zip-char-a', 'A'));
        await DB.saveCharacter({ ...mk('zip-char-b', 'B'), visualIdentity: { enabled: true, mode: 'simple', references: [] } });

        const result = await importVisualIdentityZip(await buildStandardZip());
        // UI 层语义：把导入的 visualIdentity 写入当前编辑角色 A
        const charA = { ...mk('zip-char-a', 'A'), visualIdentity: result.visualIdentity };
        await DB.saveCharacter(charA);

        const all = await DB.getAllCharacters();
        const loadedA = all.find(c => c.id === 'zip-char-a');
        const loadedB = all.find(c => c.id === 'zip-char-b');
        expect(loadedA?.visualIdentity?.references).toHaveLength(2);
        expect(loadedA?.visualIdentity?.appearanceSummary).toBe('银发琥珀瞳');
        // B 保持原样（空 references，未被导入数据覆盖）
        expect(loadedB?.visualIdentity?.references).toEqual([]);
        expect(loadedB?.visualIdentity?.appearanceSummary).toBeUndefined();
    });

    it('旧角色（无 visualIdentity 字段）导入后正常获得完整结构', async () => {
        const oldChar: CharacterProfile = {
            id: 'zip-old-char', name: 'Old', avatar: '', description: '', systemPrompt: '', memories: [],
        };
        await DB.saveCharacter(oldChar);
        const result = await importVisualIdentityZip(await buildPlainZip(['x.png']));
        await DB.saveCharacter({ ...oldChar, visualIdentity: result.visualIdentity });

        const loaded = (await DB.getAllCharacters()).find(c => c.id === 'zip-old-char');
        expect(loaded?.visualIdentity?.enabled).toBe(true);
        expect(loaded?.visualIdentity?.references).toHaveLength(1);
        expect(loaded?.name).toBe('Old');
    });
});


