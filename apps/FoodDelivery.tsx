import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ArrowLeft,
    CaretRight,
    Heart,
    ImageSquare,
    LinkSimple,
    Minus,
    NotePencil,
    Plus,
    ShoppingCart,
    Trash,
    X,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { deleteBlobRef, putImageBlob, useBlobRefUrl } from '../utils/blobRef';
import {
    createFoodCatalogItem,
    getFoodCatalogItemByFingerprint,
    listFoodCatalogItems,
    toggleFoodFavorite,
} from '../utils/foodCatalogStore';
import { parseFoodImportText, sanitizeFoodExternalUrl } from '../utils/foodImportParser';
import { prepareFoodScreenshotImport } from '../utils/foodScreenshotImport';
import {
    addFoodCartItem,
    calculateFoodCartTotals,
    clearFoodCartAfterOrder,
    removeFoodCartItem,
    setFoodCartNote,
    setFoodCartQuantity,
    snapshotFoodCart,
    type FoodCart,
} from '../utils/foodCart';
import {
    handleFoodOrderDelivery,
    projectFoodOrderToChat,
    triggerFoodOrderReaction,
} from '../utils/foodChatBridge';
import { listFoodOrders, updateFoodOrder } from '../utils/foodOrderStore';
import { createPaidFoodOrder, isRefundableCancelStatus, orderPayer, refundFoodOrder } from '../utils/foodWallet';
import { createFoodOrderTimeline, deriveFoodOrderStatus, foodOrderEtaMinutes } from '../utils/foodOrderTimeline';
import { FOOD_ORDER_STATUS_LABEL, type FoodOrderRecord } from '../utils/foodOrderTypes';
import {
    buildFoodCatalogFingerprint,
    type FoodCatalogItem,
    type FoodCatalogSource,
    type FoodPlatform,
} from '../utils/foodTypes';

type CatalogTab = 'recent' | 'favorites';
type SheetStep = 'choose' | 'paste' | 'confirm';

interface ImportDraft {
    source: FoodCatalogSource;
    platform: FoodPlatform;
    merchantName: string;
    name: string;
    price: string;
    description: string;
    originalUrl: string;
    rawShareText?: string;
    visualSummary?: string;
    imageBlob?: Blob;
}

const EMPTY_DRAFT: ImportDraft = {
    source: 'manual',
    platform: 'unknown',
    merchantName: '',
    name: '',
    price: '',
    description: '',
    originalUrl: '',
};

const fieldClass = 'w-full rounded-xl bg-slate-100/90 dark:bg-slate-800 border border-transparent focus:border-orange-300 focus:outline-none px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400';

const FoodImageThumb: React.FC<{ imageRef: string; alt: string }> = ({ imageRef, alt }) => {
    const url = useBlobRefUrl(imageRef);
    return url
        ? <img src={url} alt={alt} loading="lazy" className="w-24 h-24 rounded-2xl object-cover shrink-0 bg-orange-50" />
        : <div className="w-24 h-24 rounded-2xl shrink-0 bg-orange-50 dark:bg-orange-500/10 animate-pulse" />;
};

const sourceLabel = (source: FoodCatalogSource): string =>
    source === 'simulated' ? 'Lemuria 模拟' : '已导入';

