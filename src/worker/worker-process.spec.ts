import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { report } from './worker-process.js';

describe('report', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes task, message, and stack for errors with a fallback for unknown rejections', () => {
    const write = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const error = new Error('asset processing failed');
    error.stack = 'Error: asset processing failed\n    at worker';

    report('asset-results', error);
    report('archive', 'connection reset');

    expect(write).toHaveBeenNthCalledWith(
      1,
      `${JSON.stringify({
        task: 'asset-results',
        message: 'asset processing failed',
        stack: 'Error: asset processing failed\n    at worker',
      })}\n`,
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      `${JSON.stringify({ task: 'archive', message: 'Worker failure' })}\n`,
    );
  });
});
