/**
 * INTERACTION_FOOD_UX_HOTFIX_PHASE2 · Transfer Return Preflight Tests
 * 验证已存在的「收下/退回」语义（Phase 1 transferWallet + 既有 TransferCard UI）：
 *  - pending → accepted：transfer-in:<messageId> 一次性入账
 *  - pending → returned：钱包 mutation = 0，状态持久，后续不能再收下
 *  - 重复退回幂等；reopen/restore 状态持久、零 ledger side effect、零 API 调用
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getAvailableBalance, initializeWallet, listLedgerEntries } from './playerWallet';
import { acceptIncomingTransfer } from './transferWallet';
import type { Message } from '../types';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

async function makePendingTransfer(amount = '520'): Promise<Message> {
    const id = await DB.saveMessage({
        charId: 'c1', role: 'assistant', type: 'transfer', content: '[转账]',
        metadata: { amount, status: 'pending' }, timestamp: Date.now(),
    } as any);
    const messages: Message[] = await DB.getMessagesByCharId('c1');
    return messages.find(m => m.id === id)!;
}

async function freshCopy(msg: Message): Promise<Message> {
    const messages = await DB.getMessagesByCharId('c1');
    return messages.find(m => m.id === msg.id)!;
}

describe('transferReturn · preflight（UI 双按钮背后的事务语义）', () => {
    it('pending → accepted：income 一次性入账（transfer-in:<messageId>）', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('520');
        const result = await acceptIncomingTransfer(msg, 'accepted', 7000);
        expect(result.status).toBe('ok');
        expect(result.incomeEntry).toMatchObject({ eventKey: `transfer-in:${msg.id}`, amount: 520 });
        expect(await getAvailableBalance()).toBe(620);
    });

    it('pending → returned：钱包 mutation = 0，无任何 income/expense', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('520');
        const result = await acceptIncomingTransfer(msg, 'returned', 7100);
        expect(result.status).toBe('ok');
        expect(result.incomeEntry).toBeNull();
        expect(await listLedgerEntries()).toHaveLength(0);
        expect(await getAvailableBalance()).toBe(100);
    });

    it('returned 之后不能再收下（状态持久，后续 accept → already_done 零入账）', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('520');
        await acceptIncomingTransfer(msg, 'returned', 7200);
        const later = await freshCopy(msg);
        const attempt = await acceptIncomingTransfer(later, 'accepted', 7300);
        expect(attempt.status).toBe('already_done');
        expect(attempt.incomeEntry).toBeNull();
        expect(await getAvailableBalance()).toBe(100);
    });
});

describe('transferReturn · 幂等/持久/零副作用', () => {
    it('重复退回幂等：不产生第二张回执、零 ledger', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('520');
        await acceptIncomingTransfer(msg, 'returned', 7400);
        const second = await acceptIncomingTransfer(await freshCopy(msg), 'returned', 7500);
        expect(second.status).toBe('already_done');
        const messages = await DB.getMessagesByCharId('c1');
        expect(messages.filter(m => m.type === 'transfer' && m.metadata?.receipt === 'returned')).toHaveLength(1);
        expect(await listLedgerEntries()).toHaveLength(0);
    });

    it('退回状态持久：reopen（重读消息）后状态不变、pending 守卫仍生效', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('520');
        await acceptIncomingTransfer(msg, 'returned', 7600);
        await DB.getMessagesByCharId('c1', true);
        await DB.getRecentMessagesByCharId('c1', 200);
        const reopened = await freshCopy(msg);
        expect(reopened.metadata?.status).toBe('returned');
        expect((await acceptIncomingTransfer(reopened, 'accepted', 7700)).status).toBe('already_done');
        expect(await getAvailableBalance()).toBe(100);
    });

    it('退回后角色侧上下文：回执卡（receipt=returned）存在于历史（零额外 API）', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('88');
        await acceptIncomingTransfer(msg, 'returned', 7800);
        const messages = await DB.getMessagesByCharId('c1');
        const receipt = messages.find(m => m.type === 'transfer' && m.metadata?.receipt === 'returned');
        expect(receipt).toBeTruthy();
        expect(receipt!.metadata).toMatchObject({ receipt: 'returned', amount: '88', ref: msg.id });
        expect(receipt!.role).toBe('user');
    });

    it('restore 后状态持久：零 ledger side effect、不重复退回', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('66');
        await acceptIncomingTransfer(msg, 'returned', 7900);
        const backup = await DB.exportFullData();
        const ledgerCount = (await listLedgerEntries()).length;
        await DB.deleteDB();
        await DB.importFullData(backup as any);
        const restored = await freshCopy(msg);
        expect(restored.metadata?.status).toBe('returned');
        expect((await listLedgerEntries()).length).toBe(ledgerCount);
        expect((await acceptIncomingTransfer(restored, 'returned', 8000)).status).toBe('already_done');
        expect((await acceptIncomingTransfer(restored, 'accepted', 8100)).status).toBe('already_done');
        expect(await getAvailableBalance()).toBe(100);
    });

    it('acceptIncomingTransfer 不发起任何 Chat API 调用（无 completeChat 依赖）', async () => {
        await initializeWallet(100);
        const msg = await makePendingTransfer('520');
        const fs = await import('node:fs');
        const source = fs.readFileSync(new URL('./transferWallet.ts', import.meta.url), 'utf8');
        expect(source.includes('completeChat')).toBe(false);
        expect(source.includes('chatCompletionClient')).toBe(false);
        const result = await acceptIncomingTransfer(msg, 'returned', 8200);
        expect(result.status).toBe('ok');
    });
});

