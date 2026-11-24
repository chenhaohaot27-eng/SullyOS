import type { ChatCompletionApiConfig } from './chatCompletionClient';

type Body = Record<string, any>;

export class TokenmarketSignatureError extends Error {}

export const isTokenmarketChat = (config: ChatCompletionApiConfig): boolean =>
    config.apiFormat !== 'gemini-native' && /^https:\/\/api\.tiantoken\.com\/v1\/?$/i.test(config.baseUrl.trim());

/** Only on explicit recovery, present local bubbles as quoted history instead of provider model turns. */
function recoveryMessages(body: Body): Body[] | undefined {
    const messages = body.messages;
    if (!Array.isArray(messages) || body.tools?.length || body.functions?.length || !messages.some(m => m?.role === 'assistant')) return;
    const result: Body[] = [];
    for (const msg of messages) {
        if (!msg || !['system', 'user', 'assistant'].includes(msg.role)
            || Object.keys(msg).some(key => key !== 'role' && key !== 'content')) return;
        if (msg.role !== 'assistant') {
            result.push(msg);
            continue;
        }
        if (typeof msg.content === 'string') {
            result.push({ role: 'user', content: '历史角色回复（引用）：' + JSON.stringify(msg.content) });
            continue;
        }
        // Real assistant photos in earlier turns must retain their image and caption together.
        if (!Array.isArray(msg.content) || !msg.content.every((p: any) =>
            p && ((p.type === 'text' && typeof p.text === 'string' && Object.keys(p).length === 2)
                || (p.type === 'image_url' && typeof p.image_url?.url === 'string' && Object.keys(p).length === 2)))) return;
        result.push({ role: 'user', content: [{ type: 'text', text: '历史角色回复（引用）：' }, ...msg.content] });
    }
    const lastTurn = messages.filter(m => m.role !== 'system').pop();
    if (lastTurn?.role === 'assistant') result.push({ role: 'user', content: '请按当前角色继续对话。' });
    return result;
}

export async function requestWithTokenmarketSignatureRecovery<T>(
    config: ChatCompletionApiConfig, body: Body, request: (body: Body) => Promise<T>, confirmRetry: () => boolean,
): Promise<T> {
    try {
        return await request(body);
    } catch (error) {
        if (!isTokenmarketChat(config)
            || !(error instanceof Error) || !/^API Error 400: Invalid thought signature\.?$/i.test(error.message.trim())) throw error;
        const messages = recoveryMessages(body);
        if (!messages) throw error;
        if (!confirmRetry()) throw new TokenmarketSignatureError('词元返回 400 Invalid thought signature，本轮已停止。');
        try {
            return await request({ ...body, messages });
        } catch (retryError) {
            throw new TokenmarketSignatureError('本次兼容重试失败：' + (retryError instanceof Error ? retryError.message : String(retryError)));
        }
    }
}
