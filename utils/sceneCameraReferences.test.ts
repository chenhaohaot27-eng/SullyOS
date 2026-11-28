import { describe, expect, it } from 'vitest';
import type { VisualIdentity } from '../types';
import { DEFAULT_IMAGE_GENERATION_CONFIG as config } from './imageGenerationConfig';
import { prepareCameraReferences } from './sceneCameraReferences';
import { putImageBlob, getBlobForRef, blobToDataUrl } from './blobRef';
import { DB } from './db';

function subject(name: string, offset: number) {
  const visualIdentity: VisualIdentity = {
    enabled: true, mode: 'advanced', fixedTraits: [name + '的瞳色'],
    references: Array.from({ length: 5 }, (_, i) => ({
      id: String(i), role: 'other', createdAt: 0, isPrimary: i === 4,
      blobRef: 'data:image/png;base64,' + btoa(String(offset + i)),
    })),
  };
  return { name, visualIdentity };
}

describe('摄影机身份与备份', () => {
  const character = subject('林', 10);
  const player = subject('周', 20);
  it('交错排列双方主图与辅图，顺序和提示词编号一致', async () => {
    const result = await prepareCameraReferences(character, player, config);
    const source = (owner: typeof player, i: number) => owner.visualIdentity.references[i].blobRef;
    expect(result.references.map(r => r.data)).toEqual([
      source(character, 4), source(player, 4), source(character, 0), source(player, 0), source(character, 1),
    ]);
    expect(result.instructions).toContain('角色「林」：仅图 1、3、5');
    expect(result.instructions).toContain('玩家「周」：仅图 2、4');
    expect(result.instructions).toContain('保留原文的单人、局部、群像或空镜构图');
  });

  it('旧玩家档案可拍摄，当前预设优先，缺失主图明确报错', async () => {
    const host = { ...player, activeVisualIdentityPresetId: 'alternate', visualIdentityPresets: [{
      id: 'alternate', name: 'alternate', createdAt: 0, updatedAt: 0,
      identity: { ...player.visualIdentity, enabled: false },
    }] };
    expect((await prepareCameraReferences({ name: '林' }, host, config)).references).toEqual([]);
    expect((await prepareCameraReferences(character, { name: '旧档案' }, config)).references).toHaveLength(5);
    const bad = subject('周', 20);
    bad.visualIdentity.references[4].blobRef = 'blobref:missing';
    await expect(prepareCameraReferences(character, bad, config)).rejects.toThrow('玩家「周」 · 主图 无法读取');
  });

  it('单图及禁用参考图的接口显式拒绝', async () => {
    await expect(prepareCameraReferences(character, player, { ...config, singleReferenceOnly: true })).rejects.toThrow('需要多张');
    await expect(prepareCameraReferences(character, player, { ...config, provider: 'openai-images' })).rejects.toThrow('不支持');
  });

  it('玩家备份包含像素，恢复后主图和当前形态仍能读取', async () => {
    const blob = new Blob(['player portrait'], { type: 'image/png' });
    const token = await putImageBlob(blob);
    const identity = { ...player.visualIdentity, references: [
      { ...player.visualIdentity.references[4], blobRef: token },
    ] };
    await DB.saveUserProfile({ name: '周', avatar: '', bio: '', activeVisualIdentityPresetId: 'current',
      visualIdentityPresets: [{ id: 'current', name: '当前', createdAt: 0, updatedAt: 0, identity }] });
    const backup = (await DB.exportFullData()).userProfile!;
    expect(backup.visualIdentityPresets![0].identity.references[0].blobRef).toBe(await blobToDataUrl(blob));
    await DB.importFullData({ userProfile: backup });
    const restored = (await DB.getUserProfile())!;
    expect(restored.activeVisualIdentityPresetId).toBe('current');
    const ref = restored.visualIdentityPresets![0].identity.references[0];
    expect(ref.isPrimary).toBe(true);
    expect(await blobToDataUrl((await getBlobForRef(ref.blobRef))!)).toBe(await blobToDataUrl(blob));
  });
});
