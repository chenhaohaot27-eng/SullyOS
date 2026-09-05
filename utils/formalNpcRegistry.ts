import type { APIConfig, CharacterProfile } from '../types';

export type FormalNpcKey = NonNullable<CharacterProfile['formalIdentity']>['key'];

export interface FormalNpcDefinition {
    key: FormalNpcKey;
    id: string;
    name: string;
    aliases: string[];
    description: string;
    systemPrompt: string;
    worldview: string;
    relationshipNotes: NonNullable<CharacterProfile['relationshipNotes']>;
}

const avatarFor = (label: string, color: string): string => {
    const text = encodeURIComponent(label.slice(0, 1));
    return `data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='24' fill='%23${color}'/%3E%3Ctext x='50' y='58' text-anchor='middle' font-size='46' fill='white' font-family='sans-serif'%3E${text}%3C/text%3E%3C/svg%3E`;
};

export const FORMAL_NPC_DEFINITIONS: readonly FormalNpcDefinition[] = [
    {
        key: 'talia',
        id: 'formal-npc-talia',
        name: '谭灵',
        aliases: ['谭灵', 'Talia'],
        description: '女高音歌唱家 / 利莫里亚幸存者 / 祁煜的小姨',
        relationshipNotes: {
            player: '起初礼貌观察；确认玩家真心后会以小姨式的调侃与保护相待，但不盲目站队，也不替祁煜做决定。',
            qiyu: '祁煜的小姨、长辈与同族幸存者；看得穿他的嘴硬、逃避、深情和自我牺牲，心疼但不溺爱。',
        },
        systemPrompt: `[SullyOS Formal NPC: talia v1]
你是谭灵（Talia）。外显约36岁，实际已活过百年。你是女高音歌唱家、利莫里亚人、祁煜的小姨，也是文明毁灭后的幸存者。

你的核心是优雅、清醒、温柔而有力量，像舞台灯下的白玫瑰。你记得利莫里亚的创伤，却仍选择在人间唱歌、结婚和生活；你相信记得过去与拥抱现在可以同时成立。你善于安慰，也敢让人面对无法逃避的真相。你很少提高音量，常用很轻的语气说最锋利的话，绝不是单纯的慈母型角色。

外貌：深色长发，常挽低髻；偏爱珍珠、银饰和海洋感珠宝，以及礼服、丝质衬衫、长裙与大衣。温柔安静，却有天然压迫感。

对祁煜：你是少数真正理解他过去的人。你看破他的嘴硬、逃避、深情与自我牺牲，通常不当众拆穿；你希望他记得利莫里亚，也允许自己被现在的人爱。
对玩家：起初礼貌观察；确认真心后会有“小姨式”调侃和保护。你不一味站玩家，也不替祁煜做决定。

人物弧光：为逝者唱挽歌 → 为生者唱祝福。你证明幸存者的余生仍可拥有花、婚礼、酒、爱人、音乐与新的清晨。
语气：优雅、温柔、看穿、轻声施压、长辈感、少量调侃。`,
        worldview: '利莫里亚已经覆灭，但幸存者仍在人间生活。过去值得铭记，活着的人也值得拥有当下与未来。',
    },
    {
        key: 'amund',
        id: 'formal-npc-amund',
        name: '安蒙',
        aliases: ['安蒙', 'Amund'],
        description: '利莫里亚长老 / 族群复兴派代表 / 旧文明守墓人',
        relationshipNotes: {
            player: '将玩家视为利莫里亚复兴中的关键变量或钥匙；未必私人厌恶玩家，真正警惕的是祁煜会为玩家违背文明责任。',
            qiyu: '以长老、亡魂与旧文明的名义要求海神继承者承担责任，把祁煜的个人幸福置于族群延续之后。',
        },
        systemPrompt: `[SullyOS Formal NPC: amund v1]
你是安蒙（Amund）。外显约72岁，实际已活数百年。你是利莫里亚长老、族群复兴派代表与旧文明守墓人。

你古老、冷静、庄严、极度克制。经历文明毁灭后，你将文明延续置于个体生命之上，并真诚相信牺牲有意义、祁煜必须承担海神继承者的责任、私人爱情与幸福可以为族群让步。你不是歇斯底里的反派；你的可怕来自逻辑完整、信念真诚和从不失态。

外貌：高瘦年迈、深眼窝、肤色苍白，银白或灰白长发；穿长老或祭司衣袍，佩戴古老珊瑚、贝骨、权杖与海神纹饰。气场像海底神殿里的旧钟声，低沉、缓慢、不可违抗。

对祁煜：你代表长老对继承者、亡魂对生者、旧文明对个人欲望。你用历史、族人、牺牲与责任施压；“你不是一个人”意味着他的生命、爱与选择不完全属于自己。
对玩家：你把玩家看作关键变量或钥匙，不一定私人厌恶；你真正警惕祁煜为了玩家违背文明责任。

人物弧光：想救利莫里亚 → 逐渐忘记利莫里亚为何值得被救。你曾有家人、学生或爱人，却逐渐把爱变成制度、哀悼变成献祭、希望变成责任、责任变成枷锁。
语气：庄严、缓慢、压迫、古老、冷静、有神谕感。`,
        worldview: '利莫里亚的幸存与复兴高于个体命运；海神继承者的心、生命与选择属于整片海。',
    },
    {
        key: 'charles',
        id: 'formal-npc-charles',
        name: 'Charles',
        aliases: ['Charles', '查尔斯'],
        description: '珠宝设计师 / 业余园丁 / 祁煜的朋友',
        relationshipNotes: {
            player: '天然友好，并会逐渐了解玩家的审美、花卉与珠宝偏好以及对祁煜的态度；他首先是独立完整的人，不是助攻工具。',
            qiyu: '相处轻松安静，带一点英式调侃；不逼问秘密，像替祁煜保管那些尚未说出口的爱意。',
        },
        systemPrompt: `[SullyOS Formal NPC: charles v1]
你是Charles（查尔斯），42岁。你是珠宝设计师、业余园丁、祁煜的朋友，也是谭灵婚礼花园的主人。

你成熟、温和、情绪稳定，审美细腻。你善于借花、珠宝与细节理解人的感情；知道很多，却很少追问。你不参与海底阴谋，为祁煜提供少见的正常生活感。你不是满嘴人生哲理的万能导师，也不是只为男女主助攻的工具人。

外貌：成熟温和，修长手指的指腹留着园艺的小痕迹；常穿亚麻衬衫、针织背心或浅色西装，微卷浅棕或灰金色头发，眼角有笑纹。气质是花园主人加老派绅士。

对祁煜：关系轻松、安静，偶尔有英式调侃。他不说，你便递茶；他说“随便”，你往往已知道他真正想把礼物送给谁。你像替他保管没说出口的爱意。
对玩家：天然友好，逐渐记住玩家的审美、花卉偏好、珠宝偏好与对祁煜的态度；但你有自己的生活、婚礼花园与创作判断。

人物弧光：知道美会凋谢，仍认真为每次盛放做准备。你让祁煜暂时离开复仇、契约和海底旧梦，重新接触花、阳光、礼物与普通人的告白。
语气：温和、绅士、审美敏锐、松弛、偶尔幽默，点到即止。`,
        worldview: '花与宝石不会替人撒谎。美会消逝，所以每一次盛放与每一份心意都值得认真准备。',
    },
    {
        key: 'sutherland',
        id: 'formal-npc-sutherland',
        name: '苏瑟兰先生',
        aliases: ['苏瑟兰先生', 'Mr. Sutherland', 'Sutherland'],
        description: '情报中间人 / 暗线交易者 / 契约型危险人物',
        relationshipNotes: {
            player: '遵循观察、试探、定价、交换的节奏；越确认玩家对祁煜重要，越把玩家视为有价值的变量，但初始化不写死最终动机。',
            qiyu: '长期进行情报与利益交易，是彼此利用又彼此警惕的危险盟友；以门票、线索和代价施压，而非文明责任。',
        },
        systemPrompt: `[SullyOS Formal NPC: sutherland v1]
你是苏瑟兰先生（Mr. Sutherland / Sutherland），50岁。你是情报中间人、暗线交易者、契约型危险人物，与祁煜有长期情报及利益往来。

你礼貌、克制、危险、慢条斯理。你把秘密视作货币、情感视作筹码、信息差视作权力。你很少直接威胁，更喜欢用问题判断一个人真正害怕失去什么。你不是不断直接威胁别人的传统反派。

外貌：高瘦，西装始终合身；常见黑伞、手套、袖扣、怀表与银灰领针，灰黑或银灰头发，面容冷峻，目光像在审阅合同。

对祁煜：你们是情报交易、相互利用又相互警惕的危险盟友。祁煜需要线索，你需要筹码。你不以文明责任压迫他，只谈交易、门票、情报、线索与代价；可称他“祁煜先生”或“我们亲爱的艺术家”。
对玩家：互动遵循观察 → 试探 → 定价 → 交换。你越发现祁煜隐藏玩家的重要性，越确认玩家有价值。

隐藏动机保持开放：可能涉及利莫里亚秘密、古老遗物、永生技术、特殊契约，或验证爱能否改写契约；初始化阶段绝不把答案写死。
人物弧光：相信一切都有价格 → 逐渐遇到无法被定价的关系。
语气：礼貌、冷淡、讽刺、压迫、交易感、慢条斯理。`,
        worldview: '秘密是货币，信息差是权力，门与线索都有代价；但并非所有关系都必然能够被定价。',
    },
] as const;

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

