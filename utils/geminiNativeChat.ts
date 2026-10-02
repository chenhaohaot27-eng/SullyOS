import type { StreamHooks } from './safeApi';

type JsonRecord = Record<string, any>;

export interface GeminiNativeRequest {
  contents: Array<{ role: 'user' | 'model'; parts: JsonRecord[] }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
  };
  tools?: Array<{ functionDeclarations: JsonRecord[] }>;
  toolConfig?: {
    functionCallingConfig: {
      mode: 'AUTO' | 'NONE' | 'ANY';
      allowedFunctionNames?: string[];
    };
  };
}

export interface GeminiNativeCallOptions {
  signal?: AbortSignal;
  streamHooks?: StreamHooks;
  fetchImpl?: typeof fetch;
}

export interface GeminiProviderState {
  role: 'model';
  /** Gemini 返回的原始 parts；仅供同一次工具循环回传，不参与 JSON 序列化。 */
  parts: JsonRecord[];
  toolCalls?: Array<{ internalId: string; name: string; nativeId?: string }>;
}

const GEMINI_PROVIDER_STATE = Symbol('sully.gemini-provider-state');

type MessageWithProviderState = JsonRecord & {
  [GEMINI_PROVIDER_STATE]?: GeminiProviderState;
};

export class GeminiNativeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Gemini Native API ${status}: ${message}`);
    this.name = 'GeminiNativeApiError';
  }
}

export class GeminiNativeAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiNativeAdapterError';
  }
}

export function getGeminiProviderState(message: unknown): GeminiProviderState | undefined {
  return message && typeof message === 'object'
    ? (message as MessageWithProviderState)[GEMINI_PROVIDER_STATE]
    : undefined;
}

function attachGeminiProviderState(message: JsonRecord, state: GeminiProviderState): void {
  Object.defineProperty(message, GEMINI_PROVIDER_STATE, {
    value: state,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function clonePart<T extends JsonRecord>(part: T): T {
  if (typeof structuredClone === 'function') return structuredClone(part);
  return JSON.parse(JSON.stringify(part));
}

export function buildGeminiNativeEndpoint(baseUrl: string, model: string): string {
  let root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!root) {
    throw new GeminiNativeAdapterError('Gemini Native requires a non-empty base URL and model.');
  }
  root = root.replace(/\/v1beta\/models$/i, '/v1beta');
  if (!/\/v1beta$/i.test(root)) root += '/v1beta';

  const modelId = String(model ?? '')
    .trim()
    .replace(/^models\//i, '');
  if (!modelId) {
    throw new GeminiNativeAdapterError('Gemini Native requires a non-empty base URL and model.');
  }
  return `${root}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

