import React, { useCallback, useEffect, useState } from 'react';
import { useMusic, Song } from '../../context/MusicContext';
import { useOS } from '../../context/OSContext';
import { qqApi, type QQMusicProfile } from '../../utils/musicProviders/qq';
import { getSongIdentity } from '../../utils/musicProviders/types';
import { trackEvent } from '../../utils/analytics';
import { C, Sparkle, MizuHeader, SongRow, BokehBg } from './MusicUI';

/**
 * QQProfilePage：QQ音乐 provider 下的「我的」页面。
 *
 * 与 NeteaseProfilePage 保持同等核心体验：头像 / 昵称 / 我的歌单 / 歌单详情 / 播放 / 分享。
 * 网易云专属且 QQ 无严格等价物的入口（云盘 / 每日签到 / 私人FM / 每日推荐）不伪造、直接不展示。
 * QQ 专属说明：喜欢的歌 = 「我喜欢」歌单（dirid 201）。
 */
const QQProfilePage: React.FC<{
  onBack: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onShareSong: (song: Song) => void;
}> = ({ onBack, onOpenSearch, onOpenSettings, onShareSong }) => {
  const { addToast } = useOS();
  const { cfg, setCfg, effectiveWorkerUrl, playSong, current, profile } = useMusic();
  const [qqProfile, setQqProfile] = useState<QQMusicProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [openList, setOpenList] = useState<{ name: string; songs: Song[] } | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  const resolveBase = useCallback(() => effectiveWorkerUrl, [effectiveWorkerUrl]);

  useEffect(() => {
    if (!cfg.qq?.cookie) { setQqProfile(null); return; }
    setLoading(true);
    qqApi.profile(cfg, resolveBase)
      .then(p => setQqProfile(p))
      .catch(() => setQqProfile(null))
      .finally(() => setLoading(false));
  }, [cfg, resolveBase]);

  const openPlaylist = async (id: string, name: string) => {
    setLoadingList(true);
    trackEvent('打开QQ音乐歌单');
    try {
      const pl = await qqApi.playlistTracks(cfg, resolveBase, id);
      setOpenList({ name: pl.name || name, songs: pl.songs });
    } catch (e: any) {
      addToast(`歌单加载失败：${e.message}`, 'error');
    } finally {
      setLoadingList(false);
    }
  };

  const qqLogout = () => {
    setCfg({ ...cfg, qq: { cookie: '' } });
    setQqProfile(null);
    addToast('已退出 QQ音乐登录', 'success');
    trackEvent('退出QQ音乐登录');
  };

  const fmtTime = (s: number) => {
    if (!isFinite(s) || s < 0) s = 0;
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title="QQ音乐 · 我的" onBack={onBack} />

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 relative z-10 shizuku-scrollbar">
        {/* 用户卡片 */}
        {!cfg.qq?.cookie ? (
          <div className="rounded-2xl p-4 shizuku-glass text-center space-y-2">
            <Sparkle size={14} color={C.glow} delay={0} />
            <div className="text-xs" style={{ color: C.muted }}>还未登录 QQ音乐</div>
            <button onClick={onOpenSettings}
              className="px-4 py-2 rounded-full text-[11px] text-white"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
              登录 QQ音乐
            </button>
            <div className="text-[9px] italic" style={{ color: C.faint }}>
              在「设置 → QQ音乐 Cookie 登录」里粘贴 y.qq.com 的 Cookie；不涉及 QQ 密码
            </div>
          </div>
        ) : (
          <div className="rounded-2xl p-4 shizuku-glass flex items-center gap-3">
            {qqProfile?.avatarUrl ? (
              <img src={qqProfile.avatarUrl} alt="" className="w-12 h-12 rounded-full object-cover" style={{ border: `1px solid ${C.glow}40` }} />
            ) : (
              <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: `${C.primary}15` }}>
                <Sparkle size={14} color={C.primary} delay={0} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: C.primary }}>
                {loading ? '加载中…' : (qqProfile?.nickname || profile?.nickname || 'QQ音乐用户')}
              </div>
              <div className="text-[9px]" style={{ color: C.faint }}>QQ音乐 · uin {qqProfile?.uin || '—'}</div>
            </div>
            <button onClick={qqLogout}
              className="text-[10px] px-2.5 py-1 rounded-full active:scale-95"
              style={{ background: `${C.vip}15`, border: `1px solid ${C.vip}30`, color: C.vip }}>
              退出登录
            </button>
          </div>
        )}

        {/* 歌单详情 */}
        {openList && (
          <div className="rounded-2xl p-3.5 shizuku-glass space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold truncate" style={{ color: C.primary }}>{openList.name}</div>
              <button onClick={() => setOpenList(null)} className="text-[10px]" style={{ color: C.faint }}>收起</button>
            </div>
            {loadingList ? (
              <div className="text-[10px] text-center py-4" style={{ color: C.faint }}>加载中…</div>
            ) : (
              openList.songs.map(s => (
                <SongRow
                  key={getSongIdentity(s)}
                  name={s.name}
                  artists={s.artists}
                  album={s.album}
                  albumPic={s.albumPic}
                  duration={fmtTime(s.duration)}
                  isVip={s.fee === 1}
                  isActive={!!current && getSongIdentity(current) === getSongIdentity(s)}
                  onClick={() => { playSong(s, { replaceQueue: openList.songs, startIdx: openList.songs.indexOf(s) }); trackEvent('播放QQ音乐歌单曲目'); }}
                  onMore={() => onShareSong(s)}
                />
              ))
            )}
          </div>
        )}

        {/* 我的歌单 */}
        {qqProfile && qqProfile.playlists.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.lavender} delay={0.8} /> 我的歌单
            </div>
            {qqProfile.playlists.map(pl => (
              <button key={pl.id} onClick={() => openPlaylist(pl.id, pl.name)}
                className="w-full rounded-2xl p-2.5 flex items-center gap-3 shizuku-glass active:scale-[0.99] transition-all text-left">
                {pl.cover ? (
                  <img src={pl.cover} alt="" className="w-11 h-11 rounded-xl object-cover" />
                ) : (
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: `${C.lavender}20` }}>
                    <Sparkle size={10} color={C.lavender} delay={0} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium truncate" style={{ color: C.text }}>{pl.name}</div>
                  <div className="text-[9px]" style={{ color: C.faint }}>{pl.count} 首</div>
                </div>
                <span className="text-[10px]" style={{ color: C.faint }}>›</span>
              </button>
            ))}
          </div>
        )}

        {cfg.qq?.cookie && !loading && qqProfile && qqProfile.playlists.length === 0 && (
          <div className="text-center text-[10px] py-6" style={{ color: C.faint }}>这个账号还没有公开歌单</div>
        )}

        <div className="text-[9px] italic text-center leading-relaxed" style={{ color: C.faint }}>
          QQ音乐下暂不提供云盘 / 每日签到 / 私人FM 等网易云专属入口（不伪造）。
          本地生成的「一起写的歌」在网易云页签查看，不受平台切换影响。
        </div>
      </div>
    </div>
  );
};

export default QQProfilePage;
