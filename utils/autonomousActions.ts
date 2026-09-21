/**
 * 角色高成本自主行为机会窗口（INTERACTION_FOOD_UX_HOTFIX_PHASE1）
 * ═════════════════════════════════════════════════════════════════
 * 统一的「autonomous high-cost action opportunity」：GIFT_SEND / FOOD_ORDER /
 * 角色→玩家 TRANSFER 三选一（或全不选），一轮最多 1 个高成本动作。
 *
 * 设计（0 额外 Chat 调用）：
 *  - 请求端：buildChatRequestPayload 在原本那次 completion 的 system prompt 里
 *    预计算并注入一小段机会提示（markTurnOpportunity 留下快照）。
 *  - 响应端：chatParser（TRANSFER 落卡）与 applyAssistantPostProcessing
 *    （GIFT_SEND / FOOD_ORDER 执行）用同一份快照 + 显式请求检测 + 单轮 claim 门控。
 *  - 快照不存在的路径（worker fire pack / 旧测试 / 非聊天场景）= legacy 放行，
 *    行为与 Hotfix 前完全一致，不引入新门控。
 *
 * 本文件刻意只依赖 types + db，避免 chatPrompts 循环链；
 * gift/food 的 cooldown 检查由调用方（chatRequestPayload）注入。
 */

import type { Message } from '../types';
import { DB } from './db';

/** 普通聊天轮次的机会窗口比例（≈8% 的轮次「允许模型自主考虑」）。 */
export const AUTONOMOUS_OPPORTUNITY_BASE_RATE = 0.08;
/** 饭点/夜间且 Food 候选可用时的机会比例（≈12%）。 */
export const AUTONOMOUS_OPPORTUNITY_MEAL_RATE = 0.12;
/** 角色→玩家自主转账 cooldown（24h；只限制自主，不限制显式请求）。 */
export const AUTONOMOUS_TRANSFER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** 机会快照有效期（请求→响应的正常间隔；过期视为未知→legacy）。 */
const TURN_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
/** 单轮高成本动作 claim 占用时长（略大于快照 TTL，覆盖同轮多条副作用）。 */
const TURN_CLAIM_TTL_MS = 20 * 60 * 1000;

export type HighCostActionKind = 'gift' | 'food' | 'transfer';

export interface AutonomousCandidates {
    gift: boolean;
    food: boolean;
    transfer: boolean;
}

export interface AutonomousOpportunitySnapshot {
    open: boolean;
    /** open=false 的原因：explicit（本轮有显式请求）/ roll（概率未命中）/ no_candidates。 */
    reason: 'explicit' | 'roll' | 'no_candidates' | 'ok';
    candidates: AutonomousCandidates;
    mealWindow: boolean;
    ts: number;
}

// ═══════════════ 饭点窗口（本地时间） ═══════════════

/**
 * 午间 11:00–14:00 / 晚间 17:00–21:00 / 深夜 21:00–24:00。
 * 只影响 Food 候选的合理性与机会概率，绝不自动点餐。
 */
export function isMealWindow(date: Date = new Date()): boolean {
    const hour = date.getHours();
    return (hour >= 11 && hour < 14) || (hour >= 17 && hour < 24);
}

// ═══════════════ 显式请求检测（保守正则；人设判断交给模型） ═══════════════

// 与 utils/foodCharacterOrder.ts 的 isExplicitFoodRequest 保持同一语义（本地复制避免循环 import）。
const EXPLICIT_FOOD_RE = /(给我|帮我|替我|想|要|想吃|想吃点|点|订|叫|来)(点|一些|些|份|个)?.{0,8}(外卖|吃|喝|餐|饭|奶茶|咖啡|汉堡|披萨|烧烤|火锅|米粉|面)|(点|订|叫)(一|几)?.{0,6}(外卖|奶茶|咖啡|汉堡|披萨|烧烤|火锅|米粉)|(请|麻烦)?(吃|喝)点(东西|什么)/;
const EXPLICIT_GIFT_RE = /(送我|送个|送份|送一份|送我个|送我一份|给我(买|送)|想(要|收)|想要个|想要一份|求).{0,10}(礼物|礼盒|花|礼物盒|present|gift)|送(我)?(礼物|花)|给我(礼物|送礼物)/;
const EXPLICIT_TRANSFER_RE = /(给|向|跟)?我?(转|打|汇)(点|些|个)?(钱|账)|转(账|钱)给(我|俺)|给我(转|打|汇)(点|些)?(钱|账)|(借|资助)我?点?钱/;

