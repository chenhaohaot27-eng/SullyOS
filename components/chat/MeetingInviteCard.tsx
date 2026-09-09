/**
 * MeetingInviteCard — 聊天中的「见面邀请」卡（meet_card 消息的渲染组件）。
 *
 * 数据全部来自 metadata.meet（MeetingInvitation）；前端只做视觉骨架、按钮与跳转，
 * 正文（invitationText / locationText / timeText）一律是模型产出，绝不拼接。
 * 状态：pending 显示「婉拒 / 去见TA」两个按钮（busy 防双击）；
 * 婉拒 → declined（留在聊天，角色经历史 [邀请记录] 知道被婉拒）；
 * 去见TA → accepted + 经 meetingInviteLaunch 跳转见面（DateApp 侧做陪伴/剧情选择）。
 * 头像/名字优先快照（角色已删除也不崩），兜底 characters 注册表实时查。
 * scheduled 邀请展示 meetingMode 标签与 scheduledAt 的人类可读时间。
 */

import React, { useMemo, useState } from 'react';
import { CalendarX, MapPin, Clock } from '@phosphor-icons/react';
import type { Message } from '../../types';
import { useOS } from '../../context/OSContext';
import { readMeetInvitation, updateMeetInviteStatus, meetingInviteLaunch, meetInviteDirection, parseMeetTimestamp, type MeetingInviteStatus } from '../../utils/meetingInvite';

type CommonLayout = (node: React.ReactNode, extra?: any) => React.ReactNode;

const STATUS_LABEL: Partial<Record<MeetingInviteStatus, string>> = {
    accepted: '已接受',
    deferred: '稍后见',
    declined: '已婉拒',
    expired: '已过期',
    cancelled: '已取消',
};

