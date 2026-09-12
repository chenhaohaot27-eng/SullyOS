import React, { useState } from 'react';
import Modal from '../os/Modal';
import { useMusic } from '../../context/MusicContext';
import {
    parseNeteaseSongId,
    isNeteaseShortLink,
    resolveSharedSong,
    type SharedMusicSong,
} from '../../utils/musicShare';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    charName: string;
    /** 拿到完整歌曲快照后回调（由 Chat.tsx 落库 —— 那条链路 0 模型调用）。 */
    onShare: (song: SharedMusicSong, shareUrl?: string) => Promise<void> | void;
}

const formatDuration = (sec: number): string => {
    if (!sec || sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * 聊天「分享音乐」弹窗：粘贴网易云链接 / songId → 解析 → 预览 → 确认分享。
 * 全程只有 /netease/* 普通 HTTP 请求（走现有 Worker 代理），没有任何 LLM 调用。
 */
const MusicShareModal: React.FC<Props> = ({ isOpen, onClose, charName, onShare }) => {
    const { cfg } = useMusic();
    const [input, setInput] = useState('');
    const [resolving, setResolving] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');
    const [preview, setPreview] = useState<SharedMusicSong | null>(null);

    const reset = () => {
        setInput('');
        setResolving(false);
        setSending(false);
        setError('');
        setPreview(null);
    };

    const handleClose = () => {
        if (resolving || sending) return;
        reset();
        onClose();
    };

    // 粘贴/输入 → 解析 songId → 拉 song detail 出预览
    const handleResolve = async () => {
        if (resolving) return;
        setError('');
        setPreview(null);
        const raw = input.trim();
        if (!raw) return;
        if (isNeteaseShortLink(raw)) {
            setError('暂不支持 163cn.tv 短链，请打开歌曲页复制完整链接，或直接输入歌曲 ID。');
            return;
        }
        const songId = parseNeteaseSongId(raw);
        if (songId == null) {
            setError('没有识别到网易云歌曲，请检查链接或歌曲 ID。');
            return;
        }
        setResolving(true);
        try {
            const song = await resolveSharedSong(cfg, songId);
            setPreview(song);
        } catch (e) {
            console.warn('[MusicShare] song/detail 拉取失败:', e);
            setError('暂时无法获取这首歌，请稍后再试。');
        } finally {
            setResolving(false);
        }
    };

    // 确认分享 → 只落一张 music_card，不调任何模型（见 Chat.tsx shareMusicMessage）
    const handleShare = async () => {
        if (!preview || sending) return;
        setSending(true);
        try {
            await onShare(preview, `https://music.163.com/song?id=${preview.songId}`);
            reset();
            onClose();
        } catch (e) {
            console.warn('[MusicShare] 保存分享卡片失败:', e);
            setError('分享失败，请稍后再试。');
        } finally {
            setSending(false);
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            title="分享音乐"
            footer={
                <div className="flex gap-2">
                    <button
                        onClick={handleClose}
                        disabled={resolving || sending}
                        className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-500 text-sm font-bold active:scale-95 transition disabled:opacity-50"
                    >
                        取消
                    </button>
                    <button
                        onClick={() => void handleShare()}
                        disabled={!preview || sending}
                        className="flex-1 py-2.5 rounded-xl bg-rose-400 text-white text-sm font-bold shadow active:scale-95 transition disabled:opacity-50"
                    >
                        {sending ? '分享中...' : `分享给${charName}`}
                    </button>
                </div>
            }
        >
            <div className="space-y-2">
                <p className="text-xs text-slate-500 leading-relaxed">
                    粘贴网易云音乐歌曲链接或歌曲 ID，确认后卡片会出现在聊天里；{charName}会在你下一次让 TA 回复时看到这首歌。
                </p>
                <div className="flex gap-2">
                    <input
                        value={input}
                        onChange={e => { setInput(e.target.value); setError(''); }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleResolve(); } }}
                        placeholder="https://music.163.com/song?id=..."
                        className="flex-1 bg-slate-50 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-rose-300"
                        disabled={resolving || sending}
                    />
                    <button
                        onClick={() => void handleResolve()}
                        disabled={resolving || sending || !input.trim()}
                        className="px-4 rounded-xl bg-slate-800 text-white text-sm font-bold active:scale-95 transition disabled:opacity-40"
                    >
                        {resolving ? '解析中' : '解析'}
                    </button>
                </div>
                {error && <div className="text-xs text-rose-500 leading-relaxed">{error}</div>}

                {preview && (
                    <div className="mt-1 rounded-2xl overflow-hidden border" style={{ borderColor: '#f3d9e6', background: 'linear-gradient(135deg, #fff2f7 0%, #f5edff 55%, #eaf1ff 100%)' }}>
                        <div className="flex gap-3 p-3">
                            {preview.albumPic ? (
                                <img
                                    src={preview.albumPic}
                                    alt=""
                                    className="w-16 h-16 rounded-xl object-cover shrink-0"
                                    referrerPolicy="no-referrer"
                                    onError={(e: any) => { e.target.style.display = 'none'; }}
                                />
                            ) : (
                                <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl"
                                    style={{ background: 'linear-gradient(135deg, #8b7ab8 0%, #6b95c7 100%)', color: 'rgba(255,255,255,0.9)' }}>
                                    ♪
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="font-bold text-sm truncate" style={{ color: '#2a1f4d' }}>{preview.name}</div>
                                <div className="text-[11px] mt-0.5 truncate" style={{ color: '#6b5b8f' }}>{preview.artists || '—'}</div>
                                <div className="text-[10px] mt-0.5 truncate" style={{ color: '#8d7fb3' }}>
                                    {preview.album ? `专辑：${preview.album}` : ''}
                                    {formatDuration(preview.duration) ? ` · ${formatDuration(preview.duration)}` : ''}
                                </div>
                                <div className="text-[10px] mt-1" style={{ color: '#5a49a8' }}>来源：网易云音乐</div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </Modal>
    );
};

export default MusicShareModal;
