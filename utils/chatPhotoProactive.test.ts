import { describe, expect, it, beforeEach } from 'vitest';
import {
    buildChatPhotoAutonomyPrompt,
    buildChatPhotoTagGuide,
    extractVerbalPhotoCommitment,
} from './chatPhotoIntent';

describe('extractVerbalPhotoCommitment（口头视觉分享承诺 → 真实照片）', () => {
    it('明确的当下分享承诺命中：我拍给你看 / 拍了张照片给你 / 给你看看这个', () => {
        const a = extractVerbalPhotoCommitment('到我这边了，等我\n我拍给你看，刚做好的午饭');
        expect(a).not.toBeNull();
        expect(a!.prompt).toContain('拍给你看');
        expect(a!.includeCharacter).toBe(false);

        const b = extractVerbalPhotoCommitment('锵锵～刚拍了一张照片给你');
        expect(b).not.toBeNull();
        expect(b!.prompt).toContain('照片给你');

        const c = extractVerbalPhotoCommitment('给你看看这个');
        expect(c).not.toBeNull();

        const d = extractVerbalPhotoCommitment('把窗外的风景拍给你看');
        expect(d).not.toBeNull();
    });

    it('自拍/穿搭类承诺自动带上角色', () => {
        const out = extractVerbalPhotoCommitment('换新发型啦，我拍张自拍给你看');
        expect(out).not.toBeNull();
        expect(out!.includeCharacter).toBe(true);
        expect(out!.prompt).toContain('自拍');
    });

    it('远期/条件/疑问承诺不触发（不抢跑、不误发）', () => {
        expect(extractVerbalPhotoCommitment('下次拍给你看')).toBeNull();
        expect(extractVerbalPhotoCommitment('改天给你看看我的房间')).toBeNull();
        expect(extractVerbalPhotoCommitment('你要是想看的话我就拍给你')).toBeNull();
        expect(extractVerbalPhotoCommitment('给你看看这个问题怎么解决')).toBeNull();
        expect(extractVerbalPhotoCommitment('明天发张图给你')).toBeNull();
    });

    it('普通聊天零触发（不该发图时正常聊天）', () => {
        expect(extractVerbalPhotoCommitment('今天好累啊，加班到现在')).toBeNull();
        expect(extractVerbalPhotoCommitment('我也想吃火锅，下次一起去')).toBeNull();
        expect(extractVerbalPhotoCommitment('嗯嗯，我也觉得那个电影很好看')).toBeNull();
        // 叙述提到"照片"但没有给"你"的分享动作
        expect(extractVerbalPhotoCommitment('我相册里存了好多以前的照片，都是回忆')).toBeNull();
    });
});

describe('主动发图提示词（自然化优化）', () => {
    beforeEach(() => { localStorage.clear(); });

    it('自主分享场景覆盖生活化清单，不设频率指标', () => {
        const prompt = buildChatPhotoAutonomyPrompt();
        for (const scene of ['正在吃的东西', '逛街', '旅行', '散步', '穿搭', '自拍', '宠物', '夜景', '桌面', '房间', '礼物', '票据', '小物件']) {
            expect(prompt).toContain(scene);
        }
        expect(prompt).toContain('不要求每轮都发');
        expect(prompt).toContain('不必先问对方想不想看');
    });

    it('协议指南包含「口头承诺必须落实」约束（修复只说不发）', () => {
        const guide = buildChatPhotoTagGuide();
        expect(guide).toContain('SEND_PHOTO');
        expect(guide).toContain('口头描述');
        // 用户明确要求发图的优先级描述保持最高
        expect(guide).toContain('必须使用');
    });
});
