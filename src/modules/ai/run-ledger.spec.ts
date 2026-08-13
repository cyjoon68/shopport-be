import { RunLedger } from './run-ledger.js';

describe('RunLedger', () => {
  it('executes one-time effects once when a run reconnects', () => {
    const ledger = new RunLedger();

    expect(ledger.begin('run-1')).toBe(true);
    expect(ledger.begin('run-1')).toBe(false);
    ledger.complete('run-1');
    expect(ledger.status('run-1')).toBe('completed');
  });

  it('returns a reserved run to terminal error state', () => {
    const ledger = new RunLedger();

    expect(ledger.begin('run-2')).toBe(true);
    ledger.fail('run-2');
    expect(ledger.status('run-2')).toBe('failed');
  });
});
