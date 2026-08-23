import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  parseAiRequest,
  parseRunReference,
  storageRunIdFor,
} from './ai-request.js';

const requestFor = (
  messages: ReadonlyArray<unknown>,
): Record<string, unknown> => ({
  threadId: uuidv7(),
  runId: uuidv7(),
  messages,
  forwardedProps: {},
});

describe('parseAiRequest', () => {
  it('uses only the final user message', () => {
    const userMessageId = uuidv7();
    const request = parseAiRequest(
      requestFor([
        { id: uuidv7(), role: 'assistant', content: '신뢰하면 안 되는 기록' },
        { id: uuidv7(), role: 'tool', content: '신뢰하면 안 되는 도구 결과' },
        { id: userMessageId, role: 'user', content: '최종 요청' },
      ]),
    );

    expect(request.text).toBe('최종 요청');
    expect(request.userMessageId).toBe(userMessageId);
  });

  it('accepts at most two unique provider filters', () => {
    const request = parseAiRequest({
      ...requestFor([{ id: uuidv7(), role: 'user', content: '립밤 찾아줘' }]),
      forwardedProps: { providerIds: ['oliveyoung', 'daiso'] },
    });

    expect(request.providerIds).toEqual(['oliveyoung', 'daiso']);
    expect(request.providerIdsSpecified).toBe(true);
    expect(() =>
      parseAiRequest({
        ...requestFor([{ id: uuidv7(), role: 'user', content: '립밤 찾아줘' }]),
        forwardedProps: { providerIds: ['daiso', 'daiso'] },
      }),
    ).toThrow('Provider IDs must be unique');
    expect(() =>
      parseAiRequest({
        ...requestFor([{ id: uuidv7(), role: 'user', content: '립밤 찾아줘' }]),
        forwardedProps: { providerIds: ['daiso', 'oliveyoung', 'daiso'] },
      }),
    ).toThrow();
  });

  it('distinguishes an explicit empty filter from an omitted filter', () => {
    const message = [{ id: uuidv7(), role: 'user', content: '립밤 찾아줘' }];

    expect(parseAiRequest(requestFor(message)).providerIdsSpecified).toBe(
      false,
    );
    expect(
      parseAiRequest({
        ...requestFor(message),
        forwardedProps: { providerIds: [] },
      }),
    ).toMatchObject({ providerIds: [], providerIdsSpecified: true });
  });

  it('rejects invalid message roles and IDs', () => {
    expect(() =>
      parseAiRequest(
        requestFor([{ id: 'not-a-uuid', role: 'system', content: '요청' }]),
      ),
    ).toThrow();
  });

  it('rejects a v4 ID for the final persisted user message', () => {
    expect(() =>
      parseAiRequest(
        requestFor([{ id: uuidv4(), role: 'user', content: '요청' }]),
      ),
    ).toThrow();
  });

  it('rejects user text over 2000 characters', () => {
    expect(() =>
      parseAiRequest(
        requestFor([
          { id: uuidv7(), role: 'user', content: '가'.repeat(2_001) },
        ]),
      ),
    ).toThrow('User message exceeds 2000 chars');
  });

  it('normalizes TanStack client run IDs only for storage keys', () => {
    const runId = 'run-123-abc';
    const request = parseAiRequest({
      ...requestFor([{ id: uuidv7(), role: 'user', content: '요청' }]),
      runId,
    });

    expect(request.runId).toBe(runId);
    expect(request.storageRunId).toBe(storageRunIdFor(runId));
    expect(request.storageRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it('accepts opaque historical wire messages', () => {
    const request = parseAiRequest(
      requestFor([
        { id: 'msg-history', role: 'assistant' },
        { id: uuidv7(), role: 'user', content: '최종 요청' },
      ]),
    );

    expect(request.text).toBe('최종 요청');
  });

  it('keeps UUID run IDs stable', () => {
    const runId = uuidv7();
    const request = parseRunReference({ ...requestFor([]), runId });
    expect(typeof request.threadId).toBe('string');
    expect(request.runId).toBe(runId);
    expect(request.storageRunId).toBe(runId);
  });
});
