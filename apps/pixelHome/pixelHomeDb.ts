/**
 * Pixel Home — IndexedDB 存储层
 *
 * 两个 store：
 *   pixel_home_assets  — 用户生成的像素资产
 *   pixel_home_layouts — 每个角色的每个房间布局
 */

import type { PixelAsset, PixelRoomLayout, PixelHomeState, PixelRoomMetadata, PixelRoomPreset } from './types';
import {
  ROOM_SLOTS,
  DEFAULT_ROOM_COLORS,
  DEFAULT_PIXEL_ROOM_METADATA,
  defaultPixelRoomMetadata,
  isLegacyPixelRoomId,
} from './roomTemplates';
import { openDB } from '../../utils/db';

// ─── DB 常量 ─────────────────────────────────────────
// pixel_home_* 两个 store 由 utils/db.ts 的 AetherOS_Data upgradeneeded 统一创建,
// 这里直接复用 utils/db.ts 的单例 openDB —— 本地原来那个 openDB 每次操作都裸开一条
// AetherOS_Data 连接 (连版本号都没传), 既漏连接又绕过单例, 会一起喂大连接风暴。

const STORE_ASSETS = 'pixel_home_assets';
const STORE_LAYOUTS = 'pixel_home_layouts';
const ROOM_METADATA_ID = '__pixel_home_room_metadata__';

interface PixelRoomMetadataRecord {
  charId: string;
  roomId: typeof ROOM_METADATA_ID;
  recordType: 'room-metadata';
  rooms: PixelRoomMetadata[];
  lastUpdatedAt: number;
}

const clampDimension = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(2, Math.min(20, Math.round(parsed))) : fallback;
};

const normalizeRoomMetadata = (rooms: PixelRoomMetadata[]): PixelRoomMetadata[] => {
  const seen = new Set<string>();
  return rooms
    .filter(room => room && typeof room.id === 'string' && room.id.trim() && room.id !== ROOM_METADATA_ID)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter(room => {
      if (seen.has(room.id)) return false;
      seen.add(room.id);
      return true;
    })
    .map((room, order) => ({
      id: room.id,
      name: typeof room.name === 'string' && room.name.trim() ? room.name.trim() : room.id,
      order,
      width: clampDimension(room.width, 6),
      height: clampDimension(room.height, 5),
    }));
};

const createEmptyLayout = (charId: string, room: PixelRoomMetadata): PixelRoomLayout => {
  if (isLegacyPixelRoomId(room.id)) {
    const slots = ROOM_SLOTS[room.id];
    const colors = DEFAULT_ROOM_COLORS[room.id];
    return {
      roomId: room.id,
      charId,
      furniture: slots.map(slot => ({
        slotId: slot.id,
        assetId: null,
        x: slot.defaultX,
        y: slot.defaultY,
        scale: slot.defaultScale,
        rotation: 0,
        placedBy: 'character' as const,
        isDefault: true,
      })),
      wallColor: colors.wall,
      floorColor: colors.floor,
      ambiance: '',
      lastUpdatedAt: Date.now(),
      lastDecoratedBy: 'character',
    };
  }

  return {
    roomId: room.id,
    charId,
    furniture: [],
    wallColor: '#f1e4d0',
    floorColor: '#b69b78',
    ambiance: '',
    lastUpdatedAt: Date.now(),
    lastDecoratedBy: 'character',
  };
};

// ─── 资产 CRUD ──────────────────────────────────────

export const PixelAssetDB = {
  async save(asset: PixelAsset): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readwrite');
    tx.objectStore(STORE_ASSETS).put(asset);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async saveBatch(assets: PixelAsset[]): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readwrite');
    const store = tx.objectStore(STORE_ASSETS);
    for (const a of assets) store.put(a);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getAll(): Promise<PixelAsset[]> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readonly');
    const req = tx.objectStore(STORE_ASSETS).getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async getById(id: string): Promise<PixelAsset | undefined> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readonly');
    const req = tx.objectStore(STORE_ASSETS).get(id);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async delete(id: string): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_ASSETS, 'readwrite');
    tx.objectStore(STORE_ASSETS).delete(id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ─── 布局 CRUD ──────────────────────────────────────

export const PixelLayoutDB = {
  async save(layout: PixelRoomLayout): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readwrite');
    tx.objectStore(STORE_LAYOUTS).put(layout);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async get(charId: string, roomId: string): Promise<PixelRoomLayout | undefined> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readonly');
    const req = tx.objectStore(STORE_LAYOUTS).get([charId, roomId]);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result?.recordType === 'room-metadata' ? undefined : req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async getAllForChar(charId: string): Promise<PixelRoomLayout[]> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readonly');
    const idx = tx.objectStore(STORE_LAYOUTS).index('charId');
    const req = idx.getAll(charId);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve((req.result || []).filter((record: any) => record?.recordType !== 'room-metadata'));
      req.onerror = () => reject(req.error);
    });
  },

  async saveBatch(layouts: PixelRoomLayout[]): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readwrite');
    const store = tx.objectStore(STORE_LAYOUTS);
    for (const l of layouts) store.put(l);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async delete(charId: string, roomId: string): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readwrite');
    tx.objectStore(STORE_LAYOUTS).delete([charId, roomId]);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ─── 每角色房间目录 CRUD（复用 pixel_home_layouts，不新增 store） ───

