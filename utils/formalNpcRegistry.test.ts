import { describe, expect, it } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';
import {
    characterMatchesIdentityName,
    findCharacterByIdentityName,
    normalizeCharacterIdentityName,
    resolveCharacterChatApiConfig,
} from './formalNpcRegistry';

const globalApi: APIConfig = {
    baseUrl: 'https://global.example.test/v1',
    apiKey: 'global-key',
    model: 'global-model',
    stream: true,
    temperature: 0.7,
};

const character = (id: string, name: string, aliases: string[] = []): CharacterProfile => ({
    id,
    name,
    aliases,
    avatar: '',
    description: '',
    systemPrompt: '',
    memories: [],
});

describe('generic character identity helpers', () => {
    it('normalizes names and resolves aliases without mutating the registry', () => {
        const characters = [character('custom-1', 'Aster', [' Dr. Aster。 '])];
        const snapshot = structuredClone(characters);

        expect(normalizeCharacterIdentityName('  DR.   ASTER． ')).toBe('dr. aster.');
        expect(characterMatchesIdentityName(characters[0], 'dr. aster.')).toBe(true);
        expect(findCharacterByIdentityName(characters, 'dr. aster.')?.id).toBe('custom-1');
        expect(characters).toEqual(snapshot);
    });

    it('returns undefined safely for an empty registry', () => {
        expect(findCharacterByIdentityName([], 'Nobody')).toBeUndefined();
    });

    it('applies only defined character-level API overrides', () => {
        const configured: CharacterProfile = {
            ...character('custom-2', 'Nova'),
            chatApiOverride: { model: 'character-model', apiKey: undefined },
        };

        expect(resolveCharacterChatApiConfig(globalApi, configured)).toEqual({
            ...globalApi,
            model: 'character-model',
        });
        expect(resolveCharacterChatApiConfig(globalApi)).toBe(globalApi);
    });
});