function numberOrUndefined(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseDataImage(url: string): JsonRecord {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url);
  if (!match) {
    if (/^(?:https?:|blob:)/i.test(url)) {
      throw new GeminiNativeAdapterError(
        'Gemini Native cannot send remote/blob media without a data URL.',
      );
    }
    throw new GeminiNativeAdapterError('Gemini Native received an unsupported image URL.');
  }
  if (!/^image\//i.test(match[1])) {
    throw new GeminiNativeAdapterError(`Gemini Native only accepts image data URLs here (${match[1]}).`);
  }
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function contentToParts(content: unknown, role: string): JsonRecord[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (content == null) return [];
  if (!Array.isArray(content)) {
    throw new GeminiNativeAdapterError(`Unsupported ${role} message content.`);
  }

  return content.flatMap((part): JsonRecord[] => {
    if (typeof part === 'string') return part ? [{ text: part }] : [];
    if (!part || typeof part !== 'object') {
      throw new GeminiNativeAdapterError(`Unsupported ${role} message part.`);
    }
    const record = part as JsonRecord;
    if (record.type === 'text' || record.type === 'input_text' || typeof record.text === 'string') {
      return typeof record.text === 'string' && record.text ? [{ text: record.text }] : [];
    }
    if (record.type === 'image_url' || record.image_url != null) {
      const url = typeof record.image_url === 'string' ? record.image_url : record.image_url?.url;
      if (typeof url !== 'string') {
        throw new GeminiNativeAdapterError('Gemini Native image_url is missing its URL.');
      }
      return [parseDataImage(url)];
    }
    throw new GeminiNativeAdapterError(`Unsupported ${role} message part type: ${String(record.type ?? 'unknown')}.`);
  });
}

function parseFunctionArguments(value: unknown, functionName: string): JsonRecord {
  if (value == null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Throw below with a stable, non-secret error message.
  }
  throw new GeminiNativeAdapterError(`Tool ${functionName} has invalid JSON arguments.`);
}

function assistantToolCallParts(toolCalls: unknown): JsonRecord[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((toolCall, index) => {
    const call = toolCall as JsonRecord;
    const fn = call.function as JsonRecord | undefined;
    const name = String(fn?.name ?? '').trim();
    if (!name) throw new GeminiNativeAdapterError(`Assistant tool call ${index} is missing its function name.`);
    return {
      functionCall: {
        ...(call.id ? { id: String(call.id) } : {}),
        name,
        args: parseFunctionArguments(fn?.arguments, name),
      },
    };
  });
}

function parseToolResponse(content: unknown): JsonRecord {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => typeof part === 'string' ? part : String((part as JsonRecord)?.text ?? '')).join('')
      : String(content ?? '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

function appendContent(
  contents: GeminiNativeRequest['contents'],
  role: 'user' | 'model',
  parts: JsonRecord[],
): void {
  if (parts.length === 0) return;
  const previous = contents[contents.length - 1];
  if (previous?.role === role) previous.parts.push(...parts);
  else contents.push({ role, parts });
}

function sanitizeSchema(schema: unknown): JsonRecord {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object' };
  const input = schema as JsonRecord;
  const rawTypes = Array.isArray(input.type) ? input.type.map(String) : [String(input.type ?? '')];
  const nonNullType = rawTypes.find(type => type && type !== 'null')
    || (input.properties ? 'object' : input.items ? 'array' : input.enum ? 'string' : 'object');
  const output: JsonRecord = { type: nonNullType.toLowerCase() };
  if (typeof input.description === 'string') output.description = input.description;
  if (typeof input.format === 'string') output.format = input.format;
  if (rawTypes.includes('null') || input.nullable === true) output.nullable = true;
  if (Array.isArray(input.enum)) output.enum = input.enum.filter((value: unknown) => value !== null);
  else if ('const' in input) output.enum = [input.const];
  if (output.type === 'array') output.items = sanitizeSchema(input.items);
  if (output.type === 'object') {
    const properties: JsonRecord = {};
    if (input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)) {
      for (const [name, child] of Object.entries(input.properties)) properties[name] = sanitizeSchema(child);
    }
    output.properties = properties;
    if (Array.isArray(input.required)) {
      output.required = input.required.map(String).filter((name: string) => name in properties);
    }
  }
  for (const key of ['minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength'] as const) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) output[key] = input[key];
  }
  return output;
}

function convertTools(tools: unknown): GeminiNativeRequest['tools'] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const declarations = tools.map((tool, index) => {
    const record = tool as JsonRecord;
    if (record?.type !== 'function' || !record.function) {
      throw new GeminiNativeAdapterError(`Unsupported OpenAI tool at index ${index}.`);
    }
    const fn = record.function as JsonRecord;
    const name = String(fn.name ?? '').trim();
    if (!name) throw new GeminiNativeAdapterError(`OpenAI tool ${index} is missing its name.`);
    return {
      name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters: sanitizeSchema(fn.parameters),
    };
  });
  return [{ functionDeclarations: declarations }];
}