export const PixelRoomDB = {
  async getAllForChar(charId: string): Promise<PixelRoomMetadata[] | null> {
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readonly');
    const req = tx.objectStore(STORE_LAYOUTS).get([charId, ROOM_METADATA_ID]);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const record = req.result as PixelRoomMetadataRecord | undefined;
        resolve(record?.recordType === 'room-metadata' && Array.isArray(record.rooms)
          ? normalizeRoomMetadata(record.rooms)
          : null);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async saveAllForChar(charId: string, rooms: PixelRoomMetadata[]): Promise<PixelRoomMetadata[]> {
    const normalized = normalizeRoomMetadata(rooms);
    const record: PixelRoomMetadataRecord = {
      charId,
      roomId: ROOM_METADATA_ID,
      recordType: 'room-metadata',
      rooms: normalized,
      lastUpdatedAt: Date.now(),
    };
    const db = await openDB();
    const tx = db.transaction(STORE_LAYOUTS, 'readwrite');
    tx.objectStore(STORE_LAYOUTS).put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return normalized;
  },

  async addRoom(
    charId: string,
    input: { id?: string; name: string; width?: number; height?: number },
  ): Promise<PixelRoomMetadata> {
    const current = await this.getAllForChar(charId) ?? DEFAULT_PIXEL_ROOM_METADATA.map(room => ({ ...room }));
    const id = input.id?.trim() || `room_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (id === ROOM_METADATA_ID || current.some(room => room.id === id)) throw new Error('房间 ID 已存在');
    const room: PixelRoomMetadata = {
      id,
      name: input.name.trim() || '新房间',
      order: current.length,
      width: clampDimension(input.width, 6),
      height: clampDimension(input.height, 5),
    };
    await this.saveAllForChar(charId, [...current, room]);
    await PixelLayoutDB.save(createEmptyLayout(charId, room));
    return room;
  },

  async renameRoom(charId: string, roomId: string, name: string): Promise<boolean> {
    const current = await this.getAllForChar(charId);
    const cleanName = name.trim();
    if (!current || !cleanName || !current.some(room => room.id === roomId)) return false;
    await this.saveAllForChar(charId, current.map(room => room.id === roomId ? { ...room, name: cleanName } : room));
    return true;
  },

  async deleteRoom(charId: string, roomId: string): Promise<boolean> {
    const current = await this.getAllForChar(charId);
    if (!current || current.length <= 1 || !current.some(room => room.id === roomId)) return false;
    await this.saveAllForChar(charId, current.filter(room => room.id !== roomId));
    await PixelLayoutDB.delete(charId, roomId);
    return true;
  },

  async reorderRooms(charId: string, orderedIds: string[]): Promise<boolean> {
    const current = await this.getAllForChar(charId);
    if (!current || orderedIds.length !== current.length || new Set(orderedIds).size !== current.length) return false;
    const byId = new Map(current.map(room => [room.id, room]));
    if (orderedIds.some(id => !byId.has(id))) return false;
    await this.saveAllForChar(charId, orderedIds.map((id, order) => ({ ...byId.get(id)!, order })));
    return true;
  },

  async mergePresetRooms(
    charId: string,
    rooms: PixelRoomPreset[],
    replaceExisting = false,
  ): Promise<PixelRoomMetadata[]> {
    const existing = await this.getAllForChar(charId);
    const presetHasMetadata = rooms.some(room => (
      room.name != null || room.order != null || room.width != null || room.height != null
    ));
    const base = replaceExisting
      ? []
      : existing ?? (presetHasMetadata ? [] : DEFAULT_PIXEL_ROOM_METADATA.map(room => ({ ...room })));
    const byId = new Map(base.map(room => [room.id, room]));
    for (const presetRoom of rooms) {
      if (!presetRoom || typeof presetRoom.roomId !== 'string' || !presetRoom.roomId.trim() || presetRoom.roomId === ROOM_METADATA_ID) continue;
      const current = byId.get(presetRoom.roomId);
      const fallback = current ?? defaultPixelRoomMetadata(presetRoom.roomId, byId.size);
      byId.set(presetRoom.roomId, {
        id: presetRoom.roomId,
        name: presetRoom.name?.trim() || fallback.name,
        order: typeof presetRoom.order === 'number' ? presetRoom.order : fallback.order,
        width: clampDimension(presetRoom.width, fallback.width),
        height: clampDimension(presetRoom.height, fallback.height),
      });
    }
    return this.saveAllForChar(charId, Array.from(byId.values()));
  },
};

// ─── 内置默认家园预设 ──────────────────────────────

/**
 * 尝试为指定角色加载内置默认家园预设。
 * 查找顺序：
 *   1. public/pixel-presets/<charId>.json   — 该角色专属预设
 *   2. public/pixel-presets/default.json    — 所有角色共用的默认家园
 * 预设文件由仓库 pixelroom/ 导出的 JSON 复制而来。
 *
 * 返回 true 表示成功加载并写入了至少一个房间。
 */
async function trySeedDefaultHome(charId: string): Promise<boolean> {
  // 仅在浏览器环境（有 fetch + 静态资源服务）下尝试
  if (typeof fetch !== 'function') return false;

  const base = (import.meta as any).env?.BASE_URL ?? '/';
  const candidates = [
    `${base}pixel-presets/${encodeURIComponent(charId)}.json`,
    `${base}pixel-presets/default.json`,
  ];

  let preset: any = null;
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { cache: 'force-cache' });
      if (!resp.ok) continue;
      preset = await resp.json();
      if (preset && Array.isArray(preset.rooms) && preset.rooms.length > 0) break;
      preset = null;
    } catch {
      // 继续下一个候选
    }
  }
  if (!preset) return false;

  // 导入资产（跳过已存在的）
  if (Array.isArray(preset.assets) && preset.assets.length > 0) {
    const existingAssets = await PixelAssetDB.getAll();
    const existingIds = new Set(existingAssets.map(a => a.id));
    const toSave = preset.assets
      .filter((a: any) => a && a.id && !existingIds.has(a.id))
      .map((a: any) => ({
        ...a,
        originalImage: a.pixelImage,
        createdAt: Date.now(),
        tags: ['default'],
      }));
    if (toSave.length > 0) await PixelAssetDB.saveBatch(toSave);
  }

  // 导入房间布局
  const layouts: PixelRoomLayout[] = preset.rooms.map((r: any) => ({
    roomId: r.roomId,
    charId,
    furniture: r.furniture || [],
    wallColor: r.wallColor,
    floorColor: r.floorColor,
    ambiance: r.ambiance,
    wallFillMode: r.wallFillMode,
    wallOffsetX: r.wallOffsetX,
    wallOffsetY: r.wallOffsetY,
    floorFillMode: r.floorFillMode,
    floorOffsetX: r.floorOffsetX,
    floorOffsetY: r.floorOffsetY,
    lastUpdatedAt: Date.now(),
    lastDecoratedBy: 'character' as const,
  }));
  if (layouts.length === 0) return false;
  await PixelRoomDB.mergePresetRooms(charId, preset.rooms);
  await PixelLayoutDB.saveBatch(layouts);
  return true;
}

// ─── 家园状态整合 ────────────────────────────────────

/**
 * 判断一组房间是不是"还没装修过"——没有任何用户放置的家具、也没有任何关联到具体资产的家具。
 * 用于判断是否值得跑一次默认预设填充（如存在旧版空壳数据）。
 */
function layoutsLookUntouched(layouts: PixelRoomLayout[]): boolean {
  if (layouts.length === 0) return true;
  for (const r of layouts) {
    for (const f of r.furniture || []) {
      if (f.placedBy === 'user') return false;
      if (f.assetId) return false;
    }
  }
  return true;
}

/** 获取角色的完整家园状态，不存在则初始化默认 */
export async function getOrCreateHomeState(charId: string): Promise<PixelHomeState> {
  let existing = await PixelLayoutDB.getAllForChar(charId);
  let roomMetadata = await PixelRoomDB.getAllForChar(charId);

  // 首次进入、或之前只存了空壳（没家具/没用户放置）：尝试加载内置默认家园预设
  if (!roomMetadata && layoutsLookUntouched(existing)) {
    try {
      const seeded = await trySeedDefaultHome(charId);
      if (seeded) {
        existing = await PixelLayoutDB.getAllForChar(charId);
        roomMetadata = await PixelRoomDB.getAllForChar(charId);
      }
    } catch (e) {
      console.warn('[pixelHome] seed default home failed:', e);
    }
  }

  // 无 metadata = 旧版角色。首次读取时把原七室目录持久化；旧布局和家具不动。
  if (!roomMetadata) {
    roomMetadata = await PixelRoomDB.saveAllForChar(
      charId,
      DEFAULT_PIXEL_ROOM_METADATA.map(room => ({ ...room })),
    );
  }

  // 只补 metadata 中声明但尚无布局的房间；已有布局原样保留。
  const existingMap = new Map(existing.map(r => [r.roomId, r]));
  const allRooms: PixelRoomLayout[] = roomMetadata.map(room => (
    existingMap.get(room.id) ?? createEmptyLayout(charId, room)
  ));

  // 保存新建的房间
  const newRooms = allRooms.filter(room => !existingMap.has(room.roomId));
  if (newRooms.length > 0) {
    await PixelLayoutDB.saveBatch(newRooms);
  }

  return {
    charId,
    roomMetadata,
    rooms: allRooms,
    lastLLMDecoration: 0,
  };
}
