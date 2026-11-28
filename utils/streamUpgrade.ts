/**
 * 透明流式升级（Transparent Stream Upgrade）
 *
 * 背景：部分旧调用没有指定 stream。非流式的长生成容易撞网关/中转的空闲超时——
 * 连接上几十秒一个字节都不回，网关掐掉连接，表现为「回复被截断 / 半截 JSON」。
 *
 * 做法：在 OSContext 的全局 fetch 拦截器（所有 /chat/completions 的统一出口，与
 * 采样参数兼容层同一位置）做双向改写：
 *   - 请求侧：主 API 设置开了 stream 时，仅把缺省 stream 的请求体升级为
 *     `stream:true (+ stream_options.include_usage)`
 *   - 响应侧：把 SSE 攒齐拼回标准 chat.completion JSON，再交还调用方
 *
 * 调用方拿到统一隔离思考字段后的 choices/usage 结构，但传输过程
 * 一直有字节在流，降低网关空闲超时风险。调用方显式指定的 stream（true 或 false）
 * 始终保留；测试连接、角色/应用配置的选择不能被已保存的全局开关覆盖。
 *
 * 个别中转若拒绝 stream/stream_options，错误会原样交给调用方。不能在拦截器里自动
 * 重发付费生成请求：中转可能已经把第一份交给上游，静默重发会造成重复扣费。
 */

import { readBodyWithStreaming } from './safeApi';

const API_CONFIG_KEY = 'os_api_config';

/** 主 API 设置里的流式开关（设置 → API → 流式）。读取失败一律视为关。 */
export function isGlobalStreamEnabled(): boolean {
    try {
        if (typeof localStorage === 'undefined') return false;
        const raw = localStorage.getItem(API_CONFIG_KEY);
        if (!raw) return false;
        return JSON.parse(raw)?.stream === true;
    } catch {
        return false;
    }
}

/**
 * 把一个 chat/completions 请求体升级为流式。
 * 返回升级后的 body 字符串；已有 stream 字段或 body 不是 JSON 对象时返回 null。
 * 注意：调用方负责先判断全局开关（isGlobalStreamEnabled），本函数保持纯粹。
 */
export function upgradeChatBodyToStream(bodyStr: string): string | null {
    let parsed: any;
    try { parsed = JSON.parse(bodyStr); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // 全局设置只为旧调用方补默认值；显式 false 也必须原样送给服务端。
    if (Object.prototype.hasOwnProperty.call(parsed, 'stream')) return null;
    parsed.stream = true;
    // include_usage：让末尾 chunk 带 usage，token 计费徽标 / API 调用记录不缺数
    parsed.stream_options = { include_usage: true };
    return JSON.stringify(parsed);
}

/** Upgraded and mislabeled responses pass through the same public-message adapter. */
export async function assembleUpgradedResponse(response: Response): Promise<Response> {
    const data = await readBodyWithStreaming(response, {});
    return new Response(JSON.stringify(data), {
        status: response.status, statusText: response.statusText,
        headers: { 'Content-Type': 'application/json' },
    });
}