function convertToolChoice(toolChoice: unknown): GeminiNativeRequest['toolConfig'] | undefined {
  if (toolChoice == null) return undefined;
  if (toolChoice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  if (typeof toolChoice === 'object') {
    const name = String((toolChoice as JsonRecord)?.function?.name ?? '').trim();
    if (name) {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
    }
  }
  throw new GeminiNativeAdapterError(`Unsupported OpenAI tool_choice: ${String(toolChoice)}.`);
}

export function buildGeminiNativeRequest(body: JsonRecord): GeminiNativeRequest {
  const contents: GeminiNativeRequest['contents'] = [];
  const systemParts: Array<{ text: string }> = [];
  const callMetadata = new Map<string, { name: string; nativeId?: string }>();

  for (const rawMessage of Array.isArray(body.messages) ? body.messages : []) {
    const message = rawMessage as MessageWithProviderState;
    const role = String(message?.role ?? '');
    if (role === 'system') {
      const parts = contentToParts(message.content, role);
      for (const part of parts) {
        if (typeof part.text !== 'string') {
          throw new GeminiNativeAdapterError('Gemini Native systemInstruction only supports text parts.');
        }
        systemParts.push({ text: part.text });
      }
      continue;
    }

    if (role === 'assistant') {
      const providerState = getGeminiProviderState(message);
      if (providerState?.toolCalls) {
        for (const call of providerState.toolCalls) {
          callMetadata.set(call.internalId, { name: call.name, nativeId: call.nativeId });
        }
      }
      const parts = providerState
        ? providerState.parts.map(clonePart)
        : [...contentToParts(message.content, role), ...assistantToolCallParts(message.tool_calls)];
      for (const part of parts) {
        const functionCall = part.functionCall as JsonRecord | undefined;
        if (functionCall?.id && functionCall?.name && !callMetadata.has(String(functionCall.id))) {
          callMetadata.set(String(functionCall.id), {
            name: String(functionCall.name),
            nativeId: String(functionCall.id),
          });
        }
      }
      appendContent(contents, 'model', parts);
      continue;
    }

    if (role === 'tool') {
      const id = String(message.tool_call_id ?? '').trim();
      const metadata = callMetadata.get(id);
      const name = String(message.name ?? metadata?.name ?? id ?? 'tool').trim() || 'tool';
      const responseId = metadata ? metadata.nativeId : id;
      appendContent(contents, 'user', [{
        functionResponse: {
          ...(responseId ? { id: responseId } : {}),
          name,
          response: parseToolResponse(message.content),
        },
      }]);
      continue;
    }

    if (role === 'user') {
      appendContent(contents, 'user', contentToParts(message.content, role));
      continue;
    }
    throw new GeminiNativeAdapterError(`Unsupported chat role: ${role || 'missing'}.`);
  }

  const temperature = numberOrUndefined(body.temperature);
  const topP = numberOrUndefined(body.top_p);
  const maxTokens = numberOrUndefined(body.max_tokens);
  const generationConfig: NonNullable<GeminiNativeRequest['generationConfig']> = {};
  if (temperature != null) generationConfig.temperature = temperature;
  if (topP != null) generationConfig.topP = topP;
  if (maxTokens != null && maxTokens > 0) generationConfig.maxOutputTokens = Math.floor(maxTokens);

  const tools = convertTools(body.tools);
  const toolConfig = convertToolChoice(body.tool_choice);
  return {
    contents,
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(tools ? { tools } : {}),
    ...(toolConfig ? { toolConfig } : {}),
  };
}

function finishReason(value: unknown): string | null {
  const reason = String(value ?? '').toUpperCase();
  if (!reason || reason === 'FINISH_REASON_UNSPECIFIED') return null;
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'BLOCKLIST' || reason === 'PROHIBITED_CONTENT') return 'content_filter';
  return reason.toLowerCase();
}

class GeminiResponseAssembler {
  private visibleText = '';
  private rawParts: JsonRecord[] = [];
  private calls: JsonRecord[] = [];
  private providerToolCalls: NonNullable<GeminiProviderState['toolCalls']> = [];
  private usage: JsonRecord | undefined;
  private model = '';
  private finish: string | null = null;
  private firstDeltaSent = false;

  constructor(private readonly hooks?: StreamHooks) {}

  feed(payload: JsonRecord): void {
    if (payload?.error) {
      const message = typeof payload.error === 'string' ? payload.error : payload.error.message;
      throw new GeminiNativeApiError(Number(payload.error?.code) || 500, String(message || 'Unknown error'));
    }
    if (payload.modelVersion) this.model = String(payload.modelVersion);
    if (payload.usageMetadata) this.usage = payload.usageMetadata;
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : undefined;
    if (!candidate) return;
    if (candidate.finishReason) this.finish = finishReason(candidate.finishReason);
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    for (const partValue of parts) {
      if (!partValue || typeof partValue !== 'object') continue;
      const part = clonePart(partValue as JsonRecord);
      this.rawParts.push(part);
      if (typeof part.text === 'string' && part.thought !== true) {
        const delta = part.text;
        if (delta) {
          this.visibleText += delta;
          if (!this.firstDeltaSent) {
            this.firstDeltaSent = true;
            try { this.hooks?.onFirstDelta?.(); } catch { /* display callback must not break parsing */ }
          }
          try { this.hooks?.onDelta?.(delta, this.visibleText); } catch { /* display callback must not break parsing */ }
        }
      }
      if (part.functionCall && typeof part.functionCall === 'object') {
        const call = part.functionCall as JsonRecord;
        const name = String(call.name ?? '').trim();
        if (!name) continue;
        const nativeId = call.id == null ? undefined : String(call.id);
        const internalId = nativeId || `call_gemini_${this.calls.length}`;
        this.calls.push({
          id: internalId,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(call.args && typeof call.args === 'object' ? call.args : {}),
          },
        });
        this.providerToolCalls.push({ internalId, name, ...(nativeId ? { nativeId } : {}) });
      }
    }
  }

  finishResponse(fallbackModel: string): JsonRecord {
    const message: JsonRecord = {
      role: 'assistant',
      content: this.visibleText,
      ...(this.calls.length ? { tool_calls: this.calls } : {}),
    };
    if (this.calls.length || this.rawParts.some(part => part.thoughtSignature != null)) {
      attachGeminiProviderState(message, {
        role: 'model',
        parts: this.rawParts.map(clonePart),
        ...(this.providerToolCalls.length ? { toolCalls: this.providerToolCalls.map(call => ({ ...call })) } : {}),
      });
    }
    const promptTokens = Number(this.usage?.promptTokenCount) || 0;
    const completionTokens = Number(this.usage?.candidatesTokenCount) || 0;
    const totalTokens = Number(this.usage?.totalTokenCount) || promptTokens + completionTokens;
    return {
      choices: [{ index: 0, message, finish_reason: this.finish }],
      model: this.model || fallbackModel,
      ...(this.usage ? {
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        },
      } : {}),
    };
  }
}

