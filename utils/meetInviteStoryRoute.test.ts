import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dateAppSource = readFileSync(fileURLToPath(new URL('../apps/DateApp.tsx', import.meta.url)), 'utf-8');
const storyTheaterSource = readFileSync(fileURLToPath(new URL('../components/date/story/StoryTheater.tsx', import.meta.url)), 'utf-8');

describe('邀请「剧情」路由 — 接线断言', () => {
    const fnStart = dateAppSource.indexOf('const handleMeetInviteChoice');
    const fnEnd = dateAppSource.indexOf('const dismissMeetInviteChoice');
    const fnSource = dateAppSource.slice(fnStart, fnEnd);

    it('story 分支在 startPeek 之前 return，绝不进入陪伴 peek/session', () => {
        expect(fnStart).toBeGreaterThan(-1);
        const storyBranch = fnSource.slice(fnSource.indexOf("surface === 'story'"), fnSource.indexOf('if (c.savedDateState)'));
        expect(storyBranch).toContain('setMeetStoryLaunch');
        expect(storyBranch).toContain('return;');
        expect(storyBranch).not.toContain('startPeek');
        // 陪伴路径保持原行为：startPeek / 旧存档二选一
        expect(fnSource).toContain('startPeek(c, hint)');
    });

    it('邀请上下文（participants / sceneSeed / contextSummary）进入剧情草稿', () => {
        expect(fnSource).toContain('current.invitation.sceneSeed');
        expect(fnSource).toContain('current.invitation.contextSummary');
        expect(fnSource).toContain('current.invitation.participantIds');
        expect(fnSource).toContain('premise: fromPlayer');
        expect(fnSource).toContain('（赴约前背景）');
    });

    it('StoryTheater 渲染不再被 cameFromChat 挡住；携带 launchDraft；退出回来源聊天', () => {
        expect(dateAppSource).toContain("meetSurface === 'story' && mode === 'select'");
        expect(dateAppSource).not.toContain("meetSurface === 'story' && mode === 'select' && !cameFromChat");
        expect(dateAppSource).toContain('launchDraft={meetStoryLaunch}');
        expect(dateAppSource).toContain('if (cameFromChat) { returnToChat(); } else { closeApp(); }');
    });

    it('StoryTheater：launchDraft 一次性预填草稿（不落库），进编辑器后可真正进 session', () => {
        const effect = storyTheaterSource.slice(
            storyTheaterSource.indexOf('launchDraftRef.current = launchDraft'),
            storyTheaterSource.indexOf('}, [launchDraft])'),
        );
        expect(effect).toContain('createStoryTheaterDraft()');
        expect(effect).toContain("setView('editor')");
        expect(effect).toContain('onLaunchConsumed?.()');
        expect(effect).not.toContain('DB.saveStoryTheater');
        // 编辑器保存 → saveEntry → view 'session'（既有机制，保证最终进入 StoryTheaterSession）
        expect(storyTheaterSource).toContain("setView('session')");
    });
});
