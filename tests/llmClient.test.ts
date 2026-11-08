import { HttpLlmClient } from '../src/llm/client';
import { LlmError } from '../src/llm/types';

/**
 * LlmClient contract (docs/PHASE2_DESIGN.md §9.1). Fetch-mocked — no real
 * network, no real LLM. Covers: 200 happy path, 429→retry→success, 4xx→no
 * retry, timeout→UNAVAILABLE, malformed JSON→PARSE, usage accounting.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch): HttpLlmClient {
  return new HttpLlmClient('https://llm.example.com/v1', 'k_test', fetchImpl);
}

const baseReq = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'system' as const, content: 'hi' }],
  temperature: 0,
  jsonMode: true,
  timeoutMs: 5000,
};

describe('HttpLlmClient', () => {
  it('returns content + usage on a 200 happy path', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    const client = makeClient(fetchImpl);
    const res = await client.chat(baseReq);

    expect(res.content).toBe('{"ok":true}');
    expect(res.usage.promptTokens).toBe(10);
    expect(res.usage.completionTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(15);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    // Asserts the OpenAI-compatible request shape.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k_test');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('retries once on HTTP 429 then succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
      );
    const client = makeClient(fetchImpl);
    const res = await client.chat(baseReq);
    expect(res.content).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once on HTTP 500 then succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
      );
    const client = makeClient(fetchImpl);
    const res = await client.chat(baseReq);
    expect(res.content).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on HTTP 4xx (except 429)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('forbidden', { status: 403 }));
    const client = makeClient(fetchImpl);
    await expect(client.chat(baseReq)).rejects.toMatchObject({
      kind: 'FATAL',
      status: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on timeout (AbortError)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const fetchImpl = jest.fn().mockRejectedValue(abortErr);
    const client = makeClient(fetchImpl);
    await expect(client.chat(baseReq)).rejects.toMatchObject({ kind: 'TIMEOUT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once on a network error (non-abort throw)', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
      );
    const client = makeClient(fetchImpl);
    const res = await client.chat(baseReq);
    expect(res.content).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails with PARSE when the response body is not valid JSON', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('not json', { status: 200 }));
    const client = makeClient(fetchImpl);
    await expect(client.chat(baseReq)).rejects.toMatchObject({ kind: 'PARSE' });
  });

  it('fails with PARSE when choices[].message.content is absent', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [] }));
    const client = makeClient(fetchImpl);
    await expect(client.chat(baseReq)).rejects.toMatchObject({ kind: 'PARSE' });
  });

  it('sends the messages array with role + content', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '{}' } }], usage: {} }),
    );
    const client = makeClient(fetchImpl);
    await client.chat({
      ...baseReq,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
      ],
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('trims a trailing slash from the base URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '{}' } }], usage: {} }),
    );
    const client = new HttpLlmClient(
      'https://llm.example.com/v1/',
      'k',
      fetchImpl,
    );
    await client.chat(baseReq);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://llm.example.com/v1/chat/completions',
    );
  });

  it('classifies error kinds correctly', async () => {
    // Verify LlmError carries the kind + status.
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('nope', { status: 401 }));
    const client = makeClient(fetchImpl);
    try {
      await client.chat(baseReq);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).kind).toBe('FATAL');
      expect((err as LlmError).status).toBe(401);
    }
  });
});
