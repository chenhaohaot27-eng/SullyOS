import React, { useState } from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import type { Song } from '../../context/MusicContext';
import { songToSharedSnapshot, shareSongToCharacter } from '../../utils/musicShare';
import { trackEvent } from '../../utils/analytics';

interface Props {
    open: boolean;
    song: Song | null;
    onClose: () => void;
}

/**
 * 音乐 App「分享给角色」的角色选择面板。
 * 复用 useOS().characters（与聊天转发面板同一数据源/同一筛选口径），选中即落
 * user 方向 music_card（utils/musicShare.shareSongToCharacter，0 LLM）。
 * 分享后留在音乐 App，只 toast，不跳聊天页。
 */
const ShareSongToCharModal: React.FC<Props> = ({ open, song, onClose }) => {
    const { characters, addToast } = useOS();
    const [sharing, setSharing] = useState(false);

    const handlePick = async (charId: string, charName: string) => {
        if (!song || sharing) return;
        setSharing(true);
        try {
            const snapshot = songToSharedSnapshot(song);
            if (!snapshot) {
                addToast('暂时只支持分享网易云歌曲', 'info');
                onClose();
                return;
            }
            const saved = await shareSongToCharacter({ song: snapshot, charId, shareOrigin: 'music_app' });
            if (saved != null) {
                trackEvent('分享音乐卡片', { from: 'music_app' });
                addToast(`已分享给${charName}`, 'success');
                onClose();
            } else {
                addToast('分享失败，请稍后再试', 'error');
            }
        } catch (e) {
            console.warn('[MusicShare] 音乐 App 分享失败:', e);
            addToast('分享失败，请稍后再试', 'error');
        } finally {
            setSharing(false);
        }
    };

    return (
        <Modal isOpen={open} title="分享给角色" onClose={sharing ? () => { /* 落库中 */ } : onClose}>
            <div className="space-y-2 max-h-64 overflow-y-auto">
                <p className="text-xs text-slate-400 mb-1">
                    {song ? `把《${song.name}》分享给谁？TA 会在下一次回复时听到这首歌。` : '选择要分享给的角色'}
                </p>
                {characters.map(c => (
                    <button
                        key={c.id}
                        onClick={() => void handlePick(c.id, c.name)}
                        disabled={sharing}
                        className="w-full flex items-center gap-3 p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 active:scale-[0.98] transition-all border border-slate-100 disabled:opacity-50"
                    >
                        <img src={c.avatar} className="w-10 h-10 rounded-xl object-cover" alt="" />
                        <div className="flex-1 text-left">
                            <div className="font-bold text-sm text-slate-700">{c.name}</div>
                        </div>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                    </button>
                ))}
                {characters.length === 0 && (
                    <div className="text-center text-xs text-slate-400 py-8">还没有可以聊天的角色</div>
                )}
            </div>
        </Modal>
    );
};

export default ShareSongToCharModal;
