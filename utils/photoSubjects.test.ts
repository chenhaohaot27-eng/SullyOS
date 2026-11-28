import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import { applyPlayerPhotoRequest } from './chatPhotoIntent';
import { photoSubjects, narrativePhotoSubjects } from './photoSubjects';
import { bindPhotoIdentity } from './photoIdentityBinding';
import { DEFAULT_IMAGE_GENERATION_CONFIG as config } from './imageGenerationConfig';

describe('拍照主语', () => {
  it.each(['这是你', '你的日常照', '你今天的照片', '给你拍的', '回忆里的你', '你的自拍'])('%s 指玩家', caption => {
    expect(photoSubjects({ prompt: 'a portrait in the park', caption, includeCharacter: false })).toBe('player');
  });
  it.each(['给你看看我的猫', '这是你的咖啡', '给你拍的月亮', '你拍的照片'])('%s 保留物品和环境', caption => {
    expect(photoSubjects({ prompt: 'still life', caption })).toBe('other');
  });
  it('区分拍摄者、合照、空镜与玩家单人场景', () => {
    expect(photoSubjects({ prompt: '看看我的自拍', includeCharacter: true })).toBe('character');
    expect(photoSubjects({ prompt: '我们俩的合照' })).toBe('both');
    expect(narrativePhotoSubjects('玩家：你站在海边', '阿林')).toBe('player');
    expect(narrativePhotoSubjects('玩家：空镜，窗边的花', '阿林')).toBe('other');
  });
  it('玩家说“发一张我的自拍”和“发我一张你的自拍”指不同的人', () => {
    const intent = { prompt: 'portrait', caption: '', includeCharacter: true, style: '' };
    expect(applyPlayerPhotoRequest(intent, '请发一张我的自拍')).toMatchObject({ includePlayer: true, includeCharacter: false });
    expect(applyPlayerPhotoRequest(intent, '请发我一张你的自拍')).toEqual(intent);
  });
  it('已知玩家入镜但参考图缺失时直接报错', async () => {
    const char = { id: 'c', name: '角色', avatar: '' } as CharacterProfile;
    await expect(bindPhotoIdentity('player', '你的自拍', char, null, config)).rejects.toThrow('启用参考图');
  });
});