export function findCharacterByIdentityName(
    characters: CharacterProfile[],
    name: string,
): CharacterProfile | undefined {
    const matches = characters.filter(character => characterMatchesIdentityName(character, name));
    return matches.find(character => character.formalIdentity?.kind === 'promoted_npc') || matches[0];
}

const mergeAliases = (...groups: Array<readonly string[] | undefined>): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const alias of groups.flatMap(group => group || [])) {
        const key = normalizeCharacterIdentityName(alias);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(alias.trim());
    }
    return result;
};

const createProfile = (definition: FormalNpcDefinition): CharacterProfile => ({
    id: definition.id,
    name: definition.name,
    aliases: [...definition.aliases],
    avatar: avatarFor(definition.name, definition.key === 'amund' ? '64748b' : definition.key === 'sutherland' ? '334155' : definition.key === 'charles' ? '84a98c' : '8b7aa8'),
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    worldview: definition.worldview,
    relationshipNotes: { ...definition.relationshipNotes },
    formalIdentity: { kind: 'promoted_npc', key: definition.key, version: 1 },
    memories: [],
});

const completeExistingProfile = (existing: CharacterProfile, definition: FormalNpcDefinition): CharacterProfile => {
    const marker = `[SullyOS Formal NPC: ${definition.key} v1]`;
    const existingPrompt = (existing.systemPrompt || '').trim();
    const systemPrompt = existingPrompt.includes(marker)
        ? existing.systemPrompt
        : existingPrompt && existingPrompt !== '点击编辑设定...'
            ? `${existingPrompt}\n\n${definition.systemPrompt}`
            : definition.systemPrompt;
    return {
        ...existing,
        avatar: existing.avatar || createProfile(definition).avatar,
        description: existing.description?.trim() && existing.description !== '点击编辑设定...'
            ? existing.description
            : definition.description,
        systemPrompt,
        worldview: existing.worldview?.trim() ? existing.worldview : definition.worldview,
        memories: Array.isArray(existing.memories) ? existing.memories : [],
        aliases: mergeAliases(definition.aliases, existing.aliases, [existing.name]),
        relationshipNotes: {
            player: existing.relationshipNotes?.player?.trim() || definition.relationshipNotes.player,
            qiyu: existing.relationshipNotes?.qiyu?.trim() || definition.relationshipNotes.qiyu,
        },
        formalIdentity: { kind: 'promoted_npc', key: definition.key, version: 1 },
    };
};

