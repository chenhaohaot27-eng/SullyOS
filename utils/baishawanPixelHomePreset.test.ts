import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getOrCreateHomeState, PixelAssetDB, PixelRoomDB } from '../apps/pixelHome/pixelHomeDb';
import { importPreset } from '../apps/pixelHome/presetManager';
import type { PixelHomePreset } from '../apps/pixelHome/types';
import PixelHomeMap from '../apps/pixelHome/PixelHomeMap';

const publicPath = join(process.cwd(), 'public', 'pixel-presets', '269e621d-b1d0-4176-96ff-e986188c7438.json');
const outputPath = join(process.cwd(), 'outputs', 'baishawan_pixelhome', '白沙湾_MoArtStudio_整屋预设.json');
const expectedRooms = [
  '前庭花园', '一楼创作大厅', '厨房餐区', '星空穹顶卧室', '正式浴室',
  '衣帽间', '客房', '画材储藏室', '临海平台',
];

const fetchMock = vi.fn(async (): Promise<any> => ({ ok: false }));
vi.stubGlobal('fetch', fetchMock);

describe('白沙湾 · Mo Art Studio 整屋 preset', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: false });
    localStorage.clear();
    await DB.deleteDB();
  });

  it('两份文件一致、格式完整且无外部素材依赖', () => {
    const publicJson = readFileSync(publicPath, 'utf8');
    const outputJson = readFileSync(outputPath, 'utf8');
    const preset = JSON.parse(publicJson) as PixelHomePreset;

    expect(outputJson).toBe(publicJson);
    expect(preset.version).toBe(1);
    expect(preset.replaceRoomCatalog).toBe(true);
    expect(preset.mapLayout?.rooms).toHaveLength(9);
    expect(new Set(preset.mapLayout?.rooms.map(room => room.roomId))).toEqual(new Set(preset.rooms.map(room => room.roomId)));
    expect(preset.mapLayout?.rooms.find(room => room.roomId === 'baishawan_stardome_bedroom')?.shape).toBe('dome');
    expect(preset.mapLayout?.rooms.find(room => room.roomId === 'baishawan_creation_hall')).toMatchObject({ width: 11, height: 9 });
    expect(preset.mapLayout?.rooms.find(room => room.roomId === 'baishawan_seaside_terrace')?.kind).toBe('terrace');
    expect(preset.rooms.map(room => room.name)).toEqual(expectedRooms);
    expect(preset.rooms.map(room => room.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(preset.rooms.map(room => room.roomId)).size).toBe(9);
    expect(preset.rooms.every(room => room.width! >= 2 && room.height! >= 2 && room.furniture.length > 0)).toBe(true);

    expect(preset.assets).toHaveLength(38);
    expect(new Set(preset.assets.map(asset => asset.id)).size).toBe(preset.assets.length);
    expect(preset.assets.every(asset => asset.pixelImage.startsWith('data:image/svg+xml'))).toBe(true);
    expect(preset.assets.every(asset => !/^https?:/i.test(asset.pixelImage))).toBe(true);

    const assetIds = new Set(preset.assets.map(asset => asset.id));
    const referencedIds = preset.rooms.flatMap(room => room.furniture.map(item => item.assetId));
    expect(referencedIds).toHaveLength(85);
    expect(referencedIds.every(id => !!id && assetIds.has(id))).toBe(true);

    const requiredNames = [
      'Mo Art Studio 门牌', '黑色花园门', '看书的塞壬雕像', '巨型蓝色画布',
      '超高画梯', '画架', '颜料车', '笔刷与调色盘', '长工作桌', '海景沙发',
      '壁炉', '开放式大浴缸', '高拱窗', '厨房岛台', '蓝白大床', '海雾纱帘',
      '星空玻璃穹顶', '整墙衣柜', '落地镜', '正式浴室设施', '临海户外沙发',
    ];
    const assetNames = new Set(preset.assets.map(asset => asset.name));
    expect(requiredNames.every(name => assetNames.has(name))).toBe(true);
  });

  it('新角色可一次导入九房并恢复全部家具与 assets', async () => {
    const json = readFileSync(publicPath, 'utf8');
    const result = await importPreset(json, 'fresh-character');

    expect(result).toMatchObject({ success: true, roomsImported: 9, assetsImported: 38 });
    const state = await getOrCreateHomeState('fresh-character');
    expect(state.roomMetadata.map(room => room.name)).toEqual(expectedRooms);
    expect(state.rooms).toHaveLength(9);
    expect(state.mapLayout?.rooms).toHaveLength(9);
    expect(state.rooms.reduce((count, room) => count + room.furniture.length, 0)).toBe(85);
    const assets = await PixelAssetDB.getAll();
    expect(assets).toHaveLength(38);

    const html = renderToStaticMarkup(React.createElement(PixelHomeMap, {
      homeState: state,
      assets,
      userName: '用户',
      onEnterRoom: vi.fn(),
    }));
    expect((html.match(/data-dollhouse-room=/g) || [])).toHaveLength(9);
    expect(html).toContain('data-dollhouse-map="true"');
    expect(html).toContain('data-dollhouse-room="baishawan_creation_hall"');
    expect(html).toContain('data-dollhouse-room="baishawan_stardome_bedroom"');
    expect(html).not.toContain('data-custom-room=');
    for (const name of expectedRooms) expect(html).toContain(name);
    expect(html).not.toContain('个人房');

    // 再次导入显示 0 个新资产是 ID 去重，已落库素材与家具引用仍完整。
    const duplicateResult = await importPreset(json, 'second-character');
    expect(duplicateResult).toMatchObject({ success: true, roomsImported: 9, assetsImported: 0 });
    expect(await PixelAssetDB.getAll()).toHaveLength(38);
  });

  it('整屋导入替换目标目录但不影响其他角色', async () => {
    const otherBefore = await getOrCreateHomeState('other-character');
    await getOrCreateHomeState('existing-target');
    expect((await PixelRoomDB.getAllForChar('existing-target'))).toHaveLength(7);

    const result = await importPreset(readFileSync(publicPath, 'utf8'), 'existing-target');
    expect(result.success).toBe(true);
    expect((await getOrCreateHomeState('existing-target')).roomMetadata.map(room => room.name)).toEqual(expectedRooms);

    const otherAfter = await getOrCreateHomeState('other-character');
    expect(otherAfter.roomMetadata).toEqual(otherBefore.roomMetadata);
    expect(otherAfter.rooms).toEqual(otherBefore.rooms);
  });

  it('旧 importer 已导入的白沙湾可从角色内置 preset 自动补齐总图', async () => {
    const preset = JSON.parse(readFileSync(publicPath, 'utf8')) as PixelHomePreset;
    const oldImporterPreset = { ...preset, mapLayout: undefined };
    const charId = '269e621d-b1d0-4176-96ff-e986188c7438';
    expect((await importPreset(JSON.stringify(oldImporterPreset), charId)).success).toBe(true);
    expect(await PixelRoomDB.getMapLayoutForChar(charId)).toBeUndefined();

    fetchMock.mockResolvedValue({ ok: true, json: async () => preset });
    const upgraded = await getOrCreateHomeState(charId);

    expect(upgraded.mapLayout?.title).toBe('白沙湾 · Mo Art Studio');
    expect(upgraded.mapLayout?.rooms).toHaveLength(9);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`pixel-presets/${charId}.json`),
      { cache: 'no-store' },
    );
  });
});
