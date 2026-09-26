import type { VisualIdentity } from '../types';

/**
 * 将 visualIdentity 转换为生图身份约束提示词。
 *
 * 规则：
 * - enabled=false 或 undefined → 返回空字符串（完全保持旧行为）
 * - 简易模式：即使无 appearanceSummary，也注入简短身份约束
 * - 精细模式：额外注入 appearanceSummary、fixedTraits、variableTraits、identityStrength
 * - fixedTraits 强制保持，variableTraits 明确允许随剧情变化
 * - 不覆盖原始剧情 prompt，只作为身份约束前置/合并
 * - 避免把参考图里的服装、背景、姿势误当固定身份
 */
export function buildVisualIdentityPrompt(vi: VisualIdentity | undefined): string {
    if (!vi || !vi.enabled || vi.references.length === 0) return '';

    const parts: string[] = [];

    // 简易模式基础约束
    if (vi.mode === 'simple') {
        parts.push('参考图定义的是同一角色身份；保持脸、基础体型和核心外貌一致；服装、表情、动作、发型细节、环境可随当前情节变化。');
    }

    // 精细模式额外内容
    if (vi.mode === 'advanced') {
        // 外观总结
        if (vi.appearanceSummary?.trim()) {
            parts.push(`角色外观总结：${vi.appearanceSummary.trim()}`);
        }

        // 固定特征（必须保持）
        if (vi.fixedTraits && vi.fixedTraits.length > 0) {
            const fixed = vi.fixedTraits.filter(t => t.trim()).join('、');
            if (fixed) {
                parts.push(`必须保持的固定特征：${fixed}。`);
            }
        }

        // 可变特征（明确允许变化）
        if (vi.variableTraits && vi.variableTraits.length > 0) {
            const variable = vi.variableTraits.filter(t => t.trim()).join('、');
            if (variable) {
                parts.push(`可随情节变化的特征：${variable}。`);
            }
        }

        // 身份强度
        if (vi.identityStrength) {
            const strengthHint = {
                loose: '允许适度变化，捕捉大致特征即可。',
                balanced: '保持核心身份特征，允许自然变化。',
                strict: '严格保持身份一致性，最小化变化。',
            }[vi.identityStrength];
            parts.push(strengthHint);
        }
    }

    return parts.join(' ');
}