/** scheduledAt → 「M月D日 HH:mm」；不可解析时回退原文。 */
const formatScheduleText = (raw?: string): string => {
    const parsed = parseMeetTimestamp(raw);
    if (!parsed) return raw || '';
    const d = new Date(parsed);
    if (Number.isNaN(d.getTime())) return raw || '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const MeetingInviteCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: CommonLayout;
}> = ({ m, isUser, charName, commonLayout }) => {
    const invitation = readMeetInvitation(m);
    const { openDateWithChar } = useOS();
    const [status, setStatus] = useState<MeetingInviteStatus>(invitation?.status || 'pending');
    const [busy, setBusy] = useState(false);
    // 双向协议：玩家→角色的邀请由角色回应；玩家可取消，接受后可从卡上直接进入陪伴/剧情。
    const fromPlayer = meetInviteDirection(invitation) === 'user_to_character';

    const participantsText = useMemo(() => {
        if (!invitation) return '';
        const names = invitation.participantNames?.length ? invitation.participantNames : [invitation.initiatorName];
        return names.join('、');
    }, [invitation]);

    if (!invitation) return null; // 旧数据容错：无 meet 字段不渲染

    const handleDecline = async () => {
        if (busy || status !== 'pending') return;
        setBusy(true);
        try {
            setStatus('declined');
            await updateMeetInviteStatus(m.id, 'declined');
        } finally {
            setBusy(false);
        }
    };

    const handleAccept = async () => {
        if (busy || status !== 'pending' || fromPlayer) return;
        setBusy(true);
        try {
            setStatus('accepted');
            await updateMeetInviteStatus(m.id, 'accepted');
            // 主见面角色：participants 第一个；兜底来源聊天角色。
            // primaryCharId 由 DateApp 侧再解析一次注册表（携带完整 invitation）。
            meetingInviteLaunch.request({
                invitation,
                primaryCharId: invitation.participantIds?.[0] || invitation.sourceCharId,
                participantsText,
            });
        } finally {
            setBusy(false);
        }
    };

    // 玩家邀请：取消（pending → cancelled，不物理删除历史）
    const handleCancelInvite = async () => {
        if (busy || status !== 'pending' || !fromPlayer) return;
        setBusy(true);
        try {
            setStatus('cancelled');
            await updateMeetInviteStatus(m.id, 'cancelled');
        } finally {
            setBusy(false);
        }
    };

    // 玩家邀请被接受后：直接指定赴约方式进入现有见面链路（surface 让 DateApp 跳过选择层）
    const handleEnterSurface = async (surface: 'companion' | 'story') => {
        if (busy || status !== 'accepted' || !fromPlayer) return;
        setBusy(true);
        try {
            const primaryCharId = invitation.participantIds?.[0] || invitation.sourceCharId;
            meetingInviteLaunch.request({ invitation, primaryCharId, participantsText, surface });
            openDateWithChar(primaryCharId);
        } finally {
            setBusy(false);
        }
    };

    return commonLayout(
        <div className="w-64 rounded-2xl overflow-hidden shadow-sm border bg-violet-50/80 dark:bg-violet-500/10 border-violet-100 dark:border-violet-500/20">
            {/* 卡头：发起者 */}
            <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-2">
                {!fromPlayer && invitation.initiatorAvatar
                    ? <img src={invitation.initiatorAvatar} className="w-7 h-7 rounded-full object-cover ring-1 ring-black/5" alt="" />
                    : <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm ${isUser ? 'bg-rose-100' : 'bg-violet-100 dark:bg-violet-500/20'}`}>🤝</span>}
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">
                        {fromPlayer
                            ? `你邀请${participantsText || charName}见面`
                            : `${invitation.initiatorName || charName}的见面邀请`}
                    </div>
                    {!fromPlayer && participantsText && participantsText !== invitation.initiatorName && (
                        <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">见面对象：{participantsText}</div>
                    )}
                </div>
                {invitation.meetingMode && !fromPlayer && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-violet-100 dark:bg-violet-500/20 text-violet-600 dark:text-violet-300">
                        {invitation.meetingMode === 'scheduled' ? '约好时间' : '现在见面'}
                    </span>
                )}
            </div>
            {/* 正文：模型生成的邀请原话 */}
            <div className="px-3 pb-2 space-y-1.5">
                <p className="text-[13px] leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">
                    {invitation.invitationText}
                </p>
                {invitation.locationText && (
                    <div className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                        <MapPin size={11} /> <span className="break-all">{invitation.locationText}</span>
                    </div>
                )}
                {invitation.timeText && (
                    <div className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
                        <Clock size={11} /> {invitation.timeText}
                    </div>
                )}
                {formatScheduleText(invitation.scheduledAt) && (
                    <div className="flex items-center gap-1 text-[10px] text-violet-500 dark:text-violet-300">
                        <Clock size={11} /> 预定：{formatScheduleText(invitation.scheduledAt)}
                    </div>
                )}
            </div>
            {/* 操作 / 状态 */}
            <div className="px-3 pb-2.5">
                {fromPlayer ? (
                    // 玩家→角色：等待角色回应；接受后可直接进入陪伴/剧情；可取消
                    status === 'pending' ? (
                        <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                                <Clock size={11} /> 等待回应
                            </div>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={handleCancelInvite}
                                className="w-full py-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold active:scale-95 transition disabled:opacity-50"
                            >
                                取消邀请
                            </button>
                        </div>
                    ) : status === 'accepted' ? (
                        <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-500">
                                <CalendarX size={11} /> {participantsText || charName}已接受邀请
                            </div>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleEnterSurface('companion')}
                                    className="flex-1 py-1.5 rounded-full bg-violet-500 text-white text-[11px] font-bold shadow active:scale-95 transition disabled:opacity-50"
                                >
                                    进入陪伴
                                </button>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleEnterSurface('story')}
                                    className="flex-1 py-1.5 rounded-full bg-white dark:bg-slate-700 text-violet-600 dark:text-violet-300 text-[11px] font-bold ring-1 ring-violet-200 dark:ring-violet-500/30 active:scale-95 transition disabled:opacity-50"
                                >
                                    进入剧情
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                            <CalendarX size={11} /> {status === 'declined' ? `${participantsText || charName}婉拒了这次邀请` : status === 'deferred' ? `${participantsText || charName}想改个时间` : STATUS_LABEL[status] || status}
                        </div>
                    )
                ) : status === 'pending' ? (
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={handleDecline}
                            className="flex-1 py-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold active:scale-95 transition disabled:opacity-50"
                        >
                            婉拒
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={handleAccept}
                            className="flex-1 py-1.5 rounded-full bg-violet-500 text-white text-[11px] font-bold shadow active:scale-95 transition disabled:opacity-50"
                        >
                            去见TA
                        </button>
                    </div>
                ) : (
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
                        <CalendarX size={11} /> {STATUS_LABEL[status] || status}
                    </div>
                )}
            </div>
        </div>,
    );
};

export default MeetingInviteCard;
