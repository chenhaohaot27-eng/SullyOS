import type {
  PixelHomeMapLayout,
  PixelHomeMapRoom,
  PixelHomeMapRoomKind,
  PixelHomeMapRoomShape,
  PixelRoomMetadata,
} from './types';

const MAP_KINDS = new Set<PixelHomeMapRoomKind>(['indoor', 'outdoor', 'terrace', 'utility']);
const MAP_SHAPES = new Set<PixelHomeMapRoomShape>(['rect', 'dome']);

const finiteBetween = (value: unknown, min: number, max: number): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(min, Math.min(max, parsed));
};

/**
 * 清洗外部 preset 带入的总图数据。它是纯函数，不读写数据库。
 * 无效/重复房间被忽略；没有任何有效房间时整个布局视为不可用。
 */
export function normalizePixelHomeMapLayout(value: unknown): PixelHomeMapLayout | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<PixelHomeMapLayout>;
  const width = finiteBetween(input.width, 4, 100);
  const height = finiteBetween(input.height, 4, 100);
  if (width == null || height == null || !Array.isArray(input.rooms)) return undefined;

  const seen = new Set<string>();
  const rooms: PixelHomeMapRoom[] = [];
  for (const raw of input.rooms) {
    if (!raw || typeof raw !== 'object') continue;
    const room = raw as Partial<PixelHomeMapRoom>;
    const roomId = typeof room.roomId === 'string' ? room.roomId.trim() : '';
    const x = finiteBetween(room.x, 0, Math.max(0, width - 1));
    const y = finiteBetween(room.y, 0, Math.max(0, height - 1));
    const roomWidth = finiteBetween(room.width, 1, width);
    const roomHeight = finiteBetween(room.height, 1, height);
    if (!roomId || seen.has(roomId) || x == null || y == null || roomWidth == null || roomHeight == null) continue;
    seen.add(roomId);

    const kind = MAP_KINDS.has(room.kind as PixelHomeMapRoomKind) ? room.kind as PixelHomeMapRoomKind : undefined;
    const shape = MAP_SHAPES.has(room.shape as PixelHomeMapRoomShape) ? room.shape as PixelHomeMapRoomShape : undefined;
    const accent = typeof room.accent === 'string' && /^#[0-9a-f]{6}$/i.test(room.accent) ? room.accent : undefined;
    const previewAssetIds = Array.isArray(room.previewAssetIds)
      ? [...new Set(room.previewAssetIds.filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim()))].slice(0, 6)
      : undefined;

    rooms.push({
      roomId,
      x,
      y,
      width: Math.min(roomWidth, width - x),
      height: Math.min(roomHeight, height - y),
      level: typeof room.level === 'number' && Number.isFinite(room.level) ? Math.max(0, Math.round(room.level)) : undefined,
      kind,
      shape,
      accent,
      previewAssetIds,
    });
  }
  if (rooms.length === 0) return undefined;

  const seaEdge = ['top', 'right', 'bottom', 'left'].includes(String(input.seaEdge))
    ? input.seaEdge
    : undefined;
  return {
    version: 1,
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined,
    subtitle: typeof input.subtitle === 'string' && input.subtitle.trim() ? input.subtitle.trim() : undefined,
    width,
    height,
    seaEdge,
    rooms,
  };
}

/** 总图只有在其引用的房间都存在于当前角色目录时才启用。 */
export function pixelHomeMapLayoutMatchesRooms(
  layout: PixelHomeMapLayout | undefined,
  rooms: PixelRoomMetadata[],
): layout is PixelHomeMapLayout {
  if (!layout) return false;
  const roomIds = new Set(rooms.map(room => room.id));
  return layout.rooms.length > 0 && layout.rooms.every(room => roomIds.has(room.roomId));
}