const FoodDelivery: React.FC = () => {
    const { closeApp, apiConfig, addToast, characters, userProfile, groups, realtimeConfig } = useOS();
    const [items, setItems] = useState<FoodCatalogItem[]>([]);
    const [orders, setOrders] = useState<FoodOrderRecord[]>([]);
    const [cart, setCart] = useState<FoodCart>([]);
    const [tab, setTab] = useState<CatalogTab>('recent');
    const [sheetStep, setSheetStep] = useState<SheetStep | null>(null);
    const [shareText, setShareText] = useState('');
    const [draft, setDraft] = useState<ImportDraft>(EMPTY_DRAFT);
    const [previewUrl, setPreviewUrl] = useState('');
    const [recognizing, setRecognizing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [cartOpen, setCartOpen] = useState(false);
    const [recipientId, setRecipientId] = useState('');
    const [ordering, setOrdering] = useState(false);
    const [detailOrder, setDetailOrder] = useState<FoodOrderRecord | null>(null);
    const screenshotInputRef = useRef<HTMLInputElement>(null);
    const submissionIdRef = useRef('');

    useEffect(() => {
        if (cart.length === 0) setCartOpen(false);
    }, [cart.length]);

    const reload = useCallback(async () => {
        const [catalog, orderList] = await Promise.all([listFoodCatalogItems(), listFoodOrders()]);
        setItems(catalog);
        setOrders(orderList);
        setDetailOrder(current => current ? orderList.find(order => order.id === current.id) || null : null);
    }, []);
    useEffect(() => { void reload(); }, [reload]);
    useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

    const visibleItems = useMemo(
        () => tab === 'favorites' ? items.filter(item => item.favorite) : items,
        [items, tab],
    );
    const cartTotals = useMemo(() => calculateFoodCartTotals(cart), [cart]);
    const ongoingOrders = useMemo(() => orders.filter(order => {
        const status = deriveFoodOrderStatus(order);
        return status !== 'delivered' && status !== 'cancelled' && status !== 'failed';
    }), [orders]);
    const historicalOrders = useMemo(() => orders.filter(order => {
        const status = deriveFoodOrderStatus(order);
        return status === 'delivered' || status === 'cancelled' || status === 'failed';
    }), [orders]);

    const reactionDepsFor = useCallback((charId: string) => {
        const char = characters.find(candidate => candidate.id === charId);
        return char ? { char, userProfile, groups, apiConfig, realtimeConfig, addToast } : null;
    }, [characters, userProfile, groups, apiConfig, realtimeConfig, addToast]);

    const refreshOrderProgress = useCallback(async () => {
        const current = await listFoodOrders();
        for (const order of current) {
            const deps = reactionDepsFor(order.charId);
            if (deps) await handleFoodOrderDelivery(order.id, deps);
        }
        await reload();
    }, [reactionDepsFor, reload]);

    useEffect(() => {
        const timer = window.setInterval(() => { void refreshOrderProgress(); }, 60_000);
        const onVisibility = () => { if (document.visibilityState === 'visible') void refreshOrderProgress(); };
        document.addEventListener('visibilitychange', onVisibility);
        void refreshOrderProgress();
        return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
    }, [refreshOrderProgress]);
    useEffect(() => {
        if (cartOpen && !recipientId && characters.length > 0) setRecipientId(characters[0].id);
    }, [cartOpen, recipientId, characters]);

    const clearPreview = () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl('');
    };
    const closeSheet = () => {
        clearPreview();
        setSheetStep(null);
        setShareText('');
        setDraft(EMPTY_DRAFT);
    };

    const beginManual = () => {
        setDraft({ ...EMPTY_DRAFT, source: 'manual' });
        setSheetStep('confirm');
    };

    const parseShare = () => {
        const parsed = parseFoodImportText(shareText);
        setDraft({
            ...EMPTY_DRAFT,
            source: 'imported_share',
            platform: parsed.platform,
            merchantName: parsed.merchantNameCandidate || '',
            name: parsed.itemNameCandidate || '',
            price: parsed.priceCandidate === undefined ? '' : String(parsed.priceCandidate),
            originalUrl: parsed.originalUrl || '',
            rawShareText: parsed.rawShareText,
        });
        setSheetStep('confirm');
    };

    const pickScreenshot = async (file: File | undefined) => {
        if (!file || recognizing) return;
        if (!file.type.startsWith('image/')) {
            addToast('请选择图片文件', 'error');
            return;
        }
        clearPreview();
        const objectUrl = URL.createObjectURL(file);
        setPreviewUrl(objectUrl);
        setRecognizing(true);
        try {
            const result = await prepareFoodScreenshotImport(file, apiConfig.visionApi);
            const extraction = result.extraction;
            setDraft({
                ...EMPTY_DRAFT,
                source: 'imported_screenshot',
                merchantName: extraction.merchantName || '',
                name: extraction.itemName || '',
                price: extraction.price === undefined ? '' : String(extraction.price),
                description: extraction.description || '',
                visualSummary: extraction.visualSummary,
                imageBlob: result.imageBlob,
            });
            setSheetStep('confirm');
            if (result.error) addToast(result.error, 'info');
        } catch (error) {
            addToast(`图片读取失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
            clearPreview();
        } finally {
            setRecognizing(false);
            if (screenshotInputRef.current) screenshotInputRef.current.value = '';
        }
    };

    const updateDraft = (patch: Partial<ImportDraft>) => setDraft(current => ({ ...current, ...patch }));

    const saveDraft = async () => {
        if (saving) return;
        const name = draft.name.trim();
        if (!name) {
            addToast('请填写商品名', 'error');
            return;
        }
        const originalUrl = draft.originalUrl.trim()
            ? sanitizeFoodExternalUrl(draft.originalUrl)
            : undefined;
        if (draft.originalUrl.trim() && !originalUrl) {
            addToast('原始链接只支持 http 或 https', 'error');
            return;
        }
        const price = draft.price.trim() ? Number(draft.price) : undefined;
        if (price !== undefined && (!Number.isFinite(price) || price < 0)) {
            addToast('请输入有效的非负价格', 'error');
            return;
        }

        setSaving(true);
        let imageRef: string | undefined;
        try {
            const fingerprint = buildFoodCatalogFingerprint({
                platform: draft.platform,
                merchantName: draft.merchantName,
                name,
                originalUrl,
            });
            const existing = await getFoodCatalogItemByFingerprint(fingerprint);
            if (existing) {
                addToast('这个商品已经导入过了', 'info');
                closeSheet();
                return;
            }
            if (draft.imageBlob) imageRef = await putImageBlob(draft.imageBlob);
            const result = await createFoodCatalogItem({
                fingerprint,
                source: draft.source,
                platform: draft.platform,
                merchantName: draft.merchantName.trim() || undefined,
                name,
                description: draft.description.trim() || undefined,
                price,
                originalUrl,
                rawShareText: draft.rawShareText,
                imageRef,
                visualSummary: draft.visualSummary,
                favorite: false,
            });
            if (!result.created && imageRef) await deleteBlobRef(imageRef);
            addToast(result.created ? '商品已保存到外卖目录' : '这个商品已经导入过了', result.created ? 'success' : 'info');
            await reload();
            closeSheet();
        } catch (error) {
            if (imageRef) await deleteBlobRef(imageRef);
            addToast(`保存失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleFavorite = async (id: string) => {
        await toggleFoodFavorite(id);
        await reload();
    };

    const handleAddToCart = (item: FoodCatalogItem) => {
        const result = addFoodCartItem(cart, item);
        if (!result.merchantConflict) {
            setCart(result.cart);
            submissionIdRef.current = '';
            addToast('已加入购物车', 'success');
            return;
        }
        if (window.confirm('当前购物车里是另一家店的商品，是否清空后更换？')) {
            setCart(addFoodCartItem([], item).cart);
            submissionIdRef.current = '';
            addToast('已更换购物车商家', 'info');
        }
    };


    const confirmOrder = async () => {
        if (ordering || cart.length === 0) return;
        const recipient = characters.find(char => char.id === recipientId);
        if (!recipient) { addToast('请选择收餐角色', 'error'); return; }
        if (!submissionIdRef.current) {
            submissionIdRef.current = typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        }
        const now = Date.now();
        setOrdering(true);
        try {
            // 玩家付款订单：钱包余额校验 + 扣款 + 建单在同一个 IndexedDB 事务内原子完成；
            // 价格未知（部分商品缺价）直接拦截，不猜价、不按 0 元下单。
            const result = await createPaidFoodOrder({
                eventKey: `food:user:${recipient.id}:${submissionIdRef.current}`,
                source: cart.some(line => line.item.source === 'simulated') ? 'simulated' : 'catalog_imported',
                payer: 'user',
                orderer: { type: 'user', id: 'user', nameSnapshot: userProfile?.name || '用户' },
                recipient: { type: 'character', id: recipient.id, nameSnapshot: recipient.name },
                charId: recipient.id,
                merchantName: cart[0]?.item.merchantName,
                items: snapshotFoodCart(cart),
                subtotal: cartTotals.knownSubtotal,
                deliveryFee: cartTotals.deliveryFee,
                total: cartTotals.total,
                status: 'confirmed',
                timeline: createFoodOrderTimeline(now),
            });
            await projectFoodOrderToChat(result.record);
            setCart(current => clearFoodCartAfterOrder(current, true));
            setCartOpen(false);
            submissionIdRef.current = '';
            addToast(result.created ? `已为${recipient.name}下单` : '这份订单已经提交过了', 'success');
            await reload();
            const deps = reactionDepsFor(recipient.id);
            if (deps) void triggerFoodOrderReaction(result.record.id, 'ordered', deps);
        } catch (error) {
            addToast(`下单失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
        } finally {
            setOrdering(false);
        }
    };

    const cancelOrder = async (order: FoodOrderRecord) => {
        const status = deriveFoodOrderStatus(order);
        if (status === 'delivered' || status === 'cancelled' || status === 'failed') return;
        const updated = await updateFoodOrder(order.id, { status: 'cancelled' });
        if (updated) {
            setDetailOrder(updated); addToast('订单已取消', 'info'); await reload();
            // 玩家付款且尚未取餐（confirmed/preparing）→ 全额退款；退款是幂等 income entry，
            // 重复点击/重放不会多退。角色付款订单 orderPayer==='character'，不触碰钱包。
            if (orderPayer(updated) === 'user' && isRefundableCancelStatus(status)) {
                try {
                    const refundResult = await refundFoodOrder(updated);
                    if (refundResult.refunded) addToast(`已退款 ¥${updated.total}`, 'success');
                } catch (error) {
                    console.warn('[Food] 退款失败（订单取消不受影响）:', error);
                }
            }
        }
    };

    const renderOrderRow = (order: FoodOrderRecord) => {
        const status = deriveFoodOrderStatus(order);
        const eta = foodOrderEtaMinutes(order);
        const direction = order.orderer.type === 'character'
            ? order.recipient.type === 'user' ? `${order.orderer.nameSnapshot}给你点的` : `${order.orderer.nameSnapshot}给自己点的`
            : `你送给 ${order.recipient.nameSnapshot}`;
        return (
            <button key={order.id} type="button" onClick={() => setDetailOrder(order)} className="w-full rounded-2xl bg-white dark:bg-slate-900 p-3.5 shadow-sm ring-1 ring-black/5 text-left">
                <div className="flex justify-between gap-3">
                    <div className="min-w-0">
                        <div className="font-semibold text-sm truncate flex items-center gap-1.5">
                            <span>{order.merchantName || '外卖订单'}</span>
                            {order.source === 'simulated' && <span className="text-[9px] rounded-full bg-violet-100 dark:bg-violet-500/20 text-violet-600 px-1.5 py-0.5">Lemuria 模拟</span>}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5 truncate">{direction} · {order.items.map(item => `${item.name} ×${item.quantity}`).join('、')}</div>
                    </div>
                    <span className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-full bg-orange-50 dark:bg-orange-500/10 text-orange-600">{FOOD_ORDER_STATUS_LABEL[status]}</span>
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-slate-500">
                    <span>{eta ? `预计 ${eta} 分钟送达` : status === 'delivered' ? '已经送达' : FOOD_ORDER_STATUS_LABEL[status]}</span>
                    <span>{order.total === undefined ? '部分价格未记录' : `¥${order.total}`}</span>
                </div>
            </button>
        );
    };

    return (
        <div className="relative h-full overflow-hidden bg-[#fff8ef] dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
            <header className="shrink-0 px-4 py-3 flex items-center gap-3 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-b border-orange-100 dark:border-slate-800">
                <button type="button" aria-label="返回" onClick={closeApp} className="w-9 h-9 rounded-full flex items-center justify-center active:bg-orange-100 dark:active:bg-slate-800">
                    <ArrowLeft size={22} />
                </button>
                <div>
                    <h1 className="font-bold text-lg leading-tight">外卖</h1>
                    <p className="text-[11px] text-slate-400">把喜欢的真实商品留在这里</p>
                </div>
            </header>

            <main className={`flex-1 min-h-0 overflow-y-auto px-4 pt-4 ${cart.length > 0 ? 'pb-28' : 'pb-8'}`}>
                <button
                    type="button"
                    onClick={() => setSheetStep('choose')}
                    className="w-full rounded-3xl p-5 text-left bg-gradient-to-br from-orange-400 to-rose-400 text-white shadow-lg shadow-orange-200/50 dark:shadow-none active:scale-[0.99] transition-transform"
                >
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-lg font-bold">导入真实商品</div>
                            <div className="text-xs text-white/80 mt-1">分享文字、链接或商品截图</div>
                        </div>
                        <div className="w-11 h-11 bg-white/20 rounded-2xl flex items-center justify-center"><Plus size={24} weight="bold" /></div>
                    </div>
                </button>

                {ongoingOrders.length > 0 && (
                    <section className="mt-5">
                        <h2 className="text-sm font-bold mb-2">进行中订单</h2>
                        <div className="space-y-2">{ongoingOrders.map(renderOrderRow)}</div>
                    </section>
                )}

                {historicalOrders.length > 0 && (
                    <section className="mt-5">
                        <h2 className="text-sm font-bold mb-2">最近订单</h2>
                        <div className="space-y-2">{historicalOrders.slice(0, 5).map(renderOrderRow)}</div>
                    </section>
                )}

                <div className="mt-5 p-1 bg-orange-100/70 dark:bg-slate-900 rounded-2xl grid grid-cols-2 gap-1">
                    {([['recent', '最近导入'], ['favorites', '收藏']] as const).map(([value, label]) => (
                        <button key={value} type="button" onClick={() => setTab(value)} className={`rounded-xl py-2 text-sm font-medium transition ${tab === value ? 'bg-white dark:bg-slate-800 shadow-sm text-orange-600' : 'text-slate-500'}`}>
                            {label}{value === 'favorites' && items.some(item => item.favorite) ? ` · ${items.filter(item => item.favorite).length}` : ''}
                        </button>
                    ))}
                </div>

                <div className="mt-4 space-y-3">
                    {visibleItems.map(item => {
                        const safeUrl = sanitizeFoodExternalUrl(item.originalUrl);
                        return (
                            <article key={item.id} className="rounded-3xl bg-white dark:bg-slate-900 p-3.5 shadow-sm ring-1 ring-black/5 flex gap-3">
                                {item.imageRef
                                    ? <FoodImageThumb imageRef={item.imageRef} alt={item.name} />
                                    : <div className="w-24 h-24 rounded-2xl shrink-0 bg-orange-50 dark:bg-orange-500/10 flex items-center justify-center text-3xl">🍜</div>}
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                            <span className="inline-flex rounded-full bg-orange-50 dark:bg-orange-500/10 text-orange-600 px-2 py-0.5 text-[10px] font-semibold">{sourceLabel(item.source)}</span>
                                            <h2 className="font-semibold mt-1 truncate">{item.name}</h2>
                                        </div>
                                        <button type="button" aria-label={item.favorite ? '取消收藏' : '收藏'} onClick={() => void handleFavorite(item.id)} className="w-8 h-8 rounded-full flex items-center justify-center active:bg-rose-50">
                                            <Heart size={20} weight={item.favorite ? 'fill' : 'regular'} className={item.favorite ? 'text-rose-500' : 'text-slate-400'} />
                                        </button>
                                    </div>
                                    {item.merchantName && <p className="text-xs text-slate-500 truncate mt-0.5">{item.merchantName}</p>}
                                    <div className="mt-2 flex items-end justify-between gap-2">
                                        <span className="font-bold text-orange-600">{item.price === undefined ? '价格待确认' : `¥${item.price}`}</span>
                                        <div className="flex items-center gap-2">
                                            {safeUrl && (
                                                <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium text-slate-500 inline-flex items-center gap-0.5">
                                                    原平台 <CaretRight size={12} />
                                                </a>
                                            )}
                                            <button type="button" onClick={() => handleAddToCart(item)} className="rounded-full bg-orange-500 text-white text-[11px] font-semibold px-3 py-1.5 active:scale-95">加入</button>
                                        </div>
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                    {visibleItems.length === 0 && (
                        <div className="py-16 text-center text-slate-400">
                            <div className="text-4xl mb-3">🥡</div>
                            <p className="text-sm">{tab === 'favorites' ? '还没有收藏的商品' : '还没有导入商品'}</p>
                        </div>
                    )}
                </div>
            </main>

            {cart.length > 0 && (
                <div className="absolute left-4 right-4 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-20">
                    <button type="button" onClick={() => setCartOpen(true)} className="w-full rounded-2xl bg-slate-900 dark:bg-orange-500 text-white px-4 py-3 shadow-xl flex items-center justify-between active:scale-[0.99]">
                        <span className="flex items-center gap-2"><ShoppingCart size={20} weight="fill" /><span className="text-sm font-semibold">{cartTotals.itemCount} 件</span></span>
                        <span className="text-sm font-bold">{cartTotals.hasUnknownPrices ? `已知 ¥${cartTotals.knownSubtotal}` : `合计 ¥${cartTotals.total}`}</span>
                    </button>
                </div>
            )}

            <input ref={screenshotInputRef} type="file" accept="image/*" className="hidden" onChange={event => void pickScreenshot(event.target.files?.[0])} />

            {sheetStep && createPortal(
                <div className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/40" onMouseDown={event => { if (event.target === event.currentTarget && !saving && !recognizing) closeSheet(); }}>
                    <section className="w-full max-w-lg max-h-[88vh] overflow-y-auto rounded-t-[28px] bg-white dark:bg-slate-900 px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl">
                        <div className="w-10 h-1 rounded-full bg-slate-200 dark:bg-slate-700 mx-auto mb-3" />
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h2 className="font-bold text-lg">{sheetStep === 'confirm' ? '确认商品信息' : sheetStep === 'paste' ? '粘贴分享内容' : '导入真实商品'}</h2>
                                {sheetStep === 'confirm' && <p className="text-xs text-slate-400 mt-0.5">解析结果只是候选，请确认后再保存</p>}
                            </div>
                            <button type="button" aria-label="关闭" disabled={saving || recognizing} onClick={closeSheet} className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center disabled:opacity-40"><X size={18} /></button>
                        </div>

                        {sheetStep === 'choose' && (
                            <div className="space-y-2.5">
                                <button type="button" onClick={() => setSheetStep('paste')} className="w-full p-4 rounded-2xl bg-orange-50 dark:bg-orange-500/10 flex items-center gap-3 text-left">
                                    <LinkSimple size={24} className="text-orange-500" /><div><div className="font-semibold">粘贴分享内容</div><div className="text-xs text-slate-400">本地解析文字与网页链接</div></div>
                                </button>
                                <button type="button" disabled={recognizing} onClick={() => screenshotInputRef.current?.click()} className="w-full p-4 rounded-2xl bg-sky-50 dark:bg-sky-500/10 flex items-center gap-3 text-left disabled:opacity-60">
                                    <ImageSquare size={24} className="text-sky-500" /><div><div className="font-semibold">上传截图</div><div className="text-xs text-slate-400">{recognizing ? '正在识别截图…' : '从相册选择商品截图'}</div></div>
                                </button>
                                <button type="button" onClick={beginManual} className="w-full p-4 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center gap-3 text-left">
                                    <NotePencil size={24} className="text-slate-500" /><div><div className="font-semibold">手动填写</div><div className="text-xs text-slate-400">不使用识图也能保存</div></div>
                                </button>
                            </div>
                        )}

                        {sheetStep === 'paste' && (
                            <div>
                                <textarea value={shareText} onChange={event => setShareText(event.target.value)} rows={7} className={`${fieldClass} resize-none`} placeholder="把美团/饿了么的分享文字或链接粘贴到这里" />
                                <p className="text-[11px] text-slate-400 mt-2">只做本地候选解析，不访问原平台，也不会调用 AI。</p>
                                <button type="button" onClick={parseShare} className="w-full mt-4 py-3 rounded-2xl bg-orange-500 text-white font-semibold active:scale-[0.99]">解析</button>
                            </div>
                        )}

                        {sheetStep === 'confirm' && (
                            <div className="space-y-3">
                                {previewUrl && <img src={previewUrl} alt="待导入截图" className="w-full max-h-48 object-contain rounded-2xl bg-slate-100 dark:bg-slate-800" />}
                                <label className="block text-xs text-slate-500">平台
                                    <select value={draft.platform} onChange={event => updateDraft({ platform: event.target.value as FoodPlatform })} className={`${fieldClass} mt-1`}>
                                        <option value="meituan">美团</option><option value="eleme">饿了么</option><option value="other">其他平台</option><option value="unknown">未知</option>
                                    </select>
                                </label>
                                <label className="block text-xs text-slate-500">商家名
                                    <input value={draft.merchantName} onChange={event => updateDraft({ merchantName: event.target.value })} className={`${fieldClass} mt-1`} placeholder="可以留空" />
                                </label>
                                <label className="block text-xs text-slate-500">商品名 <span className="text-rose-500">*</span>
                                    <input value={draft.name} onChange={event => updateDraft({ name: event.target.value })} className={`${fieldClass} mt-1`} placeholder="唯一必填项" />
                                </label>
                                <label className="block text-xs text-slate-500">价格
                                    <input type="number" inputMode="decimal" min="0" step="0.01" value={draft.price} onChange={event => updateDraft({ price: event.target.value })} className={`${fieldClass} mt-1`} placeholder="可以留空" />
                                </label>
                                <label className="block text-xs text-slate-500">描述
                                    <textarea value={draft.description} onChange={event => updateDraft({ description: event.target.value })} rows={3} className={`${fieldClass} mt-1 resize-none`} placeholder="口味、规格等，可留空" />
                                </label>
                                <label className="block text-xs text-slate-500">原始链接
                                    <input value={draft.originalUrl} onChange={event => updateDraft({ originalUrl: event.target.value })} className={`${fieldClass} mt-1`} placeholder="仅支持 http / https" />
                                </label>
                                <button type="button" disabled={saving} onClick={() => void saveDraft()} className="w-full py-3 rounded-2xl bg-orange-500 text-white font-semibold disabled:opacity-50 active:scale-[0.99]">
                                    {saving ? '正在保存…' : '确认并保存'}
                                </button>
                            </div>
                        )}
                    </section>
                </div>,
                document.body,
            )}

            {cartOpen && createPortal(
                <div className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/40" onMouseDown={event => { if (event.target === event.currentTarget && !ordering) setCartOpen(false); }}>
                    <section className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-t-[28px] bg-white dark:bg-slate-900 px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl">
                        <div className="w-10 h-1 rounded-full bg-slate-200 dark:bg-slate-700 mx-auto mb-3" />
                        <div className="flex items-center justify-between mb-4">
                            <div><h2 className="font-bold text-lg">购物车</h2><p className="text-xs text-slate-400">{cart[0]?.item.merchantName || '未记录商家'}</p></div>
                            <button type="button" aria-label="关闭购物车" onClick={() => setCartOpen(false)} disabled={ordering} className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center"><X size={18} /></button>
                        </div>
                        <div className="space-y-3">
                            {cart.map(line => (
                                <div key={line.item.id} className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0"><div className="font-semibold text-sm truncate">{line.item.name}</div><div className="text-xs text-orange-600 mt-0.5">{line.item.price === undefined ? '价格未记录' : `¥${line.item.price}`}</div></div>
                                        <div className="flex items-center gap-1.5">
                                            <button type="button" aria-label="减少数量" onClick={() => { setCart(current => setFoodCartQuantity(current, line.item.id, line.quantity - 1)); submissionIdRef.current = ''; }} className="w-7 h-7 rounded-full bg-white dark:bg-slate-700 flex items-center justify-center"><Minus size={13} /></button>
                                            <span className="w-6 text-center text-sm">{line.quantity}</span>
                                            <button type="button" aria-label="增加数量" onClick={() => { setCart(current => setFoodCartQuantity(current, line.item.id, line.quantity + 1)); submissionIdRef.current = ''; }} className="w-7 h-7 rounded-full bg-orange-500 text-white flex items-center justify-center"><Plus size={13} /></button>
                                            <button type="button" aria-label="移除商品" onClick={() => { setCart(current => removeFoodCartItem(current, line.item.id)); submissionIdRef.current = ''; }} className="w-7 h-7 rounded-full text-slate-400 flex items-center justify-center"><Trash size={15} /></button>
                                        </div>
                                    </div>
                                    <input value={line.note || ''} onChange={event => { setCart(current => setFoodCartNote(current, line.item.id, event.target.value)); submissionIdRef.current = ''; }} className={`${fieldClass} mt-2 py-2 text-xs`} placeholder="商品备注，例如：不要香菜" />
                                </div>
                            ))}
                        </div>
                        <div className="mt-4 rounded-2xl border border-slate-100 dark:border-slate-800 p-3 space-y-1.5 text-xs">
                            <div className="flex justify-between"><span className="text-slate-500">已知商品小计</span><span>¥{cartTotals.knownSubtotal}</span></div>
                            <div className="flex justify-between"><span className="text-slate-500">Lemuria 配送费</span><span>¥{cartTotals.deliveryFee}</span></div>
                            {cartTotals.hasUnknownPrices
                                ? <div className="text-amber-600">部分商品未记录价格，不生成虚假总价。</div>
                                : <div className="flex justify-between pt-1 font-bold"><span>合计</span><span className="text-orange-600">¥{cartTotals.total}</span></div>}
                        </div>
                        <label className="block text-xs text-slate-500 mt-4">送给谁 <span className="text-rose-500">*</span>
                            <select value={recipientId} onChange={event => { setRecipientId(event.target.value); submissionIdRef.current = ''; }} className={`${fieldClass} mt-1`}>
                                <option value="">请选择角色</option>
                                {characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}
                            </select>
                        </label>
                        <p className="text-[10px] leading-relaxed text-slate-400 mt-3">商品信息来自你的导入；¥5 为 Lemuria 模拟配送费，不代表原平台实时价格或真实配送。</p>
                        <button type="button" disabled={ordering || cart.length === 0 || !recipientId} onClick={() => void confirmOrder()} className="w-full mt-4 py-3 rounded-2xl bg-orange-500 text-white font-semibold disabled:opacity-40 active:scale-[0.99]">
                            {ordering ? '正在下单…' : '确认下单'}
                        </button>
                    </section>
                </div>,
                document.body,
            )}

            {detailOrder && createPortal((() => {
                const status = deriveFoodOrderStatus(detailOrder);
                const canCancel = status !== 'delivered' && status !== 'cancelled' && status !== 'failed';
                const links = detailOrder.items.map(item => sanitizeFoodExternalUrl(item.originalUrl)).filter((url): url is string => !!url);
                const stages = ['confirmed', 'preparing', 'picked_up', 'delivering', 'delivered'] as const;
                const currentIndex = stages.indexOf(status as typeof stages[number]);
                return (
                    <div className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/40" onMouseDown={event => { if (event.target === event.currentTarget) setDetailOrder(null); }}>
                        <section className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-t-[28px] bg-white dark:bg-slate-900 px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl">
                            <div className="w-10 h-1 rounded-full bg-slate-200 dark:bg-slate-700 mx-auto mb-3" />
                            <div className="flex justify-between items-start gap-3">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h2 className="font-bold text-lg">{detailOrder.merchantName || '外卖订单'}</h2>
                                        {detailOrder.source === 'simulated' && <span className="text-[9px] rounded-full bg-violet-100 dark:bg-violet-500/20 text-violet-600 px-1.5 py-0.5">Lemuria 模拟</span>}
                                    </div>
                                    <p className="text-xs text-slate-400 mt-0.5">{detailOrder.orderer.nameSnapshot} → {detailOrder.recipient.nameSnapshot}{detailOrder.locationLabel ? ` · ${detailOrder.locationLabel}` : ''}</p>
                                </div>
                                <button type="button" aria-label="关闭订单详情" onClick={() => setDetailOrder(null)} className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center"><X size={18} /></button>
                            </div>
                            <div className="mt-4 grid grid-cols-5 gap-1">
                                {stages.map((stage, index) => <div key={stage} className="text-center"><div className={`h-1.5 rounded-full ${status === 'cancelled' || status === 'failed' ? 'bg-slate-200 dark:bg-slate-700' : index <= currentIndex ? 'bg-orange-500' : 'bg-orange-100 dark:bg-slate-700'}`} /><div className="text-[9px] text-slate-400 mt-1">{FOOD_ORDER_STATUS_LABEL[stage]}</div></div>)}
                            </div>
                            {(status === 'cancelled' || status === 'failed') && <div className="mt-3 text-sm font-semibold text-center text-slate-500">{FOOD_ORDER_STATUS_LABEL[status]}</div>}
                            <div className="mt-5 space-y-3">
                                {detailOrder.items.map((item, index) => (
                                    <div key={`${item.name}-${index}`} className="flex justify-between gap-3 text-sm">
                                        <div><div className="font-medium">{item.name} ×{item.quantity}</div>{item.note && <div className="text-xs text-slate-400 mt-0.5">备注：{item.note}</div>}</div>
                                        <span className="shrink-0">{item.unitPrice === undefined ? '价格未记录' : `¥${item.unitPrice * item.quantity}`}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs space-y-1.5">
                                <div className="flex justify-between"><span className="text-slate-500">商品小计</span><span>¥{detailOrder.subtotal ?? 0}</span></div>
                                <div className="flex justify-between"><span className="text-slate-500">Lemuria 配送费</span><span>¥{detailOrder.deliveryFee ?? 0}</span></div>
                                <div className="flex justify-between font-bold"><span>总价</span><span>{detailOrder.total === undefined ? '部分价格未记录' : `¥${detailOrder.total}`}</span></div>
                            </div>
                            {links[0] && <a href={links[0]} target="_blank" rel="noopener noreferrer" className="mt-4 block text-center text-xs text-orange-600">去原平台查看商品</a>}
                            <p className="text-[10px] leading-relaxed text-slate-400 mt-4">商品信息来自你的导入；配送进度为 Lemuria 模拟，不代表真实平台订单。</p>
                            {canCancel && <button type="button" onClick={() => void cancelOrder(detailOrder)} className="w-full mt-4 py-2.5 rounded-2xl bg-slate-100 dark:bg-slate-800 text-sm font-semibold text-slate-600 dark:text-slate-300">取消订单</button>}
                        </section>
                    </div>
                );
            })(), document.body)}
        </div>
    );
};

export default FoodDelivery;
