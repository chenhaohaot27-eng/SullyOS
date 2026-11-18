// 群聊自主发图 —— 决策层五道闸直测（对应需求 E4：自主发图/成员身份匹配）。
import { describe, expect, it } from 'vitest';
import type { GroupProfile } from '../../types';
import {
    planGroupAutonomyPhoto,
    extractGroupPhotoFromActions,
    MAX_PHOTOS_PER_AUTONOMY_ROUND,
} from './autonomyPhoto';
import { consumePhotoQuota } from './autonomy';

const makeGroup = (patch: Partial<GroupProfile> = {}): GroupProfile => ({
    id: 'g1',
    name: '测试群',
    members: ['c1', 'c2'],
    createdAt: 0,
    ...patch,
});

describe('planGroupAutonomyPhoto（五道闸）', () => {
    const full = makeGroup({ autonomyConfig: { enabled: true, level: 'daily', photoEnabled: true } });

    it('全开 + API 可用 + 有配额 → 放行', () => {
        const plan = planGroupAutonomyPhoto({ group: full, imageApiReady: true, state: {}, photosThisRound: 0 });
        expect(plan.allowed).toBe(true);
        expect(plan.remainingToday).toBe(2);
    });

    it('自主活跃没开 → 拒绝', () => {
        const group = makeGroup({ autonomyConfig: { enabled: false, level: 'daily', photoEnabled: true } });
        expect(planGroupAutonomyPhoto({ group, imageApiReady: true, state: {}, photosThisRound: 0 }).reason).toBe('autonomy-disabled');
    });

    it('自主发图开关没开 → 拒绝（默认关闭）', () => {
        const group = makeGroup({ autonomyConfig: { enabled: true, level: 'daily' } });
        expect(planGroupAutonomyPhoto({ group, imageApiReady: true, state: {}, photosThisRound: 0 }).reason).toBe('photo-disabled');
    });

    it('生图 API 不可用 → 拒绝（不假装后台生图成功）', () => {
        expect(planGroupAutonomyPhoto({ group: full, imageApiReady: false, state: {}, photosThisRound: 0 }).reason).toBe('image-api-unavailable');
    });

    it('单轮已生成 1 张 → 拒绝（每次自主触发最多 1 张）', () => {
        expect(MAX_PHOTOS_PER_AUTONOMY_ROUND).toBe(1);
        expect(planGroupAutonomyPhoto({ group: full, imageApiReady: true, state: {}, photosThisRound: 1 }).reason).toBe('round-cap');
    });

    it('当天配额用完 → 拒绝（默认 2 张/天）', () => {
        const state = consumePhotoQuota(consumePhotoQuota({}, 'g1'), 'g1');
        expect(planGroupAutonomyPhoto({ group: full, imageApiReady: true, state, photosThisRound: 0 }).reason).toBe('daily-cap');
    });
});

describe('extractGroupPhotoFromActions（SEND_PHOTO 抽取与剥离）', () => {
    it('从导演 JSON content 里抽出意图并剥掉标签', () => {
        const actions = [
            { charId: 'c1', content: '刚到海边！\n[[SEND_PHOTO: {"prompt":"sunset beach","caption":"看海","includeCharacter":false}]]' },
            { charId: 'c2', content: '羡慕死了' },
        ];
        const { photos, cleanedActions } = extractGroupPhotoFromActions(actions);
        expect(photos).toHaveLength(1);
        expect(photos[0].charId).toBe('c1');
        expect(photos[0].intent.prompt).toBe('sunset beach');
        expect(cleanedActions[0].content).toBe('刚到海边！');
        expect(cleanedActions[1].content).toBe('羡慕死了');
    });

    it('多个标签只取第一个（单轮一张，防重复扣费）', () => {
        const actions = [
            { charId: 'c1', content: '[[SEND_PHOTO: {"prompt":"a"}]]' },
            { charId: 'c2', content: '[[SEND_PHOTO: {"prompt":"b"}]]' },
        ];
        const { photos } = extractGroupPhotoFromActions(actions);
        expect(photos).toHaveLength(1);
        expect(photos[0].intent.prompt).toBe('a');
    });

    it('非法 payload 剥掉不留占位（宁可不拍也不显示 JSON）', () => {
        const actions = [{ charId: 'c1', content: '看这个\n[[SEND_PHOTO: not-json]]' }];
        const { photos, cleanedActions } = extractGroupPhotoFromActions(actions);
        expect(photos).toHaveLength(0);
        expect(cleanedActions[0].content).toBe('看这个');
        expect(cleanedActions[0].content).not.toContain('SEND_PHOTO');
    });

    it('纯照片动作（剥后无正文）不产生空文本动作', () => {
        const actions = [{ charId: 'c1', content: '[[SEND_PHOTO: {"prompt":"only photo"}]]' }];
        const { photos, cleanedActions } = extractGroupPhotoFromActions(actions);
        expect(photos).toHaveLength(1);
        expect(cleanedActions).toHaveLength(0);
    });
});
