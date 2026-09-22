/**
 * TogetherListenModal —— Music App「和 ta 一起听」的角色选择面板（Batch B）。
 *
 * 前提：当前有正在播放 / 已选中的歌（调用方保证）。选中角色 → 落一张 user→character
 * pending「一起听」邀请卡到该角色私聊 + music_listen_sessions 建 pending session。
 * 全程 0 LLM、0 额外 Chat 调用；角色的接受 / 婉拒由下一轮正常回复输出
 * [[MUSIC_LISTEN_RESPONSE:accept|decline]] 推进。
 *
 * 已有 active session（正在一起听）或已有 pending 邀请的角色置灰，防重复。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { X, Headphones } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { createUserListenInvite, getAllMusicListenSessions, LISTEN_SESSIONS_CHANGED_EVENT } from '../../utils/listenSession';
import { trackEvent } from '../../utils/analytics';

export interface TogetherListenSong {
    id?: number;
    name: string;
    artists: string;
    album?: string;
    albumPic?: string;
}

const TogetherListenModal: React.FC<{
    song: TogetherListenSong;
    userName?: string;
    onClose: () => void;
}> = ({ song, userName, onClose }) => {
    const { characters, addToast } = useOS();
    const [busyId, setBusyId] = useState<string | null>(null);
    // charId → 该角色当前的 session 态（active = 正在听；pending = 邀请待回应）
    const [sessionState, setSessionState] = useState<Record<string, 'active' | 'pending'>>({});

    const refreshSessions = async () => {
        try {
            const sessions = await getAllMusicListenSessions();
            const next: Record<string, 'active' | 'pending'> = {};
            for (const s of sessions) {
                if (s.status === 'active') next[s.charId] = 'active';
                else if (s.status === 'pending' && !next[s.charId]) next[s.charId] = 'pending';
            }
            setSessionState(next);
        } catch { /* 忽略，按钮态按已知信息 */ }
    };

    useEffect(() => {
        void refreshSessions();
        const handler = () => void refreshSessions();
        window.addEventListener(LISTEN_SESSIONS_CHANGED_EVENT, handler);
        return () => window.removeEventListener(LISTEN_SESSIONS_CHANGED_EVENT, handler);
    }, []);

    const songDesc = useMemo(
        () => `《${song.name}》${song.artists ? ` — ${song.artists}` : ''}`,
        [song.name, song.artists],
    );

    /* __TOGETHER_RENDER__ */
    const pick = async (charId: string) => {
        const char = characters.find(c => c.id === charId);
        if (!char || busyId) return;
        setBusyId(charId);
        try {
            const created = await createUserListenInvite({ char, userName, song });
            if (created) {
                trackEvent('发起一起听邀请', { via: 'music_app' });
                addToast(`已向${char.name}发出一起听邀请`, 'success');
                onClose();
            } else {
                addToast(`${char.name}已有进行中的一起听`, 'info');
                void refreshSessions();
            }
        } catch {
            addToast('邀请失败，请重试', 'error');
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(15,10,30,0.45)', backdropFilter: 'blur(6px)' }}
            onClick={onClose}
        >
            <div className="w-full max-w-sm rounded-3xl p-4 shizuku-glass-strong"
                style={{ boxShadow: '0 8px 40px rgba(80,40,120,0.25)' }}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-start justify-between mb-1">
                    <div>
                        <div className="text-sm font-bold flex items-center gap-1.5" style={{ color: '#5b4a6e' }}>
                            <Headphones size={15} /> 和 ta 一起听
                        </div>
                        <div className="text-[11px] mt-0.5 truncate opacity-70" style={{ color: '#7a6b8a' }}>
                            邀请发出后，ta 会在聊天里回应 · {songDesc}
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1 rounded-full hover:bg-black/5">
                        <X size={16} />
                    </button>
                </div>
                <div className="mt-2 max-h-[46vh] overflow-y-auto space-y-1.5 pr-0.5">
                    {characters.length === 0 && (
                        <div className="text-center text-[11px] py-6" style={{ color: '#9a8fa8' }}>还没有角色</div>
                    )}
                    {characters.map(c => {
                        const state = sessionState[c.id];
                        const disabled = !!state || !!busyId;
                        return (
                            <button
                                key={c.id}
                                disabled={disabled}
                                onClick={() => void pick(c.id)}
                                className="w-full flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left transition active:scale-[0.98] disabled:opacity-55"
                                style={{ background: 'rgba(255,255,255,0.55)', border: '1px solid rgba(120,90,150,0.15)' }}
                            >
                                {c.avatar
                                    ? <img src={c.avatar} className="w-9 h-9 rounded-full object-cover" alt="" />
                                    : <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm bg-purple-100">{c.name?.[0] || '?'}</div>}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13px] font-semibold truncate" style={{ color: '#4a3d5c' }}>{c.name}</div>
                                    <div className="text-[10px] truncate" style={{ color: '#9a8fa8' }}>
                                        {state === 'active' ? '正在一起听' : state === 'pending' ? '邀请待回应' : '发送一起听邀请'}
                                    </div>
                                </div>
                                {busyId === c.id
                                    ? <span className="text-[10px]" style={{ color: '#9a8fa8' }}>发送中…</span>
                                    : !state && <span className="text-[10px] font-bold" style={{ color: '#8b6fc0' }}>邀请</span>}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default TogetherListenModal;
