import type { VisualIdentity, VisualIdentityReference } from '../types';
import { putImageBlob, getBlobForRef, deleteBlobRefIfUnreferenced } from './blobRef';

/** 生成唯一参考图 ID */
function genReferenceId(): string {
    return `viref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 创建默认视觉身份（禁用状态） */
export function createDefaultVisualIdentity(): VisualIdentity {
    return {
        enabled: false,
        mode: 'simple',
        references: [],
    };
}

/** 规范化视觉身份数据（兼容旧角色） */
export function normalizeVisualIdentity(vi: VisualIdentity | undefined): VisualIdentity {
    if (!vi) return createDefaultVisualIdentity();
    return {
        enabled: vi.enabled ?? false,
        mode: vi.mode || 'simple',
        appearanceSummary: vi.appearanceSummary,
        fixedTraits: Array.isArray(vi.fixedTraits) ? vi.fixedTraits : undefined,
        variableTraits: Array.isArray(vi.variableTraits) ? vi.variableTraits : undefined,
        identityStrength: vi.identityStrength,
        references: Array.isArray(vi.references) ? vi.references : [],
    };
}

/**
 * 添加视觉身份参考图。
 * @param blob 图片 Blob
 * @param role 参考图角色标记
 * @param isPrimary 是否为主参考图
 * @returns 新的 VisualIdentityReference
 */
export async function addVisualIdentityReference(
    blob: Blob,
    role: VisualIdentityReference['role'] = 'other',
    isPrimary = false,
): Promise<VisualIdentityReference> {
    const blobRef = await putImageBlob(blob);
    return {
        id: genReferenceId(),
        role,
        blobRef,
        isPrimary,
        createdAt: Date.now(),
    };
}

/**
 * 删除视觉身份参考图（同时清理未被引用的 Blob）。
 * @param reference 要删除的参考图
 * @param allReferences 当前角色的全部参考图列表（用于判断是否有其他引用）
 */
export async function removeVisualIdentityReference(
    reference: VisualIdentityReference,
    allReferences: VisualIdentityReference[],
): Promise<void> {
    const isReferenced = allReferences.some(
        ref => ref.id !== reference.id && ref.blobRef === reference.blobRef
    );
    if (!isReferenced) {
        await deleteBlobRefIfUnreferenced(reference.blobRef);
    }
}

/**
 * 解析视觉身份参考图为 Blob（用于生图前准备）。
 * @param references 参考图列表
 * @returns 成功解析的 {blobRef, blob} 对象数组
 */
export async function resolveVisualIdentityReferences(
    references: VisualIdentityReference[],
): Promise<Array<{ reference: VisualIdentityReference; blob: Blob }>> {
    const resolved: Array<{ reference: VisualIdentityReference; blob: Blob }> = [];
    for (const ref of references) {
        const blob = await getBlobForRef(ref.blobRef);
        if (blob) {
            resolved.push({ reference: ref, blob });
        }
    }
    return resolved;
}

/**
 * 验证视觉身份配置的合法性。
 * @returns 错误消息数组，空数组表示通过验证
 */
export function validateVisualIdentity(vi: VisualIdentity): string[] {
    const errors: string[] = [];
    if (vi.enabled) {
        if (vi.references.length === 0) {
            errors.push('启用视觉身份至少需要 1 张参考图');
        }
        if (vi.references.length > 5) {
            errors.push('参考图数量不能超过 5 张');
        }
        if (vi.mode === 'simple') {
            const hasPrimary = vi.references.some(ref => ref.isPrimary);
            if (!hasPrimary && vi.references.length > 0) {
                errors.push('简易模式至少需要标记 1 张主参考图');
            }
        }
    }
    return errors;
}
