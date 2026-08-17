import { dateTimeScalar } from './scalars.js';

describe('DateTime scalar', () => {
  it('serializes Date values returned by repositories', () => {
    expect(dateTimeScalar.serialize(new Date('2026-08-16T08:14:12.778Z'))).toBe(
      '2026-08-16T08:14:12.778Z',
    );
  });
});
