import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DB } from './db';
import {
  getOrCreateHomeState,
  PixelAssetDB,
  PixelLayoutDB,
  PixelRoomDB,
} from '../apps/pixelHome/pixelHomeDb';
import { importPreset } from '../apps/pixelHome/presetManager';
import { ALL_ROOMS } from '../apps/pixelHome/roomTemplates';
import { isLegacyPixelRoomCatalog } from '../apps/pixelHome/roomTemplates';
import type { PixelHomePreset, PixelRoomLayout } from '../apps/pixelHome/types';
import PixelHomeMap from '../apps/pixelHome/PixelHomeMap';

vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));

const customizedLegacyLayout = (charId: string): PixelRoomLayout => ({
  charId,
  roomId: 'living_room',
  furniture: [{
    slotId: 'kept_sofa',
    assetId: 'kept_asset',
    x: 42,
    y: 63,
    scale: 1.25,
    rotation: 0,
    placedBy: 'user',
    isDefault: false,
  }],
  wallColor: '#112233',
  floorColor: '#445566',
  ambiance: '旧数据必须保留',
  lastUpdatedAt: 123,
  lastDecoratedBy: 'user',
});

describe('Pixel Home per-character room metadata', () => {
  beforeEach(async () => {
    localStorage.clear();
    await DB.deleteDB();
  });

  it('首次读取旧数据时补齐原七室且不改已有家具布局', async () => {
    const oldLayout = customizedLegacyLayout('legacy-char');
    await PixelLayoutDB.save(oldLayout);

    const state = await getOrCreateHomeState('legacy-char');

    expect(state.roomMetadata.map(room => room.id)).toEqual(ALL_ROOMS);
    expect(isLegacyPixelRoomCatalog(state.roomMetadata)).toBe(true);
    expect(state.rooms).toHaveLength(ALL_ROOMS.length);
    expect(state.rooms.find(room => room.roomId === 'living_room')).toEqual(oldLayout);
    expect(await PixelRoomDB.getAllForChar('legacy-char')).toEqual(state.roomMetadata);

    const html = renderToStaticMarkup(React.createElement(PixelHomeMap, {
      homeState: state, assets: [], userName: '用户', onEnterRoom: vi.fn(),
    }));
    expect(html).toContain('data-room="living_room"');
    expect(html).toContain('客厅');
    expect(html).not.toContain('data-custom-room=');
  });

  it('支持新增、改名、排序和删除房间', async () => {
    await getOrCreateHomeState('crud-char');
    const added = await PixelRoomDB.addRoom('crud-char', {
      id: 'sea_terrace', name: '临海平台', width: 9, height: 4,
    });
    expect(added).toMatchObject({ id: 'sea_terrace', name: '临海平台', width: 9, height: 4 });
    expect(await PixelLayoutDB.get('crud-char', 'sea_terrace')).toMatchObject({ roomId: 'sea_terrace', furniture: [] });

    expect(await PixelRoomDB.renameRoom('crud-char', 'sea_terrace', '海风平台')).toBe(true);
    const ids = (await PixelRoomDB.getAllForChar('crud-char'))!.map(room => room.id);
    expect(await PixelRoomDB.reorderRooms('crud-char', ['sea_terrace', ...ids.filter(id => id !== 'sea_terrace')])).toBe(true);
    expect((await PixelRoomDB.getAllForChar('crud-char'))![0].name).toBe('海风平台');

    expect(await PixelRoomDB.deleteRoom('crud-char', 'sea_terrace')).toBe(true);
    expect((await PixelRoomDB.getAllForChar('crud-char'))!.some(room => room.id === 'sea_terrace')).toBe(false);
    expect(await PixelLayoutDB.get('crud-char', 'sea_terrace')).toBeUndefined();
  });

  it('不同角色的房间目录与布局彼此隔离', async () => {
    await getOrCreateHomeState('char-a');
    await getOrCreateHomeState('char-b');
    await PixelRoomDB.addRoom('char-a', { id: 'private_room', name: 'A的房间' });

    expect((await PixelRoomDB.getAllForChar('char-a'))!.some(room => room.id === 'private_room')).toBe(true);
    expect((await PixelRoomDB.getAllForChar('char-b'))!.some(room => room.id === 'private_room')).toBe(false);
    expect(await PixelLayoutDB.get('char-b', 'private_room')).toBeUndefined();
  });

  it('新 preset 可创建房间并恢复家具与资产', async () => {
    const preset: PixelHomePreset = {
      version: 1,
      name: '自定义房屋',
      author: 'test',
      createdAt: 1,
      mapLayout: {
        version: 1,
        title: '自定义剖切图',
        width: 12,
        height: 8,
        rooms: [{
          roomId: 'creative_hall', x: 0, y: 0, width: 12, height: 8,
          kind: 'indoor', previewAssetIds: ['asset-easel'],
        }],
      },
      rooms: [{
        roomId: 'creative_hall',
        name: '创作大厅',
        order: 0,
        width: 12,
        height: 8,
        furniture: [{
          slotId: 'easel', assetId: 'asset-easel', x: 20, y: 60,
          scale: 1, rotation: 0, placedBy: 'user', isDefault: false,
        }],
        wallColor: '#abcdef',
        floorColor: '#654321',
        ambiance: '面朝海湾',
      }],
      assets: [{
        id: 'asset-easel', name: '画架', pixelImage: 'data:image/png;base64,AA==',
        pixelSize: 32, palette: ['#ffffff'], width: 32, height: 32,
      }],
    };

    expect(await importPreset(JSON.stringify(preset), 'preset-char')).toMatchObject({
      success: true, roomsImported: 1, assetsImported: 1,
    });
    const state = await getOrCreateHomeState('preset-char');
    expect(state.roomMetadata).toEqual([{ id: 'creative_hall', name: '创作大厅', order: 0, width: 12, height: 8 }]);
    expect(state.mapLayout).toMatchObject({ title: '自定义剖切图', rooms: [{ roomId: 'creative_hall' }] });
    expect(state.rooms[0]).toMatchObject({
      roomId: 'creative_hall',
      furniture: [{ slotId: 'easel', assetId: 'asset-easel' }],
      ambiance: '面朝海湾',
    });
    expect((await PixelAssetDB.getAll()).find(asset => asset.id === 'asset-easel')).toMatchObject({ id: 'asset-easel', name: '画架' });
  });

  it('旧 v1 preset 无房间 metadata 时仍建立原七室目录', async () => {
    const result = await importPreset(JSON.stringify({
      version: 1,
      name: '旧预设',
      author: 'legacy',
      createdAt: 1,
      rooms: [{
        roomId: 'bedroom', furniture: [], wallColor: '#111111', floorColor: '#222222', ambiance: '',
      }],
      assets: [],
    }), 'old-preset-char');

    expect(result.success).toBe(true);
    const state = await getOrCreateHomeState('old-preset-char');
    expect(state.roomMetadata.map(room => room.id)).toEqual(ALL_ROOMS);
    expect(state.rooms.find(room => room.roomId === 'bedroom')?.wallColor).toBe('#111111');
  });
});
