import type {
    VisualIdentity,
    VisualIdentityReference,
    VisualIdentityReferenceRole,
    VisualIdentityStrength,
} from '../types';

/** 单角色长期参考图上限（与 validateVisualIdentity 的规则保持一致）。 */
export const MAX_VISUAL_IDENTITY_REFERENCES = 5;

/** 参考图 role 选项（精细模式可选，简易模式默认 other）。 */
export const VISUAL_IDENTITY_ROLE_OPTIONS: Array<{ value: VisualIdentityReferenceRole; label: string }> = [
    { value: 'primary-face', label: '主正脸' },
    { value: 'front', label: '正脸' },
    { value: 'three-quarter', label: '3/4 侧脸' },
    { value: 'profile', label: '侧脸' },
    { value: 'full-body', label: '全身' },
    { value: 'body', label: '体型' },
    { value: 'other', label: '其他' },
];

/** 视觉身份强度选项。 */
export const VISUAL_IDENTITY_STRENGTH_OPTIONS: Array<{ value: VisualIdentityStrength; label: string; hint: string }> = [
    { value: 'loose', label: '宽松', hint: '允许更大外观变化' },
    { value: 'balanced', label: '均衡', hint: '关键特征保持一致' },
    { value: 'strict', label: '严格', hint: '尽量还原参考图' },
];

/** 列表中没有主图时，把第一张提升为主图（简易模式校验要求至少一张主图）。 */
function ensurePrimaryReference(refs: VisualIdentityReference[]): VisualIdentityReference[] {
    if (refs.length === 0 || refs.some(ref => ref.isPrimary)) return refs;
    return refs.map((ref, index) => (index === 0 ? { ...ref, isPrimary: true } : ref));
}

/**
 * 简易 / 精细模式切换：保留已有数据（参考图、描述、特质、强度），
 * 切回简易模式时自动确保存在一张主参考图。
 */
export function setVisualIdentityMode(vi: VisualIdentity, mode: VisualIdentity['mode']): VisualIdentity {
    if (vi.mode === mode) return vi;
    if (mode === 'simple') {
        return { ...vi, mode, references: ensurePrimaryReference(vi.references) };
    }
    return { ...vi, mode };
}

/** 指定某张参考图为主图（同一时间最多一张主图）。 */
export function setPrimaryVisualIdentityReference(
    refs: VisualIdentityReference[],
    referenceId: string,
): VisualIdentityReference[] {
    return refs.map(ref => ({ ...ref, isPrimary: ref.id === referenceId ? true : undefined }));
}

/**
 * 从列表移除某张参考图（只动元数据数组，Blob 清理由 removeVisualIdentityReference 负责）。
 * 删除的是主图且还有剩余时，自动把第一张剩余图提升为主图，避免简易模式缺主图。
 */
export function removeVisualIdentityReferenceFromList(
    refs: VisualIdentityReference[],
    referenceId: string,
): VisualIdentityReference[] {
    const target = refs.find(ref => ref.id === referenceId);
    const remaining = refs.filter(ref => ref.id !== referenceId);
    if (target?.isPrimary && remaining.length > 0) {
        return remaining.map((ref, index) => (index === 0 ? { ...ref, isPrimary: true } : ref));
    }
    return remaining;
}

/** 修改某张参考图的 role 标记。 */
export function updateVisualIdentityReferenceRole(
    refs: VisualIdentityReference[],
    referenceId: string,
    role: VisualIdentityReferenceRole,
): VisualIdentityReference[] {
    return refs.map(ref => (ref.id === referenceId ? { ...ref, role } : ref));
}

/**
 * 计算本次上传可接收的文件数量（长期参考图总数上限 MAX_VISUAL_IDENTITY_REFERENCES）。
 * @returns accepted 实际可添加数量；rejected 因超限被忽略的数量
 */
export function clampVisualIdentityReferenceUpload(
    currentCount: number,
    incomingCount: number,
): { accepted: number; rejected: number } {
    const room = Math.max(0, MAX_VISUAL_IDENTITY_REFERENCES - currentCount);
    const accepted = Math.min(room, Math.max(0, incomingCount));
    return { accepted, rejected: Math.max(0, incomingCount) - accepted };
}

/** 把特质输入文本拆成数组（支持换行 / 分号 / 中英文逗号 / 顿号）。 */
export function parseTraitInput(text: string): string[] {
    return text
        .split(/[\n;；,，、]+/)
        .map(part => part.trim())
        .filter(Boolean);
}

/** 特质数组还原为多行文本（编辑框回显用）。 */
export function joinTraitInput(traits: string[] | undefined): string {
    return (traits ?? []).join('\n');
}
