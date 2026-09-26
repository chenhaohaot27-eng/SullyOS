import { describe, it, expect } from 'vitest';
import type { CharacterProfile, VisualIdentity } from '../types';
import { DB } from './db';
import { putImageBlob } from './blobRef';

describe('visualIdentity backup integration', () => {
    it('should preserve visualIdentity in character profile', async () => {
        const mockBlob = new Blob(['test-image'], { type: 'image/png' });
        const blobRef = await putImageBlob(mockBlob);

        const testCharacter: CharacterProfile = {
            id: 'test-char-vi-backup',
            name: 'Test Character',
            avatar: 'data:image/png;base64,test',
            description: 'Test description',
            systemPrompt: 'Test prompt',
            memories: [],
            visualIdentity: {
                enabled: true,
                mode: 'simple',
                appearanceSummary: 'A test character appearance',
                fixedTraits: ['black hair', 'blue eyes'],
                references: [
                    {
                        id: 'ref1',
                        role: 'primary-face',
                        blobRef,
                        isPrimary: true,
                        createdAt: Date.now(),
                    },
                ],
            },
        };

        await DB.saveCharacter(testCharacter);
        const allChars = await DB.getAllCharacters();
        const loaded = allChars.find(c => c.id === testCharacter.id);

        expect(loaded).toBeDefined();
        expect(loaded?.visualIdentity).toBeDefined();
        expect(loaded?.visualIdentity?.enabled).toBe(true);
        expect(loaded?.visualIdentity?.mode).toBe('simple');
        expect(loaded?.visualIdentity?.appearanceSummary).toBe('A test character appearance');
        expect(loaded?.visualIdentity?.fixedTraits).toEqual(['black hair', 'blue eyes']);
        expect(loaded?.visualIdentity?.references).toHaveLength(1);
        expect(loaded?.visualIdentity?.references[0].role).toBe('primary-face');
        expect(loaded?.visualIdentity?.references[0].blobRef).toBe(blobRef);

        await DB.deleteCharacter(testCharacter.id);
    });

    it('should handle old characters without visualIdentity', async () => {
        const oldCharacter: CharacterProfile = {
            id: 'test-char-old',
            name: 'Old Character',
            avatar: 'data:image/png;base64,old',
            description: 'Old character',
            systemPrompt: 'Old prompt',
            memories: [],
        };

        await DB.saveCharacter(oldCharacter);
        const allChars = await DB.getAllCharacters();
        const loaded = allChars.find(c => c.id === oldCharacter.id);

        expect(loaded).toBeDefined();
        expect(loaded?.visualIdentity).toBeUndefined();
        expect(loaded?.name).toBe('Old Character');

        await DB.deleteCharacter(oldCharacter.id);
    });

    it('should handle exportFullData with visualIdentity', async () => {
        const mockBlob = new Blob(['export-test'], { type: 'image/jpeg' });
        const blobRef = await putImageBlob(mockBlob);

        const testChar: CharacterProfile = {
            id: 'test-export-vi',
            name: 'Export Test',
            avatar: 'data:image/png;base64,avatar',
            description: 'Export test',
            systemPrompt: 'Export prompt',
            memories: [],
            visualIdentity: {
                enabled: true,
                mode: 'advanced',
                appearanceSummary: 'Export test appearance',
                fixedTraits: ['red hair'],
                variableTraits: ['casual outfit'],
                identityStrength: 'balanced',
                references: [
                    {
                        id: 'export-ref1',
                        role: 'full-body',
                        blobRef,
                        createdAt: Date.now(),
                    },
                ],
            },
        };

        await DB.saveCharacter(testChar);

        const backup = await DB.exportFullData();

        expect(backup.characters).toBeDefined();
        const exportedChar = backup.characters?.find(c => c.id === testChar.id);
        expect(exportedChar).toBeDefined();
        expect(exportedChar?.visualIdentity).toBeDefined();
        expect(exportedChar?.visualIdentity?.enabled).toBe(true);
        expect(exportedChar?.visualIdentity?.references).toHaveLength(1);

        await DB.deleteCharacter(testChar.id);
    });
});
