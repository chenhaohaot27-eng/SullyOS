import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import type { MessageFavorite } from '../types';
import { useBlobRefUrl } from '../utils/blobRef';
import { GROUP_FILTER_ALL, GroupFilterChips } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';

/**
 * 留音海螺 —— 聊天消息收藏 App。
 * 玩家长按聊天里的文字 / 语音 / 图片收藏后，在这里回看。
 * 收藏是快照：原消息删除后仍保留；删除收藏只删记录，不动原消息。
 */

const TYPE_FILTERS: { id: 'all' | 'text' | 'voice' | 'image'; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'text', label: '文字' },
    { id: 'voice', label: '语音' },
    { id: 'image', label: '图片' },
];

const TYPE_LABELS: Record<MessageFavorite['favoriteType'], string> = {
    text: '文字',
    voice: '语音',
    image: '图片',
};

const formatFavoriteTime = (ts: number) => {
    const d = new Date(ts);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const date = `${d.getMonth() + 1}月${d.getDate()}日`;
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return sameYear ? `${date} ${time}` : `${d.getFullYear()}年${date} ${time}`;
};

/** 语音回放：从 assets store 恢复音频（Blob → objectURL；remoteUrl 直接用）。 */
const useFavoriteAudio = (fav: MessageFavorite | null) => {
    const [url, setUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const objUrlRef = useRef<string | null>(null);

    useEffect(() => {
        setUrl(null);
        if (!fav || fav.favoriteType !== 'voice' || !fav.mediaRef) return;
        let alive = true;
        setLoading(true);
        (async () => {
            try {
                const stored = await DB.getAssetRaw(fav.mediaRef) as { blob?: Blob; remoteUrl?: string } | null;
                if (!alive) return;
                if (stored?.blob instanceof Blob) {
                    const objUrl = URL.createObjectURL(stored.blob);
                    objUrlRef.current = objUrl;
                    setUrl(objUrl);
                } else if (stored?.remoteUrl) {
                    setUrl(stored.remoteUrl);
                }
            } catch { /* 音频已失联 → 只显示文字 */ }
            finally { if (alive) setLoading(false); }
        })();
        return () => {
            alive = false;
            if (objUrlRef.current) {
                try { URL.revokeObjectURL(objUrlRef.current); } catch { /* ignore */ }
                objUrlRef.current = null;
            }
        };
    }, [fav?.id, fav?.mediaRef, fav?.favoriteType]);

    return { url, loading };
};

const FavoriteVoicePlayer: React.FC<{ fav: MessageFavorite }> = ({ fav }) => {
    const { url, loading } = useFavoriteAudio(fav);
    if (loading) return <div className="text-[10px] text-slate-400">正在取回音频…</div>;
    if (!url) return <div className="text-[10px] text-amber-500/80">音频已失联，只留下文字回响</div>;
    return <audio controls preload="none" src={url} className="w-full max-w-[260px] h-9" />;
};

const FavoriteImage: React.FC<{ mediaRef?: string }> = ({ mediaRef }) => {
    const resolved = useBlobRefUrl(mediaRef);
    const [full, setFull] = useState(false);
    if (!mediaRef) return null;
    return (
        <>
            <button onClick={() => setFull(true)} className="block max-w-[240px] active:scale-[0.98] transition-transform">
                <img src={resolved || undefined} className="rounded-xl max-h-56 object-contain border border-white/10" loading="lazy" alt="收藏的图片" />
            </button>
            {full && (
                <div className="fixed inset-0 z-[200] bg-black/95 flex items-center justify-center" onClick={() => setFull(false)}>
                    <img src={resolved || undefined} className="max-w-full max-h-full object-contain" alt="收藏的图片" />
                    <button className="absolute top-6 right-6 w-10 h-10 rounded-full bg-white/10 text-white grid place-items-center" aria-label="关闭">✕</button>
                </div>
            )}
        </>
    );
};

const MessageFavoritesApp: React.FC = () => {
    const { characters, addToast } = useOS();
    const [favorites, setFavorites] = useState<MessageFavorite[]>([]);
    const [charFilter, setCharFilter] = useState<string>(GROUP_FILTER_ALL);
    const [typeFilter, setTypeFilter] = useState<'all' | 'text' | 'voice' | 'image'>('all');
    const [confirmDelete, setConfirmDelete] = useState<MessageFavorite | null>(null);
    const [loaded, setLoaded] = useState(false);

    const reload = useCallback(async () => {
        try {
            const rows = await DB.getMessageFavorites();
            rows.sort((a, b) => b.favoritedAt - a.favoritedAt);
            setFavorites(rows);
        } catch {
            setFavorites([]);
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => { void reload(); }, [reload]);

    // 出现过的角色（角色可能已删 → 用 charNameSnapshot 兜底显示）
    const charChips = useMemo(() => {
        const byChar = new Map<string, { id: string; label: string; count: number }>();
        for (const fav of favorites) {
            const char = characters.find(c => c.id === fav.charId);
            const key = char ? char.id : fav.charId;
            const existing = byChar.get(key);
            if (existing) existing.count += 1;
            else byChar.set(key, { id: key, label: char?.name || fav.charNameSnapshot || '未知角色', count: 1 });
        }
        return [
            { id: GROUP_FILTER_ALL, label: '全部角色', count: favorites.length },
            ...[...byChar.values()].sort((a, b) => b.count - a.count),
        ];
    }, [favorites, characters]);

    const visible = useMemo(() => favorites.filter(fav =>
        (charFilter === GROUP_FILTER_ALL || fav.charId === charFilter)
        && (typeFilter === 'all' || fav.favoriteType === typeFilter),
    ), [favorites, charFilter, typeFilter]);

    const handleUnfavorite = useCallback(async (fav: MessageFavorite) => {
        // 删除收藏只删记录，绝不触碰原聊天消息 / 音频 / 图片资产
        await DB.deleteMessageFavorite(fav.id);
        setFavorites(prev => prev.filter(item => item.id !== fav.id));
        setConfirmDelete(null);
        addToast('已取消收藏', 'success');
        trackEvent('取消一条留音海螺收藏');
    }, [addToast]);

    return (
        <div className="h-full w-full flex flex-col bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950/60 text-white">
            {/* Header */}
            <div className="shrink-0 px-4 pb-3 border-b border-white/10 sticky top-0 z-10 backdrop-blur-xl bg-slate-950/60" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="h-14 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-400/80 to-indigo-500/80 grid place-items-center shadow-lg shadow-indigo-500/30">
                        <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                            <path d="M4 12h2m12 0h2M8 12a4 4 0 0 1 8 0v5a3 3 0 0 1-6 0v-5" />
                            <path d="M6 9a6 6 0 0 1 12 0" />
                        </svg>
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-base font-semibold tracking-wide">留音海螺</h1>
                        <p className="text-[10px] text-white/40 -mt-0.5">长按聊天里的消息收藏，把喜欢的话留在这里</p>
                    </div>
                    <span className="ml-auto text-xs text-white/40 tabular-nums">{favorites.length}</span>
                </div>
                <div className="pb-2">
                    <GroupFilterChips dark chips={charChips} value={charFilter} onChange={setCharFilter} />
                </div>
                <div className="flex gap-1.5">
                    {TYPE_FILTERS.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTypeFilter(t.id)}
                            className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all active:scale-95 ${typeFilter === t.id ? 'bg-cyan-400/90 text-slate-900 border-cyan-300' : 'bg-white/[0.06] text-white/60 border-white/15'}`}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto min-h-0 px-4 py-4 pb-8">
                {loaded && favorites.length === 0 && (
                    <div className="h-full grid place-items-center">
                        <div className="text-center px-8">
                            <div className="text-4xl mb-3">🐚</div>
                            <p className="text-sm text-white/70 font-medium">还没有收藏</p>
                            <p className="text-[11px] text-white/40 mt-2 leading-relaxed">在聊天里长按一条文字 / 语音 / 图片，<br />选「收藏」，它就会漂到这只海螺里。</p>
                        </div>
                    </div>
                )}
                {loaded && favorites.length > 0 && visible.length === 0 && (
                    <div className="py-12 text-center text-[11px] text-white/40">这个筛选下没有收藏</div>
                )}
                <div className="flex flex-col gap-3 max-w-2xl mx-auto">
                    {visible.map(fav => {
                        const char = characters.find(c => c.id === fav.charId);
                        return (
                            <div key={fav.id} className="rounded-2xl bg-white/[0.06] border border-white/10 p-3.5 backdrop-blur-sm">
                                <div className="flex items-center gap-2.5">
                                    {char?.avatar
                                        ? <img src={char.avatar} className="w-8 h-8 rounded-full object-cover border border-white/20" alt="" />
                                        : <span className="w-8 h-8 rounded-full bg-white/10 grid place-items-center text-xs font-serif">{(char?.name || fav.charNameSnapshot || '?').slice(0, 1)}</span>}
                                    <div className="min-w-0 flex-1">
                                        <div className="text-xs font-semibold truncate">{char?.name || fav.charNameSnapshot || '未知角色'}</div>
                                        <div className="text-[10px] text-white/40">
                                            {fav.messageRole === 'user' ? '我' : 'TA'} · {TYPE_LABELS[fav.favoriteType]} · 原始 {formatFavoriteTime(fav.originalTimestamp)}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setConfirmDelete(fav)}
                                        className="w-8 h-8 shrink-0 rounded-full grid place-items-center text-white/30 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                                        title="取消收藏（不影响原聊天消息）"
                                        aria-label="取消收藏"
                                    >
                                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 18 18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                                <div className="mt-2.5">
                                    {fav.favoriteType === 'image' ? (
                                        <FavoriteImage mediaRef={fav.mediaRef} />
                                    ) : fav.favoriteType === 'voice' ? (
                                        <div className="flex flex-col gap-2">
                                            {fav.contentSnapshot && <p className="text-[13px] leading-relaxed text-white/85 whitespace-pre-wrap break-words select-text">{fav.contentSnapshot}</p>}
                                            <FavoriteVoicePlayer fav={fav} />
                                        </div>
                                    ) : (
                                        <p className="text-[13px] leading-relaxed text-white/85 whitespace-pre-wrap break-words select-text">{fav.contentSnapshot || '（无文字内容）'}</p>
                                    )}
                                </div>
                                <div className="mt-2 text-[10px] text-cyan-300/50">收藏于 {formatFavoriteTime(fav.favoritedAt)}</div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {confirmDelete && (
                <div className="fixed inset-0 z-[150] flex items-end justify-center bg-slate-950/60" onClick={() => setConfirmDelete(null)} role="presentation">
                    <div className="w-full sm:max-w-sm rounded-t-[28px] bg-slate-900 border border-white/10 p-5 shadow-2xl" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
                        <h2 className="text-sm font-semibold">取消这条收藏？</h2>
                        <p className="mt-2 text-[11px] leading-5 text-white/50">只删除留音海螺里的这条收藏记录，原聊天消息不受影响。</p>
                        <div className="mt-5 grid grid-cols-2 gap-3">
                            <button onClick={() => setConfirmDelete(null)} className="h-12 rounded-2xl border border-white/15 text-xs font-bold text-white/70">保留</button>
                            <button onClick={() => void handleUnfavorite(confirmDelete)} className="h-12 rounded-2xl bg-rose-600 text-white text-xs font-bold">取消收藏</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MessageFavoritesApp;