export interface ExplicitHighCostRequest {
    gift: boolean;
    food: boolean;
    transfer: boolean;
}

export function detectExplicitHighCostRequest(content: string | undefined | null): ExplicitHighCostRequest {
    const text = typeof content === 'string' ? content : '';
    return {
        gift: EXPLICIT_GIFT_RE.test(text),
        food: EXPLICIT_FOOD_RE.test(text),
        transfer: EXPLICIT_TRANSFER_RE.test(text),
    };
}

// ═══════════════ Transfer 24h cooldown（从聊天消息推导，无需新 store） ═══════════════

/** 24h 内角色是否给玩家发过转账（含旧记录：保守计数，防高频）。 */
export async function hasRecentAutonomousTransfer(charId: string, now = Date.now(), withinMs = AUTONOMOUS_TRANSFER_COOLDOWN_MS): Promise<boolean> {
    try {
        const messages = await DB.getRecentMessagesByCharId(charId, 200, true);
        return messages.some(message =>
            message.role === 'assistant'
            && message.type === 'transfer'
            && (message.timestamp ?? 0) > now - withinMs,
        );
    } catch {
        return false;
    }
}

// ═══════════════ 机会评估（可注入 RNG，纯本地 0 AI） ═══════════════

export interface EvaluateOpportunityInput {
    charId: string;
    /** 本轮最后一条用户消息文本（显式请求检测用）。 */
    lastUserText?: string | undefined;
    now?: number;
    /** 默认 Math.random；测试注入确定性 RNG。 */
    rng?: () => number;
    /** 各动作 cooldown 是否命中（true = 冷却中，剔除候选）。由调用方注入避免循环依赖。 */
    cooldownHit?: Partial<Record<HighCostActionKind, boolean>>;
    /** 直接跳过评估（例如 worker fire 路径：不注入不标记，维持现状）。 */
    skip?: boolean;
}

export async function evaluateAutonomousOpportunity(input: EvaluateOpportunityInput): Promise<AutonomousOpportunitySnapshot> {
    const now = input.now ?? Date.now();
    const snapshot: AutonomousOpportunitySnapshot = {
        open: false, reason: 'roll', candidates: { gift: false, food: false, transfer: false }, mealWindow: isMealWindow(new Date(now)), ts: now,
    };
    if (input.skip) { snapshot.reason = 'no_candidates'; return snapshot; }
    const explicit = detectExplicitHighCostRequest(input.lastUserText);
    if (explicit.gift || explicit.food || explicit.transfer) {
        // 显式请求优先：本轮不再开放额外自主机会，避免同轮堆两个高成本动作。
        snapshot.reason = 'explicit';
        return snapshot;
    }
    const transferCooling = (await hasRecentAutonomousTransfer(input.charId, now)) || !!input.cooldownHit?.transfer;
    const candidates: AutonomousCandidates = {
        gift: !input.cooldownHit?.gift,
        food: !input.cooldownHit?.food,
        transfer: !transferCooling,
    };
    snapshot.candidates = candidates;
    if (!candidates.gift && !candidates.food && !candidates.transfer) {
        snapshot.reason = 'no_candidates';
        return snapshot;
    }
    const rate = snapshot.mealWindow && candidates.food ? AUTONOMOUS_OPPORTUNITY_MEAL_RATE : AUTONOMOUS_OPPORTUNITY_BASE_RATE;
    const rng = input.rng ?? Math.random;
    snapshot.open = rng() < rate;
    snapshot.reason = snapshot.open ? 'ok' : 'roll';
    return snapshot;
}

// ═══════════════ 机会快照 + 单轮 claim（响应端门控） ═══════════════

const turnSnapshots = new Map<string, AutonomousOpportunitySnapshot>();
const turnClaims = new Map<string, { action: HighCostActionKind; explicit: boolean; ts: number }>();

/** 请求端标记本轮机会快照（closed 也标记——响应端需要知道"本轮关闭"）。 */
export function markTurnOpportunity(charId: string, snapshot: AutonomousOpportunitySnapshot): void {
    turnSnapshots.set(charId, snapshot);
}

/** 响应端读取本轮快照；过期或不存在返回 null（= legacy 放行）。 */
export function getTurnOpportunity(charId: string, now = Date.now()): AutonomousOpportunitySnapshot | null {
    const snapshot = turnSnapshots.get(charId);
    if (!snapshot || now - snapshot.ts > TURN_SNAPSHOT_TTL_MS) return null;
    return snapshot;
}

