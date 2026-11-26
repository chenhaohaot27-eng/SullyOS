import { assertCompletionDelivered } from './completionOutcome';
import { parseSseToCompletion } from './openAiStream';
import { finalizeReply, frameReplyMessages, ReplyBoundaryError } from './replyBoundary';

/** The SDK retains its own tool history before calling onLLMOutput. Adapt at fetch,
 * before the SDK can store a raw assistant turn or send a separate reasoning push. */
export function characterTransport(transport: typeof fetch, markedOnly: boolean): typeof fetch {
    return async (resource, init) => {
        if (typeof init?.body !== 'string' || init.method !== 'POST') return transport(resource, init);
        if (markedOnly && !init.body.includes('"lemuriaCharacterReply":true')) return transport(resource, init);
        let request;
        try { request = JSON.parse(init.body); } catch { return transport(resource, init); }
        if (!request.model || !Array.isArray(request.messages) || !request.messages.length) return transport(resource, init);
        const [first, ...rest] = request.messages;
        if (markedOnly && first?.lemuriaCharacterReply !== true) return transport(resource, init);
        const { lemuriaCharacterReply, ...original } = first;
        const nonce = crypto.randomUUID();
        request.messages = frameReplyMessages([original, ...rest], nonce);
        const response = await transport(resource, { ...init, body: JSON.stringify(request) });
        if (!response.ok) return response;
        const raw = await response.text();
        let data;
        try {
            data = raw.trimStart().startsWith('{') ? JSON.parse(raw) : parseSseToCompletion(raw);
        } catch { throw new ReplyBoundaryError(); }
        if (!data || data.stream_incomplete) throw new ReplyBoundaryError();
        assertCompletionDelivered(data);
        finalizeReply(data, nonce);
        if (data.choices[0].finish_reason === 'length') delete data.choices[0].message.tool_calls;
        return Response.json({ ...data, lemuriaReplyVerified: true });
    };
}
