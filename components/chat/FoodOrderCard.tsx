import React, { useEffect, useMemo, useState } from 'react';
import type { Message } from '../../types';
import { useBlobRefUrl } from '../../utils/blobRef';
import { getFoodOrder } from '../../utils/foodOrderStore';
import { deriveFoodOrderStatus, foodOrderEtaMinutes } from '../../utils/foodOrderTimeline';
import { FOOD_ORDER_STATUS_LABEL, type FoodOrderRecord } from '../../utils/foodOrderTypes';
import { sanitizeFoodExternalUrl } from '../../utils/foodImportParser';

type CommonLayout = (node: React.ReactNode, extra?: any) => React.ReactNode;

const FoodOrderCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: CommonLayout;
    selectionMode?: boolean;
}> = ({ m, charName, commonLayout, selectionMode }) => {
    const snapshot = (m.metadata?.foodOrder || {}) as {
        orderId?: string;
        source?: FoodOrderRecord['source'];
        ordererType?: FoodOrderRecord['orderer']['type'];
        ordererName?: string;
        recipientType?: FoodOrderRecord['recipient']['type'];
        recipientName?: string;
        merchantName?: string;
        items?: Array<{ name: string; quantity: number }>;
        total?: number;
        representativeImageRef?: string;
    };
    const [record, setRecord] = useState<FoodOrderRecord | null>(null);
    const [now, setNow] = useState(Date.now());
    const imageRef = record?.items.find(item => item.imageRef)?.imageRef || snapshot.representativeImageRef || '';
    const imageUrl = useBlobRefUrl(imageRef);

    useEffect(() => {
        let alive = true;
        const load = () => snapshot.orderId && getFoodOrder(snapshot.orderId).then(value => { if (alive) setRecord(value); }).catch(() => {});
        void load();
        const timer = window.setInterval(() => { setNow(Date.now()); void load(); }, 60_000);
        return () => { alive = false; window.clearInterval(timer); };
    }, [snapshot.orderId]);

    const status = record ? deriveFoodOrderStatus(record, now) : 'confirmed';
    const eta = record ? foodOrderEtaMinutes(record, now) : null;
    const items = record?.items || snapshot.items || [];
    const merchant = record?.merchantName || snapshot.merchantName || '外卖订单';
    const recipient = record?.recipient.nameSnapshot || snapshot.recipientName || charName;
    const ordererType = record?.orderer.type || snapshot.ordererType || 'user';
    const ordererName = record?.orderer.nameSnapshot || snapshot.ordererName || charName;
    const recipientType = record?.recipient.type || snapshot.recipientType || 'character';
    const source = record?.source || snapshot.source || 'catalog_imported';
    const directionLabel = ordererType === 'character'
        ? recipientType === 'user' ? `${ordererName}给你点的外卖` : `${ordererName}给自己点的外卖`
        : `你给${recipient}点的外卖`;
    const total = record?.total ?? snapshot.total;
    const realUrl = useMemo(
        () => sanitizeFoodExternalUrl(record?.items.find(item => item.originalUrl)?.originalUrl),
        [record],
    );

    return commonLayout(
        <div className={`w-64 rounded-2xl overflow-hidden shadow-sm border bg-orange-50/90 dark:bg-orange-500/10 border-orange-100 dark:border-orange-500/20 ${selectionMode ? 'pointer-events-none' : ''}`}>
            {imageRef && (
                <div className="w-full h-28 bg-orange-100/50 dark:bg-slate-800 overflow-hidden">
                    {imageUrl ? <img src={imageUrl} alt="外卖商品" className="w-full h-full object-cover" loading="lazy" /> : <div className="w-full h-full animate-pulse" />}
                </div>
            )}
            <div className="p-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="font-bold text-sm text-slate-800 dark:text-slate-100 truncate">🍱 {merchant}</div>
                    <span className="shrink-0 text-[10px] font-semibold rounded-full bg-white/80 dark:bg-slate-800 px-2 py-0.5 text-orange-600">{FOOD_ORDER_STATUS_LABEL[status]}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                    <p className="text-[10px] text-slate-500">{directionLabel}</p>
                    {source === 'simulated' && <span className="text-[9px] rounded-full bg-violet-100 dark:bg-violet-500/20 text-violet-600 px-1.5 py-0.5">Lemuria 模拟</span>}
                </div>
                <div className="mt-2 space-y-1">
                    {items.map((item, index) => (
                        <div key={`${item.name}-${index}`} className="flex justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                            <span className="truncate">{item.name}</span><span className="shrink-0">×{item.quantity}</span>
                        </div>
                    ))}
                </div>
                <div className="mt-2 pt-2 border-t border-orange-100 dark:border-white/10 flex justify-between text-[11px]">
                    <span className="text-slate-500">{status === 'delivered' ? '已送达' : eta ? `预计 ${eta} 分钟送达` : FOOD_ORDER_STATUS_LABEL[status]}</span>
                    <span className="font-bold text-orange-600">{total === undefined ? '部分价格未记录' : `¥${total}`}</span>
                </div>
                {realUrl && <a href={realUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[10px] text-slate-500 underline">去原平台查看商品</a>}
            </div>
        </div>,
    );
};

export default FoodOrderCard;
