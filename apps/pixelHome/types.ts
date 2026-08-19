/**
 * Pixel Home — 像素家园类型定义
 */

// ─── 像素资产 ─────────────────────────────────────────

export interface PixelAsset {
  id: string;
  name: string;
  originalImage: string;      // 原始图片 data URI
  pixelImage: string;         // 像素化后 data URI
  pixelSize: number;          // 24/32/48/64
  palette: string[];          // 提取的调色板颜色 (hex)
  width: number;              // 像素宽
  height: number;             // 像素高
  createdAt: number;
  tags: string[];
}

// ─── 房间槽位定义（保留作为默认家具模板） ─────────────

export interface RoomSlotDef {
  id: string;
  name: string;
  category: string;
  required: boolean;
  defaultX: number;
  defaultY: number;
  defaultScale: number;
}

// ─── 已放置的家具（支持自由放置）─────────────────────

export interface PlacedFurniture {
  slotId: string;             // 默认家具用槽位 ID，用户自由放置用 unique ID
  assetId: string | null;     // 像素资产 ID（null = 使用默认像素图）
  x: number;
  y: number;
  scale: number;
  rotation: number;
  colorOverride?: string;
  placedBy: 'user' | 'character';
  isDefault?: boolean;        // 是否为默认槽位家具（false/undefined = 用户自由放置）
  /**
   * 前后遮挡手动覆盖：
   *   'front' = 总是压在其他家具上方
   *   'back'  = 总是垫在其他家具下方（但仍在地毯之上）
   *   undefined / 'auto' = 按家具底边自动排
   */
  zOrder?: 'auto' | 'front' | 'back';
}

// ─── 单个房间布局 ─────────────────────────────────────

export interface PixelRoomLayout {
  roomId: string;
  charId: string;
  furniture: PlacedFurniture[];
  /** 墙颜色：空字符串 = 用房间默认；以 "data:" 开头 = 图片纹理；以 "#" 开头 = 纯色；其它视为空 */
  wallColor: string;
  /** 地板颜色：规则同 wallColor */
  floorColor: string;
  ambiance: string;
  lastUpdatedAt: number;
  lastDecoratedBy: 'user' | 'character';
  /** 墙纸铺设模式：'tile' = 循环平铺（默认），'stretch' = 整张放大铺满（cover） */
  wallFillMode?: 'tile' | 'stretch';
  /** 拉伸模式下的位置百分比（0..100，默认 50 居中） */
  wallOffsetX?: number;
  wallOffsetY?: number;
  /** 地板铺设模式，同上 */
  floorFillMode?: 'tile' | 'stretch';
  floorOffsetX?: number;
  floorOffsetY?: number;
}

/** 每角色独立的房间目录；布局与家具仍保存在 PixelRoomLayout。 */
export interface PixelRoomMetadata {
  id: string;
  name: string;
  order: number;
  width: number;
  height: number;
}

// ─── 可选整屋总平面图 ─────────────────────────

export type PixelHomeMapRoomKind = 'indoor' | 'outdoor' | 'terrace' | 'utility';
export type PixelHomeMapRoomShape = 'rect' | 'dome';

/**
 * 只描述某个已有房间在总图上的位置与视觉语义。
 * 家具仍从 PixelRoomLayout 读取，不在总图里复制任何房间数据。
 */
export interface PixelHomeMapRoom {
  roomId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  level?: number;
  kind?: PixelHomeMapRoomKind;
  shape?: PixelHomeMapRoomShape;
  accent?: string;
  /** 可选的总图预览素材引用；只存 assetId，不复制素材或家具。 */
  previewAssetIds?: string[];
}

export interface PixelHomeMapLayout {
  version: 1;
  title?: string;
  subtitle?: string;
  width: number;
  height: number;
  seaEdge?: 'top' | 'right' | 'bottom' | 'left';
  rooms: PixelHomeMapRoom[];
}

// ─── 整个家园状态 ─────────────────────────────────────

