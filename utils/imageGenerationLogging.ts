import type {
    ImageGenerationAspectRatio,
    ImageGenerationProvider,
    ImageGenerationResolution,
} from '../types';

export interface ImageGenerationRequestLogMeta {
    operation: 'generate' | 'list-models';
    provider: ImageGenerationProvider;
    model?: string;
    resolution?: ImageGenerationResolution;
    aspectRatio?: ImageGenerationAspectRatio;
    referenceImageCount?: number;
}

export type ImageGenerationRequestInit = RequestInit & {
    __sullyImageGenerationLog?: ImageGenerationRequestLogMeta;
};

export function withImageGenerationLogMeta(
    init: RequestInit,
    meta: ImageGenerationRequestLogMeta,
): ImageGenerationRequestInit {
    return { ...init, __sullyImageGenerationLog: meta };
}

export function getImageGenerationLogMeta(init: RequestInit | undefined): ImageGenerationRequestLogMeta | undefined {
    return (init as ImageGenerationRequestInit | undefined)?.__sullyImageGenerationLog;
}

export function formatImageGenerationRequestLog(meta: ImageGenerationRequestLogMeta): string {
    const lines = [
        '--- Image Request ---',
        `operation: ${meta.operation}`,
        `image model: ${meta.model?.trim() || '(model list)'}`,
        `provider/protocol: ${meta.provider}`,
    ];
    if (meta.operation === 'generate') {
        lines.push(
            `resolution: ${meta.resolution || 'unknown'}`,
            `aspect ratio: ${meta.aspectRatio || 'unknown'}`,
            `reference images: ${Math.max(0, meta.referenceImageCount || 0)}`,
        );
    }
    return `\n${lines.join('\n')}`;
}

function collectRequestSecrets(init: RequestInit | undefined, body: unknown): string[] {
    const secrets: string[] = [];
    try {
        const headers = new Headers(init?.headers);
        const googleKey = headers.get('x-goog-api-key');
        const authorization = headers.get('authorization');
        if (googleKey) secrets.push(googleKey);
        if (authorization) {
            secrets.push(authorization);
            const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
            if (bearer) secrets.push(bearer);
        }
    } catch { /* malformed headers are ignored */ }

    if (typeof body !== 'string') return secrets;
    try {
        const payload = JSON.parse(body);
        if (typeof payload?.prompt === 'string') secrets.push(payload.prompt);
        const parts = payload?.contents?.flatMap?.((content: any) => Array.isArray(content?.parts) ? content.parts : []) || [];
        for (const part of parts) {
            if (typeof part?.text === 'string') secrets.push(part.text);
            const inline = part?.inlineData || part?.inline_data;
            if (typeof inline?.data === 'string') secrets.push(inline.data);
        }
    } catch { /* non-JSON request bodies carry no image request metadata */ }
    return secrets.filter(value => value.length > 0).sort((a, b) => b.length - a.length);
}

/** Redacts credentials, prompts and image payloads before an image error enters system logs. */
export function sanitizeImageGenerationLogText(
    value: unknown,
    init?: RequestInit,
    body?: unknown,
): string {
    let text = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value ?? '');
    for (const secret of collectRequestSecrets(init, body)) {
        text = text.split(secret).join('[REDACTED]');
    }
    return text
        .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[REDACTED_IMAGE]')
        .replace(/\b[a-z0-9+/]{80,}={0,2}\b/gi, '[REDACTED_BASE64]')
        .slice(0, 500);
}
