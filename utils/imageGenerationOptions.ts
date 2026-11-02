/**
 * Scene Image Options（「见面摄影机 / 选中文本生图」导演选项）
 *
 * 职责：
 * - 定义构图方式 / 环境保留 / 人物焦点 / AI 导演开关的默认值
 * - 复用浏览器 localStorage 记住用户上次选择（键名风格与 imageGenerationConfig 一致）
 *
 * 原则：不造新轮子——只存这四个字段的小对象；解析容错，坏数据回落默认值。
 */

import type {
  SceneCompositionMode,
  SceneEnvironmentDetail,
  SceneImageOptions,
  SceneSubjectFocus,
} from '../types';

export const SCENE_IMAGE_OPTIONS_STORAGE_KEY = 'os_scene_image_options_v1';

/** 建议默认值：剧情平衡 + 保留关键元素 + 自动判断 + 开启导演。 */
export const DEFAULT_SCENE_IMAGE_OPTIONS: SceneImageOptions = {
  compositionMode: 'narrative_balanced',
  environmentDetail: 'key_elements',
  subjectFocus: 'auto',
  directorEnabled: true,
};

const COMPOSITION_MODES: readonly SceneCompositionMode[] = ['character_focus', 'narrative_balanced', 'text_faithful'];
const ENVIRONMENT_DETAILS: readonly SceneEnvironmentDetail[] = ['minimal', 'key_elements', 'full_scene'];
const SUBJECT_FOCUSSES: readonly SceneSubjectFocus[] = ['duo', 'current_character', 'auto', 'npc_allowed'];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 把任意（可能是持久化的脏）数据归一成合法选项；多余字段丢弃。 */
export function normalizeSceneImageOptions(source: unknown): SceneImageOptions {
  const raw = (source && typeof source === 'object' ? source : {}) as Record<string, unknown>;
  return {
    compositionMode: oneOf(raw.compositionMode, COMPOSITION_MODES, DEFAULT_SCENE_IMAGE_OPTIONS.compositionMode),
    environmentDetail: oneOf(raw.environmentDetail, ENVIRONMENT_DETAILS, DEFAULT_SCENE_IMAGE_OPTIONS.environmentDetail),
    subjectFocus: oneOf(raw.subjectFocus, SUBJECT_FOCUSSES, DEFAULT_SCENE_IMAGE_OPTIONS.subjectFocus),
    directorEnabled: typeof raw.directorEnabled === 'boolean' ? raw.directorEnabled : DEFAULT_SCENE_IMAGE_OPTIONS.directorEnabled,
  };
}

/** 读取上次的选项；无存储 / JSON 损坏 / SSR 一律回落默认值。 */
export function loadSceneImageOptions(storage: Pick<Storage, 'getItem'> = localStorage): SceneImageOptions {
  try {
    const raw = storage.getItem(SCENE_IMAGE_OPTIONS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SCENE_IMAGE_OPTIONS };
    return normalizeSceneImageOptions(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SCENE_IMAGE_OPTIONS };
  }
}

/** 记住用户本次选择（写入失败静默：隐私模式 / 存储满不影响当次会话）。 */
export function saveSceneImageOptions(
  options: SceneImageOptions,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(SCENE_IMAGE_OPTIONS_STORAGE_KEY, JSON.stringify(normalizeSceneImageOptions(options)));
  } catch {
    /* ignore */
  }
}