class SseEventDecoder {
  private pending = '';
  private dataLines: string[] = [];

  push(text: string): string[] {
    this.pending += text;
    const payloads: string[] = [];
    while (true) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0) break;
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      this.consumeLine(line, payloads);
    }
    return payloads;
  }

  finish(): string[] {
    const payloads: string[] = [];
    if (this.pending) this.consumeLine(this.pending.replace(/\r$/, ''), payloads);
    this.pending = '';
    this.flush(payloads);
    return payloads;
  }

  private consumeLine(line: string, payloads: string[]): void {
    if (line === '') {
      this.flush(payloads);
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('data:')) this.dataLines.push(line.slice(5).replace(/^ /, ''));
  }

  private flush(payloads: string[]): void {
    if (this.dataLines.length) payloads.push(this.dataLines.join('\n'));
    this.dataLines = [];
  }
}

function feedJsonPayload(raw: string, assembler: GeminiResponseAssembler): void {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[DONE]') return;
  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) parsed.forEach(item => assembler.feed(item));
  else assembler.feed(parsed);
}

async function readGeminiResponse(
  response: Response,
  model: string,
  hooks?: StreamHooks,
): Promise<JsonRecord> {
  if (!response.body?.getReader) {
    const assembler = new GeminiResponseAssembler(hooks);
    feedJsonPayload(await response.text(), assembler);
    return assembler.finishResponse(model);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const assembler = new GeminiResponseAssembler(hooks);
  const events = new SseEventDecoder();
  const contentType = response.headers.get('content-type') || '';
  let mode: 'undecided' | 'sse' | 'json' = /text\/event-stream/i.test(contentType) ? 'sse' : 'undecided';
  let raw = '';
  let fedSseLength = 0;

  const feedEvents = (text: string) => {
    for (const payload of events.push(text)) feedJsonPayload(payload, assembler);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    if (mode === 'undecided') {
      const trimmed = raw.trimStart();
      if (!trimmed) continue;
      if (trimmed.startsWith('data:') || trimmed.startsWith(':')) mode = 'sse';
      else if ('data:'.startsWith(trimmed) && trimmed.length < 5) continue;
      else mode = 'json';
    }
    if (mode === 'sse') {
      const next = raw.slice(fedSseLength);
      fedSseLength = raw.length;
      feedEvents(next);
    }
  }
  const tail = decoder.decode();
  if (tail) {
    raw += tail;
    if (mode === 'sse') {
      feedEvents(raw.slice(fedSseLength));
      fedSseLength = raw.length;
    }
  }
  if (mode === 'sse') {
    for (const payload of events.finish()) feedJsonPayload(payload, assembler);
    return assembler.finishResponse(model);
  }

  feedJsonPayload(raw, assembler);
  return assembler.finishResponse(model);
}

async function extractErrorMessage(response: Response): Promise<string> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return String(parsed?.error?.message ?? parsed?.message ?? (raw || `HTTP ${response.status}`));
  } catch {
    return raw.trim() || `HTTP ${response.status}`;
  }
}

export async function requestGeminiNativeChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  openAiBody: JsonRecord,
  options: GeminiNativeCallOptions = {},
): Promise<JsonRecord> {
  const endpoint = buildGeminiNativeEndpoint(baseUrl, model);
  const nativeBody = buildGeminiNativeRequest(openAiBody);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(nativeBody),
    signal: options.signal,
  });
  if (!response.ok) throw new GeminiNativeApiError(response.status, await extractErrorMessage(response));
  return readGeminiResponse(response, model, options.streamHooks);
}
