import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';
import { DB } from './db';
import {
    FORMAL_NPC_DEFINITIONS,
    findCharacterByIdentityName,
    promoteFormalNpcs,
    resolveCharacterChatApiConfig,
} from './formalNpcRegistry';
import { resolveMeetIdentity } from './meetingInvite';
import { MemoryNodeDB } from './memoryPalace/db';
import { stripSensitiveCardFields } from './characterCard';

const globalApi: APIConfig = {
    baseUrl: 'https://global.example.test/v1',
    apiKey: 'global-key',
    model: 'global-model',
    stream: true,
    temperature: 0.7,
};

beforeEach(async () => {
    await DB.deleteDB();
    localStorage.clear();
});

afterEach(async () => {
    await DB.deleteDB();
});

describe('formal NPC registry', () => {
    it('creates exactly four stable formal identities and is idempotent', () => {
        const first = promoteFormalNpcs([]);
        expect(first.characters).toHaveLength(4);
        expect(new Set(first.characters.map(character => character.id)).size).toBe(4);
        expect(first.characters.map(character => character.formalIdentity?.key).sort()).toEqual([
            'amund', 'charles', 'sutherland', 'talia',
        ]);
        expect(first.created).toHaveLength(4);

        const second = promoteFormalNpcs(first.characters);
        expect(second.characters).toHaveLength(4);
        expect(second.created).toEqual([]);
        expect(second.upserts).toEqual([]);
    });

    it('reuses an alias-matched old card and preserves its id, avatar, memories and persona', () => {
        const old = {
            id: 'imported-talia-card',
            name: 'Talia',
            avatar: 'https://assets.example.test/talia.png',
            description: '旧卡说明',
            systemPrompt: '旧卡自定义人设',
            memories: [{ id: 'old-memory', date: '2026-01-01', summary: '旧记忆' }],
        } as CharacterProfile;
        const result = promoteFormalNpcs([old]);
        const talia = result.characters.find(character => character.formalIdentity?.key === 'talia')!;

        expect(result.characters.filter(character => findCharacterByIdentityName([character], '谭灵'))).toHaveLength(1);
        expect(talia.id).toBe('imported-talia-card');
        expect(talia.avatar).toBe(old.avatar);
        expect(talia.memories).toEqual(old.memories);
        expect(talia.systemPrompt).toContain('旧卡自定义人设');
        expect(talia.systemPrompt).toContain('[SullyOS Formal NPC: talia v1]');
    });

    it('keeps only one formal marker when duplicate imported cards already exist', () => {
        const original = promoteFormalNpcs([]).characters;
        const duplicate = {
            ...original.find(character => character.formalIdentity?.key === 'talia')!,
            id: 'imported-duplicate-talia',
        };
        const result = promoteFormalNpcs([...original, duplicate]);
        expect(result.characters.filter(character => character.formalIdentity?.key === 'talia')).toHaveLength(1);
        expect(result.characters.find(character => character.id === duplicate.id)).toBeTruthy();
        expect(result.conflicts).toContainEqual({
            key: 'talia',
            characterIds: ['formal-npc-talia', 'imported-duplicate-talia'],
        });
    });

    it.each([
        ['谭灵', 'talia'], ['Talia', 'talia'], ['talia', 'talia'],
        ['安蒙', 'amund'], ['Amund', 'amund'],
        ['查尔斯', 'charles'], ['Charles', 'charles'],
        ['苏瑟兰先生', 'sutherland'], ['Mr. Sutherland', 'sutherland'], ['Sutherland', 'sutherland'],
    ] as const)('resolves alias %s to formal character %s', (alias, key) => {
        const characters = promoteFormalNpcs([]).characters;
        expect(findCharacterByIdentityName(characters, alias)?.formalIdentity?.key).toBe(key);
        expect(resolveMeetIdentity(alias, characters).id).not.toMatch(/^npc:/);
    });

    it('keeps unknown meeting NPCs ephemeral and out of the character registry', () => {
        const characters = promoteFormalNpcs([]).characters;
        const before = characters.length;
        expect(resolveMeetIdentity('临时码头路人', characters)).toEqual({
            id: 'npc:临时码头路人',
            name: '临时码头路人',
            registered: false,
        });
        expect(characters).toHaveLength(before);
    });

    it('inherits the global chat config and allows a character-level override', () => {
        const character = promoteFormalNpcs([]).characters[0];
        expect(resolveCharacterChatApiConfig(globalApi, character)).toBe(globalApi);
        const overridden = { ...character, chatApiOverride: { model: 'character-model', temperature: 0.4 } };
        expect(resolveCharacterChatApiConfig(globalApi, overridden)).toEqual({
            ...globalApi,
            model: 'character-model',
            temperature: 0.4,
        });
        expect(stripSensitiveCardFields(overridden)).not.toHaveProperty('chatApiOverride');
        expect(stripSensitiveCardFields(overridden)).not.toHaveProperty('formalIdentity');
    });

    it('stores each formal character chat and memory in its own character partition', async () => {
        const characters = promoteFormalNpcs([]).characters;
        await Promise.all(characters.map(character => DB.saveCharacter(character)));
        await Promise.all(characters.map((character, index) => DB.saveMessage({
            charId: character.id,
            role: 'user',
            type: 'text',
            content: `private-${index}`,
            timestamp: index + 1,
        })));
        await Promise.all(characters.map((character, index) => MemoryNodeDB.save({
            id: `memory-${index}`,
            charId: character.id,
            content: `memory-private-${index}`,
            room: 'living_room',
            tags: [],
            importance: 5,
            mood: 'calm',
            embedded: false,
            createdAt: index + 1,
            lastAccessedAt: index + 1,
            accessCount: 0,
        })));

        for (let index = 0; index < characters.length; index++) {
            const character = characters[index];
            expect((await DB.getMessagesByCharId(character.id, true)).map(message => message.content)).toEqual([`private-${index}`]);
            expect((await MemoryNodeDB.getByCharId(character.id)).map(memory => memory.content)).toEqual([`memory-private-${index}`]);
        }
        expect(await DB.getAllCharacters()).toHaveLength(FORMAL_NPC_DEFINITIONS.length);
    });
});
