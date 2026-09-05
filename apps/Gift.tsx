/**
 * Gift — 礼物 App（Phase 2：玩家 → 角色送礼闭环）。
 *
 * 职责：读取 giftStore 时间线（全部/收到/送出 + 角色筛选）、Bottom Sheet 送礼
 * （纯文字 / 图片+文字 / 只有图片）、图片复用 blobref 管线与 ChatPhotoViewer 全屏预览。
 *
 * 本阶段不接聊天：送礼成功不生成 Chat message、无角色 reaction（Phase 3 接入）。
 * 角色/玩家数据全部来自 OSContext（characters / userProfile / apiConfig），不自建角色源。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Camera, Images, PaperPlaneRight, Plus, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import ChatPhotoViewer from '../components/chat/ChatPhotoViewer';
import { useBlobRefUrl } from '../utils/blobRef';
import { listGiftRecords } from '../utils/giftStore';
import type { GiftRecord } from '../utils/giftTypes';
import { EmptyGiftError, sendPlayerGift } from '../utils/giftPlayerSend';
import { projectGiftToChat, triggerGiftReaction } from '../utils/giftChatBridge';
import { GIFT_SEND_PENDING_STALE_MS, retryCharacterGiftImage } from '../utils/giftCharacterSend';
import { trackEvent } from '../utils/analytics';

type GiftTab = 'all' | 'received' | 'sent';

interface ViewerState {
    content: string;
    displayUrl: string;
    caption: string;
}

/** 缩略图：blobref → object URL 由 useBlobRefUrl 管理生命周期；点击交给全屏 Viewer。 */
const GiftImageThumb: React.FC<{ imageRef: string; onOpen: (url: string) => void }> = ({ imageRef, onOpen }) => {
    const url = useBlobRefUrl(imageRef);
    if (!url) {
        return <div className="w-20 h-20 rounded-xl bg-slate-200 dark:bg-slate-700 shrink-0 animate-pulse" />;
    }
    return (
        <button
            type="button"
            className="w-20 h-20 rounded-xl overflow-hidden shrink-0 ring-1 ring-black/5 active:scale-95 transition-transform"
            onClick={() => onOpen(url)}
        >
            <img src={url} className="w-full h-full object-cover" alt="礼物图片" loading="lazy" />
        </button>
    );
};

