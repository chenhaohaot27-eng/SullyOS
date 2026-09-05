/**
 * MeetingInviteCard — 聊天中的「见面邀请」卡（meet_card 消息的渲染组件）。
 *
 * 数据全部来自 metadata.meet（MeetingInvitation）；前端只做视觉骨架、按钮与跳转，
 * 正文（invitationText / locationText / timeText）一律是模型产出，绝不拼接。
 * 状态：pending 显示两个按钮；稍后 → deferred（保留在历史，不算拒绝）；
 * 去见TA → accepted + 经 meetingInviteLaunch 跳转见面（DateApp 侧做陪伴/剧情选择）。
 * 头像/名字优先快照（角色已删除也不崩），兜底 characters 注册表实时查。
 */

import React, { useMemo, useState } from 'react';
import { CalendarX, MapPin, Clock } from '@phosphor-icons/react';
import type { Message } from '../../types';
import { readMeetInvitation, updateMeetInviteStatus, meetingInviteLaunch, type MeetingInviteStatus } from '../../utils/meetingInvite';

type CommonLayout = (node: React.ReactNode, extra?: any) => React.ReactNode;

const STATUS_LABEL: Partial<Record<MeetingInviteStatus, string>> = {
    accepted: '已接受',
    deferred: '稍后见',
    declined: '已婉拒',
    expired: '已过期',
    cancelled: '已取消',
};

const MeetingInviteCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: CommonLayout;
}> = ({ m, isUser, charName, commonLayout }) => {
    const invitation = readMeetInvitation(m);
    const [status, setStatus] = useState<MeetingInviteStatus>(invitation?.status || 'pending');
    const [busy, setBusy] = useState(false);

    const participantsText = useMemo(() => {
        if (!invitation) return '';
        const names = invitation.participantNames?.length ? invitation.participantNames : [invitation.initiatorName];
        return names.join('、');
    }, [invitation]);

    if (!invitation) return null; // 旧数据容错：无 meet 字段不渲染

    const handleDefer = async () => {
        if (busy || status !== 'pending') return;
        setBusy(true);
        try {
            setStatus('deferred');
            await updateMeetInviteStatus(m.id, 'deferred');
        } finally {
            setBusy(false);
        }
    };

    const handleAccept = async () => {
        if (busy || status !== 'pending') return;
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

    return commonLayout(
        <div className="w-64 rounded-2xl overflow-hidden shadow-sm border bg-violet-50/80 dark:bg-violet-500/10 border-violet-100 dark:border-violet-500/20">
            {/* 卡头：发起者 */}
            <div className="px-3 pt-2.5 pb-1.5 flex items-center gap-2">
                {invitation.initiatorAvatar
                    ? <img src={invitation.initiatorAvatar} className="w-7 h-7 rounded-full object-cover ring-1 ring-black/5" alt="" />
                    : <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm ${isUser ? 'bg-rose-100' : 'bg-violet-100 dark:bg-violet-500/20'}`}>🤝</span>}
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate">
                        {invitation.initiatorName || charName}的见面邀请
                    </div>
                    {participantsText && participantsText !== invitation.initiatorName && (
                        <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">见面对象：{participantsText}</div>
                    )}
                </div>
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
            </div>
            {/* 操作 / 状态 */}
            <div className="px-3 pb-2.5">
                {status === 'pending' ? (
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={busy}
                            onClick={handleDefer}
                            className="flex-1 py-1.5 rounded-full bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[11px] font-semibold active:scale-95 transition disabled:opacity-50"
                        >
                            稍后
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
