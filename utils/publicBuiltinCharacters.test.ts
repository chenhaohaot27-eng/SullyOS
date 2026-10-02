import { describe, expect, it } from 'vitest';
import { getPublicBuiltinCharacterIds, isPublicBuiltinCharacterId } from './publicBuiltinCharacters';

describe('public built-in character allowlist', () => {
    it('contains only the intentionally public default character', () => {
        expect(getPublicBuiltinCharacterIds()).toEqual(['preset-sully-v2']);
        expect(isPublicBuiltinCharacterId('preset-sully-v2')).toBe(true);
        expect(isPublicBuiltinCharacterId('user-imported-card')).toBe(false);
    });
});
