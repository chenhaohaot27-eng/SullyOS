import type { APIConfig, CharacterProfile } from '../types';

export const normalizeCharacterIdentityName = (value: string): string => value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．]/g, '.')
    .toLocaleLowerCase('en-US');

const identityNames = (character: Pick<CharacterProfile, 'name' | 'aliases'>): string[] => [
    character.name,
    ...(character.aliases || []),
];

export function characterMatchesIdentityName(
    character: Pick<CharacterProfile, 'name' | 'aliases'>,
    name: string,
): boolean {
    const normalized = normalizeCharacterIdentityName(name);
    return !!normalized && identityNames(character).some(candidate => normalizeCharacterIdentityName(candidate) === normalized);
}

/** Generic lookup only. It never creates, promotes, mutates, merges or deletes profiles. */
export function findCharacterByIdentityName(
    characters: CharacterProfile[],
    name: string,
): CharacterProfile | undefined {
    return characters.find(character => characterMatchesIdentityName(character, name));
}

export function resolveCharacterChatApiConfig(globalConfig: APIConfig, character?: CharacterProfile): APIConfig {
    const override = character?.chatApiOverride;
    if (!override) return globalConfig;
    const definedOverride = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined));
    return { ...globalConfig, ...definedOverride };
}
