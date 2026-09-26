import { describe, it, expect } from 'vitest';
import { buildVisualIdentityPrompt } from './visualIdentityPrompt';
import type { VisualIdentity } from '../types';

describe('buildVisualIdentityPrompt', () => {
    it('returns empty string when visualIdentity is undefined', () => {
        expect(buildVisualIdentityPrompt(undefined)).toBe('');
    });

    it('returns empty string when enabled is false', () => {
        const vi: VisualIdentity = {
            enabled: false,
            mode: 'simple',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        expect(buildVisualIdentityPrompt(vi)).toBe('');
    });

    it('returns empty string when references array is empty', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: [],
        };
        expect(buildVisualIdentityPrompt(vi)).toBe('');
    });

    it('generates simple mode prompt with basic identity constraint', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'simple',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('参考图定义的是同一角色身份');
        expect(result).toContain('保持脸、基础体型和核心外貌一致');
        expect(result).toContain('服装、表情、动作、发型细节、环境可随当前情节变化');
    });

    it('generates advanced mode prompt with appearance summary', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            appearanceSummary: '黑色长发，蓝色眼睛，身高165cm',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('角色外观总结：黑色长发，蓝色眼睛，身高165cm');
    });

    it('includes fixed traits in advanced mode', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            fixedTraits: ['黑色长发', '蓝色眼睛', '高挑身材'],
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('必须保持的固定特征：黑色长发、蓝色眼睛、高挑身材');
    });

    it('includes variable traits in advanced mode', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            variableTraits: ['服装风格', '发型', '配饰'],
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('可随情节变化的特征：服装风格、发型、配饰');
    });

    it('includes identity strength hint - loose', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            identityStrength: 'loose',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('允许适度变化，捕捉大致特征即可');
    });

    it('includes identity strength hint - balanced', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            identityStrength: 'balanced',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('保持核心身份特征，允许自然变化');
    });

    it('includes identity strength hint - strict', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            identityStrength: 'strict',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('严格保持身份一致性，最小化变化');
    });

    it('filters out empty trait strings', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            fixedTraits: ['黑色长发', '', '  ', '蓝色眼睛'],
            variableTraits: ['', '服装风格', '  '],
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('必须保持的固定特征：黑色长发、蓝色眼睛');
        expect(result).toContain('可随情节变化的特征：服装风格');
    });

    it('generates full advanced mode prompt with all fields', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            appearanceSummary: '东方面孔，黑色长发，蓝色眼睛，身高165cm，身材苗条',
            fixedTraits: ['黑色长发', '蓝色眼睛', '东方面孔'],
            variableTraits: ['服装风格', '发型样式', '配饰'],
            identityStrength: 'balanced',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).toContain('角色外观总结：东方面孔，黑色长发，蓝色眼睛，身高165cm，身材苗条');
        expect(result).toContain('必须保持的固定特征：黑色长发、蓝色眼睛、东方面孔');
        expect(result).toContain('可随情节变化的特征：服装风格、发型样式、配饰');
        expect(result).toContain('保持核心身份特征，允许自然变化');
    });

    it('does not include simple mode constraint in advanced mode', () => {
        const vi: VisualIdentity = {
            enabled: true,
            mode: 'advanced',
            appearanceSummary: '测试',
            references: [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:abc', isPrimary: true, createdAt: Date.now() },
            ],
        };
        const result = buildVisualIdentityPrompt(vi);
        expect(result).not.toContain('参考图定义的是同一角色身份');
    });
});
