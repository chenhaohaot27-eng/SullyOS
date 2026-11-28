import { describe, expect, it, vi } from 'vitest';
import { runProtocolMatrix, matrixStations, SHORT } from './protocolMatrix';
import { matrixRequests } from './protocolMatrixTransport';
import { upgradeChatBodyToStream, assembleUpgradedResponse } from './streamUpgrade';
import type { APIConfig } from '../types';
import type { ApiCallLogEntry } from './apiCallLog';

const cfg = {
  baseUrl: 'https://api.tiantoken.com/v1',
  apiKey: 'fixture',
  model: 'gemini-3.6-flash',
} as APIConfig;
describe('single-action protocol matrix', () => {
  it('does not select an HTTP-200 reply rejection as a working control station', () => {
    const control = { ...cfg, baseUrl: 'https://control.example/v1' };
    const history = [{ baseUrl: control.baseUrl, model: cfg.model, ok: true,
      replyValidation: 'failed' } as ApiCallLogEntry];
    expect(matrixStations(cfg, [{ id: 'control', name: 'control', config: control }], history).controls).toEqual([]);
    history[0].replyValidation = 'passed';
    expect(matrixStations(cfg, [{ id: 'control', name: 'control', config: control }], history).controls).toEqual([control]);
  });
  it('measures requests after stream upgrade, normalizes both provider formats, and spends one long probe', async () => {
    const caps: number[] = [];
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      if (url.endsWith('/models')) return Response.json({ data: [{ id: cfg.model }] });
      const rule = matrixRequests.get(init)!;
      const req = JSON.parse(String(init.body));
      const native = !!req.contents;
      if (native) expect(new URL(url).pathname).toMatch(/^\/v1beta\/models\//);
      const prompt = native ? req.contents[0].parts[0].text : req.messages[0].content;
      const expected = prompt.slice(prompt.indexOf('\n') + 1);
      const cap = native
        ? req.generationConfig.maxOutputTokens
        : (req.max_completion_tokens ?? req.max_tokens);
      caps.push(cap);
      expect(req.max_completion_tokens && req.max_tokens).toBeFalsy();
      let stream = native ? url.includes('streamGenerateContent') : req.stream;
      const upgraded = !native && rule.uiStream && !stream && upgradeChatBodyToStream(String(init.body));
      if (upgraded) stream = JSON.parse(upgraded).stream;
      const visible = native
        ? {
            modelVersion: cfg.model,
            candidates: [
              {
                content: { parts: [{ thought: true, text: 'fixture reasoning' }, { text: expected }] },
                finishReason: 'STOP',
              },
            ],
          }
        : {
            model: cfg.model,
            choices: [
              {
                [stream ? 'delta' : 'message']: {
                  content: expected,
                  reasoning_content: 'fixture reasoning',
                },
                finish_reason: 'stop',
              },
            ],
          };
      const response = stream
        ? new Response(
            'data: ' + JSON.stringify(visible) + '\n\n' + (native ? '' : 'data: [DONE]\n\n'),
            { headers: { 'Content-Type': 'text/event-stream' } },
          )
        : Response.json(visible);
      rule.wire(stream, response.clone());
      return upgraded ? assembleUpgradedResponse(response) : response;
    });
    const controls = ['first', 'second'].map(id => ({
      id, name: id, config: { ...cfg, baseUrl: `https://${id}.example/v1` },
    }));
    const history = controls.map(({ config }) => ({
      baseUrl: config.baseUrl, model: cfg.model, ok: true,
    } as ApiCallLogEntry));
    const result = await runProtocolMatrix(cfg, controls, history, transport as typeof fetch);
    expect(result.rows.every((r) => r.status === '通过')).toBe(true);
    expect(result.rows.find((r) => r.probe === 'chat-upgrade')).toMatchObject({
      requestedStream: undefined,
      wireStream: true,
    });
    expect(result.rows.filter((r) => r.long)).toHaveLength(1);
    expect(caps.filter((v) => v === 128)).toHaveLength(32);
    expect(caps.filter((v) => v > 128)).toEqual([512]);
    expect(JSON.stringify(result)).not.toContain('fixture reasoning');
    expect(result.rows[0]).toMatchObject({
      rawLength: SHORT.length,
      bubbleCount: 3,
      photoIntents: 1,
      emojiIntents: 1,
    });
  });
  it('does not send anonymous requests or retry an unauthorized credential', async () => {
    const api = vi.fn(async () => new Response('', { status: 401 }));
    expect((await runProtocolMatrix({ ...cfg, apiKey: '' }, [], [], api)).rows).toHaveLength(0);
    expect(api).not.toHaveBeenCalled();
    const result = await runProtocolMatrix(cfg, [], [], api);
    expect(api).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(0);
  });
  it('stops the station after a generation request loses its response', async () => {
    const api = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: cfg.model }] });
      throw new TypeError('network');
    });
    const result = await runProtocolMatrix(cfg, [], [], api);
    expect(api).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe('网络或读取失败');
  });
});
