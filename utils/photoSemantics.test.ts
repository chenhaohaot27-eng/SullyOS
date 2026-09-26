import { describe, it, expect } from 'vitest';
import { analyzePhotoSemantics, applyPhotoSemantics } from './photoSemantics';

describe('photoSemantics — 自拍语义', () => {
    it('「自拍」→ 前置摄像头第一视角约束，禁止第三人称/手机入画', () => {
        const out = applyPhotoSemantics('她在床上给你发了张自拍');
        expect(out).toContain('前置摄像头');
        expect(out).toContain('不出现手机本体');
        expect(out).toContain('禁止第三人称视角');
        expect(out).toContain('手机屏幕朝外');
        expect(analyzePhotoSemantics('她在床上给你发了张自拍').kind).toBe('selfie');
    });

    it('「selfie / 给你拍张自拍 / 发张自拍」同样命中', () => {
        expect(analyzePhotoSemantics('she takes a selfie in the cafe').kind).toBe('selfie');
        expect(analyzePhotoSemantics('给你拍张自拍').kind).toBe('selfie');
        expect(analyzePhotoSemantics('发张自拍').kind).toBe('selfie');
    });

    it('镜子自拍 → 允许手机入画 + 镜面构图，且不施加「不出现手机本体」', () => {
        const out = applyPhotoSemantics('她在健身房镜子自拍');
        expect(analyzePhotoSemantics('她在健身房镜子自拍').kind).toBe('mirror-selfie');
        expect(out).toContain('镜子自拍');
        expect(out).toContain('手机可以出现在画面中');
        expect(out).toContain('镜面构图');
        expect(out).not.toContain('不出现手机本体');
        expect(analyzePhotoSemantics('mirror selfie in the gym').kind).toBe('mirror-selfie');
    });

    it('他拍 / 街拍 / candid → 允许第三人称镜头完整看到角色', () => {
        const out = applyPhotoSemantics('朋友街拍的她走在涉谷街头');
        expect(analyzePhotoSemantics('朋友街拍的她走在涉谷街头').kind).toBe('third-person');
        expect(out).toContain('第三人称镜头完整看到角色');
        expect(out).not.toContain('不出现手机本体');
        expect(analyzePhotoSemantics('candid photo by a stranger').kind).toBe('third-person');
        expect(analyzePhotoSemantics('别人拍摄的照片').kind).toBe('third-person');
    });
});

describe('photoSemantics — 现实摄影约束', () => {
    it('普通生活照（视觉身份启用）→ 加中英双语现实感约束', () => {
        const out = applyPhotoSemantics('她在家里的沙发上休息', { identityActive: true });
        expect(out).toContain('natural human anatomy');
        expect(out).toContain('realistic skin texture');
        expect(out).toContain('真实皮肤质感');
        expect(out).toContain('ordinary smartphone photography');
        expect(out).toContain('no commercial studio-poster look');
        expect(out).not.toContain('前置摄像头'); // 不是自拍
    });

    it('视觉身份关闭但 prompt 带拍照语境 → 现实感约束仍生效（普通角色照片可用）', () => {
        const out = applyPhotoSemantics('今天在公园拍的一张生活照', { identityActive: false });
        expect(out).toContain('natural human anatomy');
        expect(out).toContain('no plastic CGI skin');
    });

    it('自拍 / 镜子自拍 / 他拍同样附带现实感约束', () => {
        for (const prompt of ['发张自拍', '镜子自拍', '路人偷拍的一张照片']) {
            expect(applyPhotoSemantics(prompt)).toContain('no over-retouching');
        }
    });
});

describe('photoSemantics — 商业请求不强压 & 原 prompt 保留', () => {
    it('明确商业海报 → 不加「智能手机随手拍」现实感，原样返回', () => {
        const original = '为她设计一张电影宣传海报';
        const out = applyPhotoSemantics(original, { identityActive: true });
        expect(out).toBe(original);
        expect(out).not.toContain('smartphone');
        expect(analyzePhotoSemantics(original).kind).toBe('commercial');
    });

    it('英文 commercial / poster / 插画同样豁免', () => {
        expect(analyzePhotoSemantics('commercial photography for a magazine cover').kind).toBe('commercial');
        expect(analyzePhotoSemantics('anime style illustration of her').kind).toBe('commercial');
    });

    it('无拍照语义且视觉身份未启用 → 返回原字符串（完全旧行为）', () => {
        const original = 'A small luminous magenta circle on white background';
        expect(applyPhotoSemantics(original)).toBe(original);
        expect(applyPhotoSemantics(original, { identityActive: false })).toBe(original);
    });

    it('只补充约束，剧情原文完整保留在最前', () => {
        const original = '傍晚的海边，她赤脚跑过浪花，回头朝镜头笑';
        const out = applyPhotoSemantics(original, { identityActive: true });
        expect(out.startsWith(original)).toBe(true);
        expect(out.length).toBeGreaterThan(original.length);
        expect(out).toContain('[摄影约束]');
    });
});