export interface PixelHomeTheme {
  /** 房间外围深色描边色 */
  wallBorder: string;
  /** 房间外围浅色描边（高光） */
  wallBorderLight: string;
  /** 家园最外层背景色（小地图画布底色） */
  bgColor: string;
  /** 楼梯/走廊的亮条颜色（跟随外框风格） */
  corridorStep: string;
}

export const DEFAULT_HOME_THEME: PixelHomeTheme = {
  wallBorder: '#3d2b1f',
  wallBorderLight: '#5c4332',
  bgColor: '#1a1410',
  corridorStep: '#c4a882',
};

/** wallColor/floorColor 的解读器：判断是图片、纯色还是默认 */
export function decodeColorField(v: string | undefined | null):
  | { kind: 'image'; value: string }
  | { kind: 'color'; value: string }
  | { kind: 'default' } {
  if (!v) return { kind: 'default' };
  if (v.startsWith('data:')) return { kind: 'image', value: v };
  // 允许 "#rgb"/"#rgba"/"#rrggbb"/"#rrggbbaa"
  if (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return { kind: 'color', value: v };
  return { kind: 'default' };
}

export interface PixelHomeState {
  charId: string;
  roomMetadata: PixelRoomMetadata[];
  rooms: PixelRoomLayout[];
  lastLLMDecoration: number;
  /** 自定义家园可选总图；缺失时继续使用旧七室图或房间卡片。 */
  mapLayout?: PixelHomeMapLayout;
  /** 全局主题色（外围墙体 + 背景）；不设置时用 DEFAULT_HOME_THEME */
  theme?: PixelHomeTheme;
}

// ─── LLM 装修动作 ─────────────────────────────────────

export type DecorationActionType = 'move' | 'recolor' | 'rescale' | 'set_wall' | 'set_floor' | 'set_ambiance';

export interface DecorationAction {
  type: DecorationActionType;
  roomId: string;
  slotId?: string;
  x?: number;
  y?: number;
  scale?: number;
  color?: string;
  ambiance?: string;
}

export interface DecorationDiff {
  charId: string;
  actions: DecorationAction[];
  summary: string;
  timestamp: number;
}

// ─── 视图状态 ─────────────────────────────────────────

export type PixelHomeViewMode = 'map' | 'room' | 'rooms' | 'generator' | 'library' | 'charEditor' | 'dive';

// ─── 房屋预设（导入/导出）─────────────────────────────

export interface PixelHomePreset {
  version: 1;
  name: string;
  author: string;
  createdAt: number;
  /** 整屋包可替换当前角色的房间目录；旧 preset 缺省为合并，保持兼容。 */
  replaceRoomCatalog?: boolean;
  /** 可选整屋总图；旧 preset 缺失时行为不变。 */
  mapLayout?: PixelHomeMapLayout;
  rooms: PixelRoomPreset[];
  assets: PixelAssetPreset[];   // 包含的像素资产（用到的才导出）
}

/** 房间预设（去掉 charId，便于跨角色导入） */
export interface PixelRoomPreset {
  roomId: string;
  /** v1 向后兼容扩展：旧 preset 没有这些字段时按旧七室或通用默认值补齐。 */
  name?: string;
  order?: number;
  width?: number;
  height?: number;
  furniture: PlacedFurniture[];
  wallColor: string;
  floorColor: string;
  ambiance: string;
  /** 铺设模式 + 偏移（和 PixelRoomLayout 保持同步） */
  wallFillMode?: 'tile' | 'stretch';
  wallOffsetX?: number;
  wallOffsetY?: number;
  floorFillMode?: 'tile' | 'stretch';
  floorOffsetX?: number;
  floorOffsetY?: number;
}

/** 精简版资产（仅包含渲染需要的信息） */
export interface PixelAssetPreset {
  id: string;
  name: string;
  pixelImage: string;
  pixelSize: number;
  palette: string[];
  width: number;
  height: number;
}
