/**
 * 视觉形态预设（Phase 2F）：同一角色多套"视觉形态"。
 *
 * 兼容规则：
 * - presets 存在且 activeVisualIdentityPresetId 有效 → 生图使用该 preset.identity
 * - 否则回退现有 character.visualIdentity（旧角色零迁移照常工作）
 * - 不复制 Blob：legacy → 预设时直接复用原 blobRef；legacy 字段保留不删（既是回退也是共享引用方）
 * - 不按角色名关联，一切以 characterId 挂在 CharacterProfile 上
 * - 删除预设只清理该预设真正独占的 Blob；被其他 preset / legacy 引用的 blobRef 一律保留
 */

import type { VisualIdentity, VisualIdentityPreset } from '../types';
import { deleteBlobRef } from './blobRef';

/** 任何挂载 visualIdentity / presets 的宿主（CharacterProfile 结构性满足）。 */
export interface VisualIdentityHost {
    visualIdentity?: VisualIdentity;
    visualIdentityPresets?: VisualIdentityPreset[];
    activeVisualIdentityPresetId?: string;
}

/** legacy visualIdentity 迁移为预设时的默认名称。 */
export const DEFAULT_PRESET_NAME = '默认形态';

function genPresetId(): string {
    return `vipreset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 当前 active 预设；presets 缺失 / activeId 失效时返回 undefined（调用方回退 legacy）。 */
export function getActiveVisualIdentityPreset(host: VisualIdentityHost): VisualIdentityPreset | undefined {
    if (!host.visualIdentityPresets?.length) return undefined;
    if (!host.activeVisualIdentityPresetId) return undefined;
    return host.visualIdentityPresets.find(preset => preset.id === host.activeVisualIdentityPresetId);
}

/** 生图实际使用的视觉身份：active preset 优先，否则 legacy visualIdentity。 */
export function getActiveVisualIdentity(host: VisualIdentityHost): VisualIdentity | undefined {
    return getActiveVisualIdentityPreset(host)?.identity ?? host.visualIdentity;
}

/** 新建预设；不传 identity 时为空白禁用形态。id/时间戳由此处生成。 */
export function createVisualIdentityPreset(
    name: string,
    identity?: VisualIdentity,
    description?: string,
): VisualIdentityPreset {
    const now = Date.now();
    return {
        id: genPresetId(),
        name: name.trim() || DEFAULT_PRESET_NAME,
        description: description?.trim() || undefined,
        identity: identity ?? { enabled: false, mode: 'simple', references: [] },
        createdAt: now,
        updatedAt: now,
    };
}

/** 重命名（可同时更新描述）：返回更新后的预设副本（纯函数）。 */
export function renameVisualIdentityPreset(
    preset: VisualIdentityPreset,
    name: string,
    description?: string,
): VisualIdentityPreset {
    return {
        ...preset,
        name: name.trim() || preset.name,
        description: description !== undefined ? (description.trim() || undefined) : preset.description,
        updatedAt: Date.now(),
    };
}

/** 有效的 activeId：当前值仍指向存在的 preset 则保留，否则指向第一套，无 preset 则 undefined（回退 legacy）。 */
export function resolveActivePresetId(presets: VisualIdentityPreset[], activeId?: string): string | undefined {
    if (presets.length === 0) return undefined;
    if (activeId && presets.some(preset => preset.id === activeId)) return activeId;
    return presets[0].id;
}

/**
 * legacy visualIdentity → 「默认形态」预设的安全迁移：
 * - 复用原 blobRef（不写任何新 Blob），legacy 字段原样保留
 * - 已有 presets 时只追加，不打乱现有顺序；activeId 指向新预设（用户刚转换，意图明确）
 * - legacy 无参考图且未启用时返回 null（没有可迁移的内容）
 */
export function migrateLegacyVisualIdentityToPreset(host: VisualIdentityHost): {
    presets: VisualIdentityPreset[];
    activeVisualIdentityPresetId: string;
} | null {
    const legacy = host.visualIdentity;
    if (!legacy || legacy.references.length === 0 || !legacy.enabled) return null;
    if (host.visualIdentityPresets?.some(preset => preset.name === DEFAULT_PRESET_NAME)) return null;
    const preset = createVisualIdentityPreset(DEFAULT_PRESET_NAME, legacy);
    return {
        presets: [preset, ...(host.visualIdentityPresets ?? [])],
        activeVisualIdentityPresetId: preset.id,
    };
}

/**
 * 删除预设：
 * - 只清理该预设独占（其他 preset 与 legacy visualIdentity 都未引用）的 Blob
 * - 删除的是当前 active 时，自动切到剩余第一套；没有任何 preset 时回退 legacy / 空状态
 */
export async function deleteVisualIdentityPreset(
    presetId: string,
    presets: VisualIdentityPreset[],
    legacyVisualIdentity?: VisualIdentity,
): Promise<{ presets: VisualIdentityPreset[]; nextActiveId: string | undefined }> {
    const target = presets.find(preset => preset.id === presetId);
    const remaining = presets.filter(preset => preset.id !== presetId);
    const nextActiveId = resolveActivePresetId(remaining);

    if (target) {
        const stillReferenced = new Set<string>();
        for (const preset of remaining) {
            for (const ref of preset.identity.references) stillReferenced.add(ref.blobRef);
        }
        for (const ref of legacyVisualIdentity?.references ?? []) stillReferenced.add(ref.blobRef);

        const exclusive = target.identity.references
            .map(ref => ref.blobRef)
            .filter((ref, index, all) => all.indexOf(ref) === index) // 去重
            .filter(ref => !stillReferenced.has(ref));
        await Promise.allSettled(exclusive.map(ref => deleteBlobRef(ref)));
    }

    return { presets: remaining, nextActiveId };
}