const formatGiftTime = (ts: number): string => {
    const d = new Date(ts);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const pad = (n: number) => String(n).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (sameYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};

const STATUS_LABEL: Partial<Record<GiftRecord['status'], string>> = {
    pending: '进行中',
    delivered: '已送达',
    failed: '失败',
    returned: '已退回',
    rejected: '已婉拒',
    cancelled: '已取消',
    interrupted: '已中断',
};

const Gift: React.FC = () => {
    const { closeApp, characters, userProfile, apiConfig, groups, addToast } = useOS();
    const [gifts, setGifts] = useState<GiftRecord[]>([]);
    const [tab, setTab] = useState<GiftTab>('all');
    const [charFilter, setCharFilter] = useState<string>('all');
    const [viewer, setViewer] = useState<ViewerState | null>(null);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [retryingGiftId, setRetryingGiftId] = useState<string | null>(null);

    const reload = useCallback(async (filter = charFilter) => {
        const list = filter === 'all'
            ? await listGiftRecords()
            : await listGiftRecords({ charId: filter });
        setGifts(list);
    }, [charFilter]);

    useEffect(() => { void reload(); }, [reload]);

    const visibleGifts = useMemo(() => gifts.filter(g => {
        if (tab === 'sent') return g.sender.type === 'user';
        if (tab === 'received') return g.sender.type === 'character';
        return true;
    }), [gifts, tab]);

    const charNameOf = useCallback((id: string, fallback = '角色') =>
        characters.find(c => c.id === id)?.name || fallback, [characters]);

    const openViewer = (content: string, displayUrl: string, caption: string) =>
        setViewer({ content, displayUrl, caption });

    // 手动重试角色 AI 礼物图（仅点击触发；同一 gift 只重跑生成，不建新礼物）。
    const handleRetryCharGift = async (gift: GiftRecord) => {
        if (retryingGiftId) return;
        const char = characters.find(c => c.id === gift.charId);
        if (!char) { addToast('找不到对应角色', 'error'); return; }
        setRetryingGiftId(gift.id);
        try {
            const res = await retryCharacterGiftImage(gift.id, { char, onToast: addToast });
            if (res.gift) await reload();
        } finally {
            setRetryingGiftId(null);
        }
    };

    // ─── 送礼 Bottom Sheet 状态 ────────────────────────────────────────────────
    const [formCharId, setFormCharId] = useState<string>('');
    const [formName, setFormName] = useState('');
    const [formDescription, setFormDescription] = useState('');
    const [formNote, setFormNote] = useState('');
    const [imageFile, setImageFile] = useState<File | null>(null);
    const [imageOrigin, setImageOrigin] = useState<'camera' | 'gallery'>('gallery');
    const [previewUrl, setPreviewUrl] = useState<string>('');
    const [sending, setSending] = useState(false);
    const cameraInputRef = useRef<HTMLInputElement>(null);
    const galleryInputRef = useRef<HTMLInputElement>(null);

    // 只有一个角色时默认选中
    useEffect(() => {
        if (!sheetOpen && characters.length === 1) setFormCharId(characters[0].id);
    }, [sheetOpen, characters]);

    // preview object URL 生命周期：换图/关 Sheet/卸载时回收
    useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

    const pickImage = (file: File | undefined | null, origin: 'camera' | 'gallery') => {
        if (!file) return;
        if (!file.type.startsWith('image/')) { addToast('请选择图片文件', 'error'); return; }
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setImageFile(file);
        setImageOrigin(origin);
        setPreviewUrl(URL.createObjectURL(file));
    };

    const resetForm = () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setFormName(''); setFormDescription(''); setFormNote('');
        setImageFile(null); setPreviewUrl('');
    };

    const closeSheet = () => { setSheetOpen(false); resetForm(); };

    const formInvalid = !formName.trim() && !formDescription.trim() && !imageFile;

    const handleSend = async () => {
        if (sending || formInvalid) return;
        if (!formCharId) { addToast('请先选择收礼角色', 'error'); return; }
        const char = characters.find(c => c.id === formCharId);
        if (!char) { addToast('角色不存在', 'error'); return; }
        setSending(true);
        try {
            const result = await sendPlayerGift({
                charId: char.id,
                characterName: char.name,
                userName: userProfile?.name,
                name: formName,
                description: formDescription,
                note: formNote,
                imageFile,
                imageOrigin,
                visionConfig: apiConfig?.visionApi,
            });
            addToast(result.created ? `礼物已送给 ${char.name}` : '这份礼物已送出过，未重复记录', 'success');
            trackEvent('送出礼物');
            setSheetOpen(false);
            resetForm();
            if (charFilter !== 'all' && charFilter !== char.id) setCharFilter('all');
            await reload('all');
            // Phase 3：投影聊天礼物卡 → 角色一次真实回应（复用聊天主链路）。
            // 全程非阻塞：识图先落定（回应 prompt 能用 visualSummary），失败只提示、
            // 礼物保持 delivered，不自动重试、不自动跳转 Chat。
            void (async () => {
                try {
                    await projectGiftToChat(result.record);
                    await result.visionSettled;
                    const reaction = await triggerGiftReaction(result.record.id, {
                        char, userProfile, groups, apiConfig, addToast,
                    });
                    if (!reaction.ok && reaction.reason === 'already_reacted') return;
                    if (!reaction.ok) addToast(`${char.name}这会儿没能回应，礼物已收到`, 'info');
                } catch (e) {
                    console.warn('[Gift] 聊天投影/回应未完成，礼物不受影响:', e instanceof Error ? e.message : e);
                    addToast(`${char.name}这会儿没能回应，礼物已收到`, 'info');
                } finally {
                    void reload();
                }
            })();
        } catch (e) {
            if (e instanceof EmptyGiftError) addToast(e.message, 'error');
            else addToast(`送礼失败：${e instanceof Error ? e.message : '未知错误'}`.slice(0, 60), 'error');
        } finally {
            setSending(false);
        }
    };

    // ─── 渲染 ──────────────────────────────────────────────────────────────────

    const renderTimelineCard = (g: GiftRecord) => {
        const sent = g.sender.type === 'user';
        const counterpart = sent
            ? { name: g.recipient.nameSnapshot || charNameOf(g.charId), label: '送给' }
            : { name: g.sender.nameSnapshot || charNameOf(g.charId), label: '收到自' };
        // 角色 AI 礼物的生成状态：pending 显示「正在准备」（长期 pending = 生成中断），failed 可手动重试。
        const charAiImage = !sent && g.image.origin === 'ai_generated' ? g.image : null;
        const imageStatus = charAiImage?.status;
        const stalePending = imageStatus === 'pending'
            && Date.now() - g.updatedAt > GIFT_SEND_PENDING_STALE_MS;
        const canRetry = !!charAiImage && (imageStatus === 'failed' || stalePending) && retryingGiftId !== g.id;
        return (
            <div key={g.id} className="bg-white dark:bg-slate-800/80 rounded-2xl p-3.5 shadow-sm ring-1 ring-black/5 flex gap-3">
                {g.image.imageRef && g.image.status === 'ready'
                    ? <GiftImageThumb imageRef={g.image.imageRef} onOpen={url => openViewer(g.image.imageRef!, url, g.gift.name)} />
                    : (
                        <div className={`w-20 h-20 rounded-xl shrink-0 flex items-center justify-center text-2xl ${sent ? 'bg-rose-50 dark:bg-rose-500/10' : 'bg-indigo-50 dark:bg-indigo-500/10'}`}>
                            {charAiImage && (imageStatus === 'pending' || imageStatus === 'failed')
                                ? (imageStatus === 'pending'
                                    ? <span className="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-slate-600 border-t-indigo-400 animate-spin" />
                                    : <span className="text-xl">⚠️</span>)
                                : '🎁'}
                        </div>
                    )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${sent ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-300' : 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300'}`}>
                            {sent ? '送出' : '收到'}
                        </span>
                        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 break-all">{g.gift.name}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                        {counterpart.label} <span className="font-medium">{counterpart.name}</span>
                        <span className="mx-1">·</span>
                        {formatGiftTime(g.createdAt)}
                        <span className="mx-1">·</span>
                        <span>{STATUS_LABEL[g.status] || g.status}</span>
                    </div>
                    {charAiImage && imageStatus === 'pending' && (
                        <div className="text-[11px] text-slate-400 mt-1">{stalePending ? '生成中断' : '正在准备礼物图片…'}</div>
                    )}
                    {charAiImage && imageStatus === 'failed' && (
                        <div className="flex items-center gap-2 mt-1">
                            <span className="text-[11px] text-slate-400">图片生成失败</span>
                            <button
                                type="button"
                                disabled={!canRetry}
                                onClick={() => handleRetryCharGift(g)}
                                className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-indigo-500 text-white disabled:opacity-50 active:scale-95 transition"
                            >
                                {retryingGiftId === g.id ? '重新生成中…' : '重新生成'}
                            </button>
                        </div>
                    )}
                    {g.gift.description && (
                        <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 line-clamp-2 break-words">{g.gift.description}</p>
                    )}
                    {g.gift.note && (
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 line-clamp-2 break-words">「{g.gift.note}」</p>
                    )}
                    {/* 角色回应（来自 GiftRecord；没有就绝不伪造）。内部枚举不直接展示。 */}
                    {g.reaction?.acceptance && (
                        <div className="mt-1.5 pt-1.5 border-t border-black/5 dark:border-white/10">
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${g.reaction.acceptance === 'accepted' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-300' : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>
                                    {g.reaction.acceptance === 'accepted' ? '已收下' : g.reaction.acceptance === 'returned' ? '已退回' : '拒收了'}
                                </span>
                                {g.reaction.disposition && (
                                    <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{g.reaction.disposition}</span>
                                )}
                            </div>
                            {g.reaction.review && (
                                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 break-words">TA 的反应：{g.reaction.review}</p>
                            )}
                            {/* 已进入长期记忆的克制标记（不显示 candidate/failed/memoryId 等内部状态） */}
                            {g.memory?.status === 'committed' && (
                                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">🧠 TA记得这件事</p>
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const sheetFieldLabel = 'text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1.5';
    const sheetInputClass = 'w-full rounded-xl bg-slate-100 dark:bg-slate-800 px-3 py-2.5 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-rose-400/60';

    const renderSheet = () => {
        if (typeof document === 'undefined' || !sheetOpen) return null;
        return createPortal(
            <div className="fixed inset-0 z-[200] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="送礼物">
                <button type="button" aria-label="关闭" className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={closeSheet} />
                <div
                    className="relative bg-white dark:bg-slate-900 rounded-t-3xl shadow-2xl max-h-[86vh] flex flex-col animate-fade-in"
                    style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
                >
                    <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
                        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">送礼物</span>
                        <button type="button" onClick={closeSheet} className="p-1.5 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-95 transition">
                            <X size={18} weight="bold" />
                        </button>
                    </div>
                    <div className="overflow-y-auto px-4 pb-4 space-y-3.5">
                        {/* 收礼角色（必选） */}
                        <div>
                            <div className={sheetFieldLabel}>收礼角色 *</div>
                            <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                                {characters.map(c => (
                                    <button
                                        key={c.id}
                                        type="button"
                                        onClick={() => setFormCharId(c.id)}
                                        className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium ring-1 transition ${formCharId === c.id
                                            ? 'bg-rose-500 text-white ring-rose-500'
                                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 ring-black/5'}`}
                                    >
                                        {c.avatar
                                            ? <img src={c.avatar} className="w-5 h-5 rounded-full object-cover" alt="" />
                                            : <span className="w-5 h-5 rounded-full bg-slate-300 dark:bg-slate-600" />}
                                        <span className="max-w-24 truncate">{c.name}</span>
                                    </button>
                                ))}
                                {characters.length === 0 && <span className="text-xs text-slate-400 py-1.5">还没有角色，请先在「神经链接」创建</span>}
                            </div>
                        </div>
                        {/* 礼物名称 */}
                        <div>
                            <div className={sheetFieldLabel}>礼物名称</div>
                            <input
                                value={formName}
                                onChange={e => setFormName(e.target.value)}
                                placeholder="这是什么礼物？"
                                maxLength={60}
                                className={sheetInputClass}
                            />
                        </div>
                        {/* 礼物描述 */}
                        <div>
                            <div className={sheetFieldLabel}>礼物描述</div>
                            <textarea
                                value={formDescription}
                                onChange={e => setFormDescription(e.target.value)}
                                placeholder="例如：我自己织的一条深蓝色围巾。"
                                rows={3}
                                maxLength={2000}
                                className={`${sheetInputClass} resize-none`}
                            />
                        </div>
                        {/* 留言 */}
                        <div>
                            <div className={sheetFieldLabel}>留言</div>
                            <input
                                value={formNote}
                                onChange={e => setFormNote(e.target.value)}
                                placeholder="例如：天气冷了记得戴。"
                                maxLength={300}
                                className={sheetInputClass}
                            />
                        </div>
                        {/* 图片：拍照 / 相册 两个明确入口 + 预览 */}
                        <div>
                            <div className={sheetFieldLabel}>图片（可选）</div>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => cameraInputRef.current?.click()}
                                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 active:scale-[0.98] transition"
                                >
                                    <Camera size={16} /> 拍照
                                </button>
                                <button
                                    type="button"
                                    onClick={() => galleryInputRef.current?.click()}
                                    className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 active:scale-[0.98] transition"
                                >
                                    <Images size={16} /> 从相册选择
                                </button>
                            </div>
                            {previewUrl && (
                                <div className="relative mt-2.5 w-28 h-28">
                                    <img src={previewUrl} className="w-28 h-28 rounded-xl object-cover ring-1 ring-black/5" alt="已选图片预览" />
                                    <button
                                        type="button"
                                        onClick={() => { URL.revokeObjectURL(previewUrl); setImageFile(null); setPreviewUrl(''); }}
                                        className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-800/90 text-white flex items-center justify-center shadow active:scale-90 transition"
                                        aria-label="移除图片"
                                    >
                                        <X size={13} weight="bold" />
                                    </button>
                                </div>
                            )}
                            <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { pickImage(e.target.files?.[0], 'camera'); e.target.value = ''; }} />
                            <input ref={galleryInputRef} type="file" accept="image/*" className="hidden" onChange={e => { pickImage(e.target.files?.[0], 'gallery'); e.target.value = ''; }} />
                        </div>
                    </div>
                    <div className="px-4 pt-1 pb-2 shrink-0">
                        <button
                            type="button"
                            disabled={sending || formInvalid || !formCharId}
                            onClick={handleSend}
                            className="w-full flex items-center justify-center gap-2 rounded-xl bg-rose-500 text-white py-3 text-sm font-bold shadow-lg shadow-rose-500/30 active:scale-[0.98] transition disabled:opacity-40 disabled:shadow-none"
                        >
                            <PaperPlaneRight size={16} weight="fill" />
                            {sending ? '送出中…' : '送出'}
                        </button>
                    </div>
                </div>
            </div>,
            document.body,
        );
    };

    return (
        <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-900">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2.5 shrink-0" style={{ paddingTop: 'max(0.625rem, var(--safe-top))' }}>
                <button onClick={closeApp} className="p-1.5 rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800 active:scale-95 transition" aria-label="返回">
                    <ArrowLeft size={20} />
                </button>
                <span className="text-base font-bold text-slate-800 dark:text-slate-100">礼物</span>
            </div>

            {/* Tabs：全部 / 收到 / 送出 */}
            <div className="px-3 shrink-0">
                <div className="flex gap-1 bg-slate-200/70 dark:bg-slate-800 rounded-full p-1">
                    {([['all', '全部'], ['received', '收到'], ['sent', '送出']] as const).map(([key, label]) => (
                        <button
                            key={key}
                            onClick={() => setTab(key)}
                            className={`flex-1 py-1.5 rounded-full text-xs font-semibold transition ${tab === key
                                ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm'
                                : 'text-slate-500 dark:text-slate-400'}`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 角色筛选（复用 giftStore charId 索引查询，多角色时才显示） */}
            {characters.length > 1 && (
                <div className="px-3 pt-2.5 shrink-0">
                    <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
                        <button
                            onClick={() => setCharFilter('all')}
                            className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium ring-1 transition ${charFilter === 'all'
                                ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 ring-slate-800 dark:ring-slate-200'
                                : 'bg-transparent text-slate-500 dark:text-slate-400 ring-black/10 dark:ring-white/15'}`}
                        >
                            全部角色
                        </button>
                        {characters.map(c => (
                            <button
                                key={c.id}
                                onClick={() => setCharFilter(c.id)}
                                className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium ring-1 transition ${charFilter === c.id
                                    ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 ring-slate-800 dark:ring-slate-200'
                                    : 'bg-transparent text-slate-500 dark:text-slate-400 ring-black/10 dark:ring-white/15'}`}
                            >
                                {c.name}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* 时间线：createdAt DESC（giftStore 已排序） */}
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
                {visibleGifts.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center gap-2.5 text-slate-400 dark:text-slate-500 pb-16">
                        <span className="text-4xl">🎁</span>
                        <span className="text-sm">还没有礼物记录</span>
                        <span className="text-xs">送出的、收到的礼物以后都会留在这里。</span>
                        <button
                            onClick={() => setSheetOpen(true)}
                            className="mt-1 px-4 py-2 rounded-full bg-rose-500 text-white text-xs font-bold shadow active:scale-95 transition"
                        >
                            送礼物
                        </button>
                    </div>
                ) : visibleGifts.map(renderTimelineCard)}
            </div>

            {/* FAB：送礼物 */}
            <button
                onClick={() => setSheetOpen(true)}
                className="absolute right-4 p-3.5 rounded-full bg-rose-500 text-white shadow-xl shadow-rose-500/40 flex items-center justify-center active:scale-95 transition z-20"
                style={{ bottom: 'max(1.25rem, calc(env(safe-area-inset-bottom) + 1rem))' }}
                aria-label="送礼物"
            >
                <Plus size={22} weight="bold" />
            </button>

            {renderSheet()}
            {viewer && (
                <ChatPhotoViewer
                    content={viewer.content}
                    displayUrl={viewer.displayUrl}
                    caption={viewer.caption}
                    onClose={() => setViewer(null)}
                />
            )}
        </div>
    );
};

export default Gift;
