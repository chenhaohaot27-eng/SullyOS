/**
 * GiftChatCard — 聊天里的礼物卡气泡（Phase 3）。
 *
 * 数据原则：卡片只持有 metadata.gift 快照（giftId + 极简 fallback），reaction/status
 * 通过 giftId 异步回读 GiftRecord（唯一真相源）——角色回应落库后卡片重新渲染即显示新状态。
 * 图片复用 blobref 管线（useBlobRefUrl + ChatPhotoViewer），不复制 Blob、不写库。
 * 刻意保持轻量：不是礼物详情页，只做「是什么礼物 + 谁送的 + 现在怎么样了」。
 */

import React, { useEffect, useState } from 'react';
import type { Message } from '../../types';
import { useBlobRefUrl } from '../../utils/blobRef';
import { getGiftRecord } from '../../utils/giftStore';
import type { GiftRecord } from '../../utils/giftTypes';
import { GIFT_SEND_PENDING_STALE_MS, retryCharacterGiftImage } from '../../utils/giftCharacterSend';
import ChatPhotoViewer from './ChatPhotoViewer';

type CommonLayout = (node: React.ReactNode, extra?: any) => React.ReactNode;

const ACCEPTANCE_LABEL: Record<string, string> = {
    accepted: '已收下',
    returned: '已退回',
    rejected: '拒收了',
};

const GiftChatCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: CommonLayout;
    selectionMode?: boolean;
}> = ({ m, isUser, charName, commonLayout, selectionMode }) => {
    const snapshot = (m.metadata?.gift || {}) as {
        giftId?: string;
        direction?: string;
        name?: string;
        description?: string;
        note?: string;
        imageRef?: string;
    };
    const [record, setRecord] = useState<GiftRecord | null>(null);
    const [viewerUrl, setViewerUrl] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);
    const sentByUser = snapshot.direction !== 'character_to_user';
    const imageUrl = useBlobRefUrl(record?.image.imageRef || snapshot.imageRef || '');

    // 动态回读 GiftRecord：reaction 落库后（角色回应完成）卡片自动显示新状态。
    useEffect(() => {
        let alive = true;
        if (!snapshot.giftId) return;
        getGiftRecord(snapshot.giftId).then(r => { if (alive) setRecord(r); }).catch(() => {});
        return () => { alive = false; };
    }, [snapshot.giftId]);

    const name = record?.gift.name || snapshot.name || '一份礼物';
    const reaction = record?.reaction;
    // 角色生成的礼物图有状态机；长期 pending 判「生成中断」（刷新遗留），可手动重试。
    const charImage = record && record.sender.type === 'character' ? record.image : null;
    const imageStatus = charImage?.status;
    const stalePending = imageStatus === 'pending'
        && Date.now() - (record?.updatedAt || 0) > GIFT_SEND_PENDING_STALE_MS;
    const showImage = !!record?.image.imageRef && (imageStatus === 'ready' || !charImage);

    const handleRetry = async () => {
        if (!snapshot.giftId || !record) return;
        setRetrying(true);
        try {
            const res = await retryCharacterGiftImage(snapshot.giftId, { char: { id: record.charId, name: charName } as never });
            if (res.gift) setRecord(res.gift);
        } finally {
            setRetrying(false);
        }
    };

    return commonLayout(
        <div className={`w-60 rounded-2xl overflow-hidden shadow-sm border ${isUser ? 'bg-rose-50/80 dark:bg-rose-500/10 border-rose-100 dark:border-rose-500/20' : 'bg-indigo-50/80 dark:bg-indigo-500/10 border-indigo-100 dark:border-indigo-500/20'} ${selectionMode ? '' : ''}`}>
            {/* 卡头 */}
            <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-1.5">
                <span className="text-base leading-none">🎁</span>
                <span className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">{name}</span>
            </div>
            {/* 图片区：ready 显示图片（复用 blobref，点击全屏）；生成中/失败/中断显示对应状态 */}
            {charImage && imageStatus === 'pending' && (
                <div className="w-full aspect-video bg-slate-100 dark:bg-slate-800 flex flex-col items-center justify-center gap-1.5">
                    <div className="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-indigo-400 animate-spin" />
                    <span className="text-[10px] text-slate-400">{stalePending ? '生成中断' : '正在准备礼物图片…'}</span>
                </div>
            )}
            {charImage && (imageStatus === 'failed' || stalePending) && (
                <div className="w-full aspect-video bg-slate-100 dark:bg-slate-800 flex flex-col items-center justify-center gap-1.5 px-3 text-center">
                    <span className="text-[10px] text-slate-400">图片生成失败</span>
                    <button
                        type="button"
                        disabled={retrying}
                        onClick={handleRetry}
                        className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-indigo-500 text-white disabled:opacity-50 active:scale-95 transition"
                    >
                        {retrying ? '重新生成中…' : '重新生成'}
                    </button>
                </div>
            )}
            {showImage && (record?.image.imageRef || snapshot.imageRef) && (
                <button
                    type="button"
                    className="w-full aspect-video bg-slate-100 dark:bg-slate-800 overflow-hidden active:opacity-90 transition-opacity"
                    onClick={() => imageUrl && setViewerUrl(imageUrl)}
                    aria-label="查看礼物图片"
                >
                    {imageUrl
                        ? <img src={imageUrl} className="w-full h-full object-cover" alt="礼物图片" loading="lazy" />
                        : <div className="w-full h-full animate-pulse" />}
                </button>
            )}
            {/* 正文 */}
            <div className="px-3 py-2 space-y-1">
                <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    {sentByUser ? `你送给${charName}` : `${charName}送给你`}
                </div>
                {(snapshot.description || record?.gift.description) && (
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2 break-words">
                        {record?.gift.description || snapshot.description}
                    </p>
                )}
                {(snapshot.note || record?.gift.note) && (
                    <p className="text-[11px] text-slate-400 dark:text-slate-500 line-clamp-2 break-words">
                        「{record?.gift.note || snapshot.note}」
                    </p>
                )}
                {/* reaction 状态：来自 GiftRecord；没有 reaction 就不显示，绝不伪造 */}
                {reaction?.acceptance && (
                    <div className="pt-1.5 mt-0.5 border-t border-black/5 dark:border-white/10 flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${reaction.acceptance === 'accepted' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300' : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>
                            {ACCEPTANCE_LABEL[reaction.acceptance] || reaction.acceptance}
                        </span>
                        {reaction.disposition && (
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{reaction.disposition}</span>
                        )}
                    </div>
                )}
            </div>
            {viewerUrl && (
                <ChatPhotoViewer
                    content={record?.image.imageRef || snapshot.imageRef || ''}
                    displayUrl={viewerUrl}
                    caption={name}
                    onClose={() => setViewerUrl(null)}
                />
            )}
        </div>,
    );
};

export default GiftChatCard;