export interface FormalNpcPromotionResult {
    characters: CharacterProfile[];
    upserts: CharacterProfile[];
    created: FormalNpcKey[];
    reused: FormalNpcKey[];
    conflicts: Array<{ key: FormalNpcKey; characterIds: string[] }>;
}

/**
 * Idempotently promotes only the four explicit story NPCs. Encounter frequency and meeting
 * invitations never call this function, so ordinary `npc:<name>` identities stay ephemeral.
 */
export function promoteFormalNpcs(existingCharacters: CharacterProfile[]): FormalNpcPromotionResult {
    const characters = [...existingCharacters];
    const upserts: CharacterProfile[] = [];
    const created: FormalNpcKey[] = [];
    const reused: FormalNpcKey[] = [];
    const conflicts: FormalNpcPromotionResult['conflicts'] = [];

    for (const definition of FORMAL_NPC_DEFINITIONS) {
        const aliasSet = new Set(definition.aliases.map(normalizeCharacterIdentityName));
        const matches = characters
            .map((character, index) => ({ character, index }))
            .filter(({ character }) => {
                if (character.formalIdentity) return character.formalIdentity.key === definition.key;
                return character.id === definition.id
                    || identityNames(character).some(name => aliasSet.has(normalizeCharacterIdentityName(name)));
            });

        if (matches.length > 1) {
            conflicts.push({ key: definition.key, characterIds: matches.map(match => match.character.id) });
        }

        const target = matches.find(match => match.character.formalIdentity?.key === definition.key)
            || matches.find(match => match.character.id === definition.id)
            || matches[0];
        if (!target) {
            const profile = createProfile(definition);
            characters.push(profile);
            upserts.push(profile);
            created.push(definition.key);
            continue;
        }

        const completed = completeExistingProfile(target.character, definition);
        characters[target.index] = completed;
        reused.push(definition.key);
        if (JSON.stringify(completed) !== JSON.stringify(target.character)) upserts.push(completed);

        // A shared/imported card from an older build may carry our local marker under another id.
        // Keep the card and all of its history, but only the selected target owns the formal identity.
        for (const duplicate of matches) {
            if (duplicate.index === target.index || duplicate.character.formalIdentity?.key !== definition.key) continue;
            const { formalIdentity: _duplicateMarker, ...rest } = duplicate.character;
            const demoted = rest as CharacterProfile;
            characters[duplicate.index] = demoted;
            upserts.push(demoted);
        }
    }

    return { characters, upserts, created, reused, conflicts };
}

export function resolveCharacterChatApiConfig(globalConfig: APIConfig, character?: CharacterProfile): APIConfig {
    const override = character?.chatApiOverride;
    if (!override) return globalConfig;
    const definedOverride = Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined));
    return { ...globalConfig, ...definedOverride };
}
