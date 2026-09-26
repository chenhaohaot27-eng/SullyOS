import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { VisualIdentity, VisualIdentityReference } from '../types';
import {
    createDefaultVisualIdentity,
    normalizeVisualIdentity,
    addVisualIdentityReference,
    removeVisualIdentityReference,
    resolveVisualIdentityReferences,
    validateVisualIdentity,
} from './visualIdentity';
import * as blobRef from './blobRef';

vi.mock('./blobRef', () => ({
    putImageBlob: vi.fn(),
    getBlobForRef: vi.fn(),
    deleteBlobRefIfUnreferenced: vi.fn(),
}));

describe('visualIdentity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('createDefaultVisualIdentity', () => {
        it('should create disabled visual identity', () => {
            const vi = createDefaultVisualIdentity();
            expect(vi.enabled).toBe(false);
            expect(vi.mode).toBe('simple');
            expect(vi.references).toEqual([]);
        });
    });

    describe('normalizeVisualIdentity', () => {
        it('should return default for undefined input', () => {
            const vi = normalizeVisualIdentity(undefined);
            expect(vi.enabled).toBe(false);
            expect(vi.mode).toBe('simple');
        });

        it('should preserve existing fields', () => {
            const input: VisualIdentity = {
                enabled: true,
                mode: 'advanced',
                appearanceSummary: 'test summary',
                fixedTraits: ['black hair'],
                references: [],
            };
            const normalized = normalizeVisualIdentity(input);
            expect(normalized.enabled).toBe(true);
            expect(normalized.mode).toBe('advanced');
            expect(normalized.appearanceSummary).toBe('test summary');
            expect(normalized.fixedTraits).toEqual(['black hair']);
        });

        it('should handle partial input', () => {
            const partial = { enabled: true, mode: 'simple' as const, references: [] };
            const normalized = normalizeVisualIdentity(partial);
            expect(normalized.enabled).toBe(true);
            expect(normalized.appearanceSummary).toBeUndefined();
        });
    });

    describe('addVisualIdentityReference', () => {
        it('should create reference with blob', async () => {
            const mockBlob = new Blob(['test'], { type: 'image/png' });
            vi.mocked(blobRef.putImageBlob).mockResolvedValue('blobref:test123');

            const ref = await addVisualIdentityReference(mockBlob, 'primary-face', true);

            expect(ref.id).toMatch(/^viref_/);
            expect(ref.role).toBe('primary-face');
            expect(ref.blobRef).toBe('blobref:test123');
            expect(ref.isPrimary).toBe(true);
            expect(ref.createdAt).toBeGreaterThan(0);
            expect(blobRef.putImageBlob).toHaveBeenCalledWith(mockBlob);
        });

        it('should use default role and isPrimary', async () => {
            const mockBlob = new Blob(['test'], { type: 'image/png' });
            vi.mocked(blobRef.putImageBlob).mockResolvedValue('blobref:test456');

            const ref = await addVisualIdentityReference(mockBlob);

            expect(ref.role).toBe('other');
            expect(ref.isPrimary).toBe(false);
        });
    });

    describe('removeVisualIdentityReference', () => {
        it('should delete unreferenced blob', async () => {
            const refToDelete: VisualIdentityReference = {
                id: 'ref1',
                role: 'primary-face',
                blobRef: 'blobref:unique',
                createdAt: Date.now(),
            };
            const otherRefs: VisualIdentityReference[] = [
                { id: 'ref2', role: 'front', blobRef: 'blobref:other', createdAt: Date.now() },
            ];

            await removeVisualIdentityReference(refToDelete, otherRefs);

            expect(blobRef.deleteBlobRefIfUnreferenced).toHaveBeenCalledWith('blobref:unique');
        });

        it('should not delete shared blob', async () => {
            const refToDelete: VisualIdentityReference = {
                id: 'ref1',
                role: 'primary-face',
                blobRef: 'blobref:shared',
                createdAt: Date.now(),
            };
            const allRefs: VisualIdentityReference[] = [
                refToDelete,
                { id: 'ref2', role: 'front', blobRef: 'blobref:shared', createdAt: Date.now() },
            ];

            await removeVisualIdentityReference(refToDelete, allRefs);

            expect(blobRef.deleteBlobRefIfUnreferenced).not.toHaveBeenCalled();
        });
    });

    describe('resolveVisualIdentityReferences', () => {
        it('should resolve all valid blob refs', async () => {
            const mockBlob1 = new Blob(['img1'], { type: 'image/png' });
            const mockBlob2 = new Blob(['img2'], { type: 'image/jpeg' });

            const refs: VisualIdentityReference[] = [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:img1', createdAt: Date.now() },
                { id: 'ref2', role: 'front', blobRef: 'blobref:img2', createdAt: Date.now() },
            ];

            vi.mocked(blobRef.getBlobForRef)
                .mockResolvedValueOnce(mockBlob1)
                .mockResolvedValueOnce(mockBlob2);

            const resolved = await resolveVisualIdentityReferences(refs);

            expect(resolved).toHaveLength(2);
            expect(resolved[0].reference.id).toBe('ref1');
            expect(resolved[0].blob).toBe(mockBlob1);
            expect(resolved[1].reference.id).toBe('ref2');
            expect(resolved[1].blob).toBe(mockBlob2);
        });

        it('should skip missing blobs', async () => {
            const refs: VisualIdentityReference[] = [
                { id: 'ref1', role: 'primary-face', blobRef: 'blobref:missing', createdAt: Date.now() },
            ];

            vi.mocked(blobRef.getBlobForRef).mockResolvedValue(null);

            const resolved = await resolveVisualIdentityReferences(refs);

            expect(resolved).toHaveLength(0);
        });
    });

    describe('validateVisualIdentity', () => {
        it('should pass for disabled identity', () => {
            const vi: VisualIdentity = {
                enabled: false,
                mode: 'simple',
                references: [],
            };
            expect(validateVisualIdentity(vi)).toEqual([]);
        });

        it('should require at least 1 reference when enabled', () => {
            const vi: VisualIdentity = {
                enabled: true,
                mode: 'simple',
                references: [],
            };
            const errors = validateVisualIdentity(vi);
            expect(errors).toContain('启用视觉身份至少需要 1 张参考图');
        });

        it('should limit references to 5', () => {
            const vi: VisualIdentity = {
                enabled: true,
                mode: 'simple',
                references: Array.from({ length: 6 }, (_, i) => ({
                    id: `ref${i}`,
                    role: 'other' as const,
                    blobRef: `blobref:${i}`,
                    createdAt: Date.now(),
                })),
            };
            const errors = validateVisualIdentity(vi);
            expect(errors).toContain('参考图数量不能超过 5 张');
        });

        it('should require primary reference in simple mode', () => {
            const vi: VisualIdentity = {
                enabled: true,
                mode: 'simple',
                references: [
                    { id: 'ref1', role: 'other', blobRef: 'blobref:1', createdAt: Date.now() },
                ],
            };
            const errors = validateVisualIdentity(vi);
            expect(errors).toContain('简易模式至少需要标记 1 张主参考图');
        });

        it('should pass for valid simple mode', () => {
            const vi: VisualIdentity = {
                enabled: true,
                mode: 'simple',
                references: [
                    { id: 'ref1', role: 'primary-face', blobRef: 'blobref:1', isPrimary: true, createdAt: Date.now() },
                ],
            };
            expect(validateVisualIdentity(vi)).toEqual([]);
        });

        it('should pass for valid advanced mode', () => {
            const vi: VisualIdentity = {
                enabled: true,
                mode: 'advanced',
                appearanceSummary: 'A character with distinctive features.',
                fixedTraits: ['black hair', 'blue eyes'],
                variableTraits: ['casual outfit', 'school uniform'],
                identityStrength: 'balanced',
                references: [
                    { id: 'ref1', role: 'primary-face', blobRef: 'blobref:1', isPrimary: true, createdAt: Date.now() },
                    { id: 'ref2', role: 'full-body', blobRef: 'blobref:2', createdAt: Date.now() },
                ],
            };
            expect(validateVisualIdentity(vi)).toEqual([]);
        });
    });
});
