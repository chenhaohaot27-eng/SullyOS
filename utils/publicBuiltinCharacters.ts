const PUBLIC_BUILTIN_CHARACTER_IDS = new Set<string>([
    'preset-sully-v2',
]);

export const isPublicBuiltinCharacterId = (id: string): boolean => PUBLIC_BUILTIN_CHARACTER_IDS.has(id);

export const getPublicBuiltinCharacterIds = (): readonly string[] => [...PUBLIC_BUILTIN_CHARACTER_IDS];