export interface HighCostGateResult {
    allowed: boolean;
    /** legacy=快照不存在（维持 Hotfix 前行为）；explicit=显式请求；autonomous=机会窗口；denied=被门控。 */
    mode: 'legacy' | 'explicit' | 'autonomous' | 'denied';
}

/**
 * 单轮高成本动作门控（程序层兜底，不信任 prompt）：
 *  - 快照不存在 → legacy 放行（worker fire / 旧路径 / 测试环境）。
 *  - 显式请求 → claim(explicit)，可覆盖本轮已发生的自主 claim（显式优先）。
 *  - 机会开放且该候选可用 → claim(autonomous)。
 *  - 其余（机会关闭 / 候选冷却 / 已有 claim）→ denied。
 * 同 action 同 mode 的重复 claim 幂等（重放安全）。
 */
export function gateAssistantHighCostAction(input: {
    charId: string;
    action: HighCostActionKind;
    explicit: boolean;
    now?: number;
}): HighCostGateResult {
    const now = input.now ?? Date.now();
    const snapshot = getTurnOpportunity(input.charId, now);
    if (!snapshot) return { allowed: true, mode: 'legacy' };
    const existing = turnClaims.get(input.charId);
    const existingAlive = existing && now - existing.ts <= TURN_CLAIM_TTL_MS;
    if (input.explicit) {
        if (existingAlive && existing.explicit && existing.action !== input.action) return { allowed: false, mode: 'denied' };
        turnClaims.set(input.charId, { action: input.action, explicit: true, ts: now });
        return { allowed: true, mode: 'explicit' };
    }
    if (existingAlive) {
        if (existing.action === input.action && !existing.explicit) return { allowed: true, mode: 'autonomous' }; // 幂等重放
        return { allowed: false, mode: 'denied' };
    }
    if (snapshot.open && snapshot.candidates[input.action]) {
        turnClaims.set(input.charId, { action: input.action, explicit: false, ts: now });
        return { allowed: true, mode: 'autonomous' };
    }
    return { allowed: false, mode: 'denied' };
}

export function resetAutonomousStateForTests(): void {
    turnSnapshots.clear();
    turnClaims.clear();
}

// ═══════════════ 机会提示文案（注入正常那次 completion 的 system prompt） ═══════════════

const CANDIDATE_LABEL: Record<HighCostActionKind, string> = {
    gift: '送一份合适的礼物（GIFT_SEND）',
    food: '给对方点一份外卖（FOOD_ORDER）',
    transfer: '给对方转一笔合理的钱（[[ACTION:TRANSFER|to=user|amount=金额]]）',
};

/**
 * 机会提示：只解除"仅限用户主动要求"的被动限制，绝不强制动作。
 * 模型仍可选择什么都不做；没有自然理由就正常聊天（spec：机会≠触发）。
 */
export function buildAutonomousOpportunityGuide(snapshot: AutonomousOpportunitySnapshot): string {
    if (!snapshot.open) return '';
    const enabled = (Object.keys(CANDIDATE_LABEL) as HighCostActionKind[]).filter(kind => snapshot.candidates[kind]);
    if (enabled.length === 0) return '';
    const lines = enabled.map(kind => `     - ${CANDIDATE_LABEL[kind]}`).join('\n');
    const mealNote = snapshot.candidates.food && snapshot.mealWindow
        ? '\n     - 现在是用餐时段，如果你想给对方点吃的，这在外卖候选里是自然的选择——但这只是让它更合理，不是要求你点。'
        : '';
    return `
   - **自主行为机会（本轮可选，非强制）**: 本轮允许你根据你的性格、职业与财力、你们的关系、最近对话和当前情境，自主考虑是否发起一次现实感较强的主动行为。没有自然理由时正常聊天即可，对方不需要先提出请求，你也不必为了用而用。本轮最多选择其中一项：
${lines}${mealNote}
     - 金额、礼物、餐品由你结合人设与情境自行决定；不符合你人设的选项直接忽略。
     - 什么都不做永远是合法选择，也往往是多数轮次的正确选择。`;
}

/** 读取最后一条用户消息文本（chatParser/aapp 响应端显式检测用）。 */
export async function getLastUserMessageText(charId: string): Promise<string | undefined> {
    try {
        const messages: Message[] = await DB.getRecentMessagesByCharId(charId, 20, true);
        const lastUser = [...messages].reverse().find(message => message.role === 'user');
        return typeof lastUser?.content === 'string' ? lastUser.content : undefined;
    } catch {
        return undefined;
    }
}


