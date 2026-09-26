/**
 * 生图 API 设置卡的折叠状态纯逻辑。
 * 之所以抽出来：vitest 只跑 node 环境（无 jsdom），组件本身没法渲染测试，
 * 折叠契约（默认收起 / 点击开合 / 标题状态常显）在这里可被单测锁定。
 */

/** 与其他 SettingsSection 一致：默认收起。 */
export const IMAGE_GENERATION_SECTION_DEFAULT_OPEN = false;

/** 点击标题行切换开合。 */
export function toggleImageGenerationSectionOpen(open: boolean): boolean {
    return !open;
}

/** 标题行常显的启用状态徽标（已启用 / 未启用）。 */
export function imageGenerationSectionStatus(enabled: boolean): { label: string; className: string } {
    return enabled
        ? { label: '已启用', className: 'bg-fuchsia-100 text-fuchsia-600' }
        : { label: '未启用', className: 'bg-slate-100 text-slate-400' };
}
