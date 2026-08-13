import { decodeArchive, encodeArchive } from './archive-format.js';

describe('conversation archive format', () => {
  it('round-trips compressed NDJSON with checksum validation', () => {
    const records = [
      {
        message: {
          id: '0198a122-0c00-7000-8000-000000000001',
          conversationId: '0198a122-0c00-7000-8000-000000000002',
          role: 'user',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        parts: [
          {
            id: '0198a122-0c00-7000-8000-000000000003',
            messageId: '0198a122-0c00-7000-8000-000000000001',
            kind: 'text',
            position: 0,
            payload: { text: '보관 메시지' },
          },
        ],
      },
    ];
    const archive = encodeArchive(records);
    expect(decodeArchive(archive.body, archive.checksum)).toEqual(records);
    expect(() =>
      decodeArchive(Buffer.from('broken'), archive.checksum),
    ).toThrow();
  });
});
