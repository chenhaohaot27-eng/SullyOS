import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { getAvailableBalance, initializeWallet, listLedgerEntries } from './playerWallet';
import {
    acceptIncomingTransfer, refundRejectedTransfer, sendTransferFromWallet,
} from './transferWallet';
import type { Message } from '../types';

beforeEach(async () => { await DB.deleteDB(); });
afterEach(() => vi.restoreAllMocks());

describe('transferWallet · 玩家→角色发送', () => {
    it('钱包未启用 → 拒绝且消息不落库', async () => {
        await expect(sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 10, now: 1000 }))
            .rejects.toMatchObject({ code: 'not_initialized' });
        expect((await DB.getMessagesByCharId('c1')).filter(m => m.type === 'transfer')).toHaveLength(0);
    });
    it('余额充足 → 消息 + expense 同生，余额减少', async () => {
        await initializeWallet(100);
        const result = await sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 30, now: 2000 });
        expect(result.status).toBe('ok');
        expect(result.entry).toMatchObject({ direction: 'expense', source: 'transfer', amount: 30, eventKey: `transfer-out:${result.messageId}`, referenceId: String(result.messageId) });
        const msgs = (await DB.getMessagesByCharId('c1')).filter(m => m.type === 'transfer');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].metadata).toMatchObject({ amount: '30', status: 'pending' });
        expect(await getAvailableBalance()).toBe(70);
    });
    it('余额不足 → 拒绝，消息不落库、无 expense', async () => {
        await initializeWallet(29.99);
        await expect(sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 30, now: 9000 }))
            .rejects.toMatchObject({ code: 'insufficient_balance' });
        expect((await DB.getMessagesByCharId('c1')).filter(m => m.type === 'transfer')).toHaveLength(0);
        expect(await listLedgerEntries()).toHaveLength(0);
        expect(await getAvailableBalance()).toBe(29.99);
    });
    it('恰好转光 → 余额 0', async () => {
        await initializeWallet(50);
        await sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 50, now: 4000 });
        expect(await getAvailableBalance()).toBe(0);
    });
    it('双击（2 秒窗口内同 charId+金额）→ 第二次拒绝，无双扣', async () => {
        await initializeWallet(100);
        const first = await sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 20, now: 5000 });
        expect(first.status).toBe('ok');
        await expect(sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 20, now: 5500 }))
            .rejects.toMatchObject({ code: 'duplicate_click' });
        expect(await getAvailableBalance()).toBe(80);
        expect((await listLedgerEntries()).filter(e => e.source === 'transfer')).toHaveLength(1);
    });
});

describe('transferWallet · 角色退回退款', () => {
    it('钱包时代转账被退回 → 退款一次；重复退回不重复退款', async () => {
        await initializeWallet(100);
        const { messageId } = await sendTransferFromWallet({ charId: 'c1', charName: '小星', amount: 40, now: 6000 });
        expect(await getAvailableBalance()).toBe(60);
        const first = await refundRejectedTransfer(messageId, 6100);
        expect(first.refunded).toBe(true);
        expect(await getAvailableBalance()).toBe(100);
        const second = await refundRejectedTransfer(messageId, 6200);
        expect(second.refunded).toBe(false);
        expect(second.reason).toBe('already_refunded');
        expect(await getAvailableBalance()).toBe(100);
        const refunds = (await listLedgerEntries()).filter(e => e.eventKey === `transfer-refund:${messageId}`);
        expect(refunds).toHaveLength(1);
        expect(refunds[0]).toMatchObject({ direction: 'income', source: 'transfer', amount: 40 });
    });
    it('历史转账（无 transfer-out expense）退回 → 零动作，不凭空造钱', async () => {
        await initializeWallet(100);
        const legacyMsgId = await DB.saveMessage({
            charId: 'c1', role: 'user', type: 'transfer', content: '[转账]',
            metadata: { amount: '999', status: 'pending' }, timestamp: 1,
        } as any);
        const result = await refundRejectedTransfer(legacyMsgId);
        expect(result.refunded).toBe(false);
        expect(result.reason).toBe('no_expense');
        expect(await getAvailableBalance()).toBe(100);
    });
});

describe('transferWallet · 角色→玩家收款', () => {
    async function makeIncomingTransfer(amount = '520'): Promise<Message> {
        const id = await DB.saveMessage({
            charId: 'c1', role: 'assistant', type: 'transfer', content: '[转账]',
            metadata: { amount, status: 'pending' }, timestamp: Date.now(),
        } as any);
        const msgs = await DB.getMessagesByCharId('c1');
        return msgs.find(m => m.id === id)!;
    }

    it('收下 → income 一次；重复收下不重复入账', async () => {
        await initializeWallet(100);
        const msg = await makeIncomingTransfer('520');
        const first = await acceptIncomingTransfer(msg, 'accepted', 7000);
        expect(first.status).toBe('ok');
        expect(first.incomeEntry).toMatchObject({ direction: 'income', source: 'transfer', amount: 520, eventKey: `transfer-in:${msg.id}` });
        expect(await getAvailableBalance()).toBe(620);
        const second = await acceptIncomingTransfer(msg, 'accepted', 7100);
        expect(second.status).toBe('already_done');
        expect(await getAvailableBalance()).toBe(620);
        expect((await listLedgerEntries()).filter(e => e.eventKey === `transfer-in:${msg.id}`)).toHaveLength(1);
    });
    it('退回 → 不产生 income', async () => {
        await initializeWallet(100);
        const msg = await makeIncomingTransfer('520');
        const result = await acceptIncomingTransfer(msg, 'returned', 7200);
        expect(result.status).toBe('ok');
        expect(result.incomeEntry).toBeNull();
        expect(await getAvailableBalance()).toBe(100);
    });
    it('钱包未启用 → 纯消息行为（状态+回执），无 ledger', async () => {
        const msg = await makeIncomingTransfer('520');
        const result = await acceptIncomingTransfer(msg, 'accepted', 7300);
        expect(result.status).toBe('ok');
        expect(result.incomeEntry).toBeNull();
        expect(await listLedgerEntries()).toHaveLength(0);
        const msgs = await DB.getMessagesByCharId('c1');
        expect(msgs.some(m => m.metadata?.receipt === 'accepted')).toBe(true);
    });
    it('只读路径（重开聊天/读消息）不产生任何 ledger', async () => {
        await initializeWallet(100);
        await makeIncomingTransfer('520');
        await DB.getMessagesByCharId('c1', true);
        await DB.getRecentMessagesByCharId('c1', 200);
        expect(await listLedgerEntries()).toHaveLength(0);
    });
});

