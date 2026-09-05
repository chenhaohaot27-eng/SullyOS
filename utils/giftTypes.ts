/**
 * giftTypes — 礼物 GiftRecord 的独立类型定义（Phase 1 数据底座）。
 *
 * 刻意不放进全局 types.ts（当前该文件有未提交 WIP）；giftStore.ts 直接从这里引用。
 * 后续 WIP 稳定后再决定是否在 types.ts re-export。
 *
 * 约定：
 *  - GiftRecord 是礼物事件的唯一真相源；Chat 礼物卡只是它的投影（只存 giftId）。
 *  - image.imageRef 只接受 `blobref:<id>` 令牌；本阶段 Store 层把它当普通字符串，
 *    不解析、不调用 blob/vision/生图（后续 Phase 接入）。
 *  - affinityImpact 是语义事件记录（Phase 0 审计：仓库没有统一主关系值，禁止数值好感）。
 */

export type GiftPartyType = 'user' | 'character';

export interface GiftPartySnapshot {
    type: GiftPartyType;
    id: string;
    nameSnapshot: string;
}

export type GiftSource =
    | 'gift_app'
    | 'chat_action';

export type GiftImageOrigin =
    | 'camera'
    | 'gallery'
    | 'ai_generated'
    | 'none';

export type GiftImageStatus =
    | 'none'
    | 'pending'
    | 'ready'
    | 'failed'
    | 'interrupted';

export type GiftStatus =
    | 'pending'
    | 'delivered'
    | 'failed'
    | 'returned'
    | 'rejected'
    | 'cancelled'
    | 'interrupted';

export type GiftAcceptance =
    | 'accepted'
    | 'returned'
    | 'rejected';

/** 语义好感影响记录（非数值，禁止 affinityDelta/affinityAfter 等字段）。 */
export type GiftAffinityImpact =
    | 'strong_positive'
    | 'positive'
    | 'neutral'
    | 'negative'
    | 'strong_negative';

export type GiftMemoryImportance =
    | 'trivial'
    | 'normal'
    | 'meaningful'
    | 'highly_meaningful';

export interface GiftImageData {
    /** `blobref:<id>` 令牌；一张礼物图片只存一个 Blob，Gift 卡与 GiftRecord 同源。 */
    imageRef?: string;
    origin: GiftImageOrigin;
    status: GiftImageStatus;
    /** ai_generated 时保留 prompt 供手动重试。 */
    prompt?: string;
    /** 上传图片的 vision 识别结果缓存（只识别一次；vision 未启用时留空）。 */
    visualSummary?: string;
    /** 失败/中断原因（写库前须脱敏，可展示给玩家）。 */
    failureReason?: string;
}

export interface GiftReactionData {
    review?: string;
    disposition?: string;
    acceptance?: GiftAcceptance;
}

export interface GiftEffectData {
    affinityImpact?: GiftAffinityImpact;
    moodImpact?: string[];
    reason?: string;
    appliedAt?: number;
}

export interface GiftMemoryData {
    importance?: GiftMemoryImportance;
    summary?: string;
    status?: 'none' | 'candidate' | 'committed' | 'failed';
    memoryId?: string;
}

export interface GiftChatLinks {
    triggerMessageId?: string;
    cardMessageId?: string;
    reactionMessageIds?: string[];
}

export interface GiftRecord {
    schemaVersion: 1;

    id: string;

    /**
     * 持久化幂等键：同一个逻辑礼物副作用永远只产生一条 GiftRecord。
     * 由程序生成（方向 + charId + 触发消息/意图指纹），模型不参与；
     * DB 侧对应 gift_records.eventKey UNIQUE index 作为最终防线。
     */
    eventKey: string;

    charId: string;

    sender: GiftPartySnapshot;
    recipient: GiftPartySnapshot;

    source: GiftSource;

    gift: {
        name: string;
        description?: string;
        note?: string;
    };

    image: GiftImageData;

    reaction?: GiftReactionData;
    effects?: GiftEffectData;
    memory?: GiftMemoryData;
    chat?: GiftChatLinks;

    status: GiftStatus;

    createdAt: number;
    deliveredAt?: number;
    updatedAt: number;
}
