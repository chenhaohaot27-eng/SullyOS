/**
 * CallApp 协议分发接线守卫（源码级断言，同 chatPhotoViewer.wiring.test.ts 套路）：
 * 防"电话直连 /chat/completions 绕开 completeChat"的回归——那会让 gemini-native
 * 用户在电话里收到中转的 HTML 页面（"API返回了HTML而非JSON (HTTP 200): RelayRouter"）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const callApp = read('../apps/CallApp.tsx');
const cameraSnapshot = read('./userCameraSnapshot.ts');

describe('CallApp 统一走 completeChat 协议分发', () => {
    it('不再直接调用 safeFetchJson，也不再手拼 /chat/completions URL', () => {
        expect(callApp).not.toContain('safeFetchJson(');
        expect(callApp).not.toMatch(/`\$\{baseUrl\}\/chat\/completions`/);
        expect(callApp).toMatch(/import \{ completeChat \} from '\.\.\/utils\/chatCompletionClient';/);
    });

    it('三处模型请求（主通话回复 + 视频表演人格 + 视频动作排练）都经 completeChat', () => {
        // 主通话回复 + 两处副请求 = 至少 3 个调用点
        expect((callApp.match(/completeChat\(/g) || []).length).toBeGreaterThanOrEqual(3);
        expect(callApp).toContain("'语音通话'");
        expect(callApp).toContain("'视频通话·用户快照'");
        expect(callApp).toContain("'视频通话·快照降级为文字'");
        expect(callApp).toContain("'生成视频表演人格'");
        expect(callApp).toContain("'视频动作排练'");
    });

    it('主通话请求把 apiFormat 传给 completeChat', () => {
        expect(callApp).toMatch(/apiFormat: apiConfig\.apiFormat/);
    });

    it('resolvePerformanceDirectorApi 回退主 API 时不丢失 apiFormat；副 API 保持无协议假设', () => {
        expect(callApp).toMatch(/apiFormat: apiConfig\.apiFormat\s*\}/);
        // 副 API 分支展开配置（无 apiFormat 字段）→ completeChat 按 OpenAI 兼容处理
        expect(callApp).toContain('? { ...configuredEmotionApi }');
    });

    it('摄像头快照"不支持图片"识别覆盖 Gemini Native 形态（inline_data 等）', () => {
        expect(cameraSnapshot).toContain('inline_?data');
    });
});
