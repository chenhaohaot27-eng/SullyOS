/**
 * ListenInviteCard — 聊天中的「一起听」邀请卡（listen_invite_card 消息，Batch B）。
 *
 * 数据来自 metadata.listen（utils/listenSessionShared.ListenInviteCardMeta）；
 * canonical 真相源是 music_listen_sessions —— 卡片 mount 时若状态仍是 pending/active
 * 会回读 session 兜底同步（避免 metadata 落后）。reopen 不重复执行任何动作（幂等守卫
 * 在 listenSession 层，这里再挡一层 busy/status 检查）。
 *
 * user → char：等待回应 / 已接受 / 已婉拒 / 已结束（由角色在正常回复里输出
 * [[MUSIC_LISTEN_RESPONSE:accept|decline]] 推进，卡片纯展示）。
 * char → user：pending 显示【一起听】【婉拒】两个按钮 —— 点击 0 Chat API，
 * 只写 session store + 卡片 metadata；角色下一轮凭历史状态知道结果。
 *
 * active 显示实时计时「正在一起听 · mm:ss」（setInterval 只刷 UI，不写 DB）；
 * ended 显示「本次一起听 X 分钟」。
 */

import React, { useEffect, useState } from 'react';
import { Headphones } from '@phosphor-icons/react';
import type { Message } from '../../types';
import { userRespondToCharacterInvite, getAllMusicListenSessions } from '../../utils/listenSession';
import { formatListenClock, formatListenDuration, type ListenInviteCardMeta } from '../../utils/listenSessionShared';

type CommonLayout = (node: React.ReactNode, extra?: any) => React.ReactNode;

const readListenMeta = (m: Message): ListenInviteCardMeta | null => {
    const listen = (m.metadata as any)?.listen;
    return listen && typeof listen === 'object' && typeof listen.sessionId === 'string'
        ? listen as ListenInviteCardMeta
        : null;
};

const ListenInviteCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: CommonLayout;
}> = ({ m, isUser, charName, commonLayout }) => {
    const meta = readListenMeta(m);
    const [status, setStatus] = useState<ListenInviteCardMeta['status']>(meta?.status || 'pending');
    const [durationSec, setDurationSec] = useState<number | undefined>(meta?.durationSec);
    const [startedAt, setStartedAt] = useState<number | undefined>(meta?.startedAt);
    const [busy, setBusy] = useState(false);
    const [, forceTick] = useState(0);

    const fromUser = meta?.inviter === 'user';

    // 真相源兜底：pending / active 的卡回读 session（metadata 偶发落后时不显示错状态）。
    useEffect(() => {
        if (!meta?.sessionId) return;
        if (status !== 'pending' && status !== 'active') return;
        let alive = true;
        void (async () => {
            try {
                const all = await getAllMusicListenSessions();
                const session = all.find(s => s.id === meta.sessionId);
                if (!alive || !session) return;
                setStatus(session.status);
                setStartedAt(session.startedAt);
                setDurationSec(session.durationSec);
            } catch { /* 保持 metadata 状态 */ }
        })();
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // active 时每秒刷新 UI 计时（不写 DB —— durationSec 真相只在结束时写一次）。
    useEffect(() => {
        if (status !== 'active') return;
        const timer = window.setInterval(() => forceTick(n => n + 1), 1000);
        return () => window.clearInterval(timer);
    }, [status]);

    if (!meta) return null; // 旧数据容错：无 listen 字段不渲染

    const handleRespond = async (accept: boolean) => {
        if (busy || status !== 'pending' || fromUser) return;
        setBusy(true);
        try {
            const session = await userRespondToCharacterInvite({ sessionId: meta.sessionId, accept });
            if (session) {
                setStatus(session.status);
                setStartedAt(session.startedAt);
                setDurationSec(session.durationSec);
            }
        } finally {
            setBusy(false);
        }
    };

    const songDesc = meta.song?.name
        ? `《${meta.song.name}》${meta.song.artists ? ` — ${meta.song.artists}` : ''}`
        : '一首歌';

    const liveClock = status === 'active' && typeof startedAt === 'number'
        ? formatListenClock(Math.max(0, (Date.now() - startedAt) / 1000))
        : null;

    /* __LISTEN_CARD_RENDER__ */
    return commonLayout(
        <div className="w-64 rounded-2xl overflow-hidden shadow-sm border bg-sky-50/80 dark:bg-sky-500/10 border-sky-100 dark:border-sky-500/20">
            {/* 卡头：发起者 + 歌曲 */}
            <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-2">
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm ${isUser ? 'bg-rose-100' : 'bg-sky-100 dark:bg-sky-500/20'}`}>🎧</span>
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">
                        {fromUser ? `你邀请${charName}一起听` : `${meta.inviterName || charName}的「一起听」邀请`}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{songDesc}</div>
                </div>
                {status === 'active' && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-300">
                        一起听中
                    </span>
                )}
            </div>
            {/* 状态 / 按钮区 */}
            <div className="px-3 pb-2.5 pt-1">
                {fromUser ? (
                    status === 'pending' ? (
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                            <Headphones size={11} /> 等待{charName}回应…
                        </div>
                    ) : status === 'active' ? (
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-500">
                            <Headphones size={11} /> {charName}接受了邀请 · 正在一起听{liveClock ? ` · ${liveClock}` : ''}
                        </div>
                    ) : status === 'declined' ? (
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                            <Headphones size={11} /> {charName}婉拒了这次邀请
                        </div>
                    ) : (
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                            <Headphones size={11} />
                            {status === 'interrupted' ? '这次一起听被中途打断' : `本次一起听 ${typeof durationSec === 'number' ? formatListenDuration(durationSec) : ''}`}
                        </div>
                    )
                ) : status === 'pending' ? (
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRespond(false)}
                            className="flex-1 py-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold active:scale-95 transition disabled:opacity-50"
                        >
                            婉拒
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRespond(true)}
                            className="flex-1 py-1.5 rounded-full bg-sky-500 text-white text-[11px] font-bold shadow active:scale-95 transition disabled:opacity-50"
                        >
                            一起听
                        </button>
                    </div>
                ) : status === 'active' ? (
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-500">
                        <Headphones size={11} /> 正在一起听{liveClock ? ` · ${liveClock}` : ''}
                    </div>
                ) : (
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                        <Headphones size={11} />
                        {status === 'declined'
                            ? '已婉拒这次邀请'
                            : status === 'interrupted'
                                ? '这次一起听被中途打断'
                                : `本次一起听 ${typeof durationSec === 'number' ? formatListenDuration(durationSec) : ''}`}
                    </div>
                )}
            </div>
        </div>,
    );
};

export default ListenInviteCard;
