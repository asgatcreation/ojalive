import { describe, expect, it } from 'vitest';
import { naira } from '@ojalive/shared';
import type { LotState } from '@ojalive/bid-engine';
import { parseReply, ReplyError, seedPayload, snapshotToState } from './replies.js';

const lot: LotState = {
  lotId: 'lot_1',
  status: 'open',
  seq: 0,
  priceKobo: naira(50_000),
  startingPriceKobo: naira(50_000),
  reservePriceKobo: naira(58_000),
  buyNowPriceKobo: null,
  leaderUserId: null,
  leaderMaxKobo: null,
  leaderMaxSetSeq: null,
  bidCount: 0,
  endsAt: 1_800_000_000_000,
  originalEndsAt: 1_800_000_000_000,
  extensionCount: 0,
  outcome: null,
  rules: {
    incrementBands: [
      { upToKobo: naira(100_000), stepKobo: naira(1_000) },
      { upToKobo: null, stepKobo: naira(5_000) },
    ],
    softClose: {
      windowMillis: 120_000,
      extensionMillis: 120_000,
      maxTotalExtensionMillis: 1_800_000,
    },
  },
};

const accepted = JSON.stringify({
  outcome: 'accepted',
  status: 'open',
  seq: 3,
  priceKobo: '6100000',
  leaderUserId: 'user_dapo',
  leaderMaxKobo: '7500000',
  leaderMaxSetSeq: 3,
  bidCount: 3,
  buyNowKobo: null,
  endsAt: 1_800_000_000_000,
  originalEndsAt: 1_800_000_000_000,
  extensionCount: 0,
  reserveMet: true,
  extended: false,
  lotOutcome: null,
});

describe('parseReply', () => {
  it('reads an accepted reply, turning string amounts into kobo', () => {
    const result = parseReply(accepted);
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.snapshot.priceKobo).toBe(naira(61_000));
      expect(result.snapshot.leaderMaxKobo).toBe(naira(75_000));
      expect(typeof result.snapshot.priceKobo).toBe('bigint');
    }
  });

  it('distinguishes a replay from a fresh acceptance', () => {
    expect(parseReply(accepted.replace('"accepted"', '"replayed"')).kind).toBe('replayed');
  });

  it('reads a rejection, with the amount that would have been accepted', () => {
    const result = parseReply(
      JSON.stringify({
        outcome: 'rejected',
        reason: 'below_next_increment',
        nextAcceptableKobo: '5100000',
      }),
    );
    expect(result).toEqual({
      kind: 'rejected',
      rejection: { reason: 'below_next_increment', nextAcceptableKobo: naira(51_000) },
    });
  });

  it('omits nextAcceptableKobo entirely when the script sent none', () => {
    const result = parseReply(JSON.stringify({ outcome: 'rejected', reason: 'already_leading' }));
    expect(result).toEqual({ kind: 'rejected', rejection: { reason: 'already_leading' } });
    if (result.kind === 'rejected') {
      expect('nextAcceptableKobo' in result.rejection).toBe(false);
    }
  });

  it('recognises a lot Redis knows nothing about', () => {
    expect(parseReply(JSON.stringify({ outcome: 'no_state' }))).toEqual({ kind: 'no_state' });
  });

  it('refuses text that is not JSON, rather than guessing', () => {
    expect(() => parseReply('OK')).toThrow(ReplyError);
  });

  it('refuses a reply whose shape it does not recognise', () => {
    expect(() => parseReply(JSON.stringify({ outcome: 'accepted', seq: 1 }))).toThrow(ReplyError);
  });

  it('refuses an amount that is not an integer — a float is never money here', () => {
    expect(() => parseReply(accepted.replace('"6100000"', '"61000.50"'))).toThrow(ReplyError);
  });

  it('refuses a rejection reason that is not one of ours', () => {
    expect(() =>
      parseReply(JSON.stringify({ outcome: 'rejected', reason: 'because_i_said_so' })),
    ).toThrow(ReplyError);
  });
});

describe('seedPayload', () => {
  it('sends every value as a string, and nulls as empty strings', () => {
    const payload: unknown = JSON.parse(seedPayload(lot));
    expect(payload).toMatchObject({
      lotId: 'lot_1',
      status: 'open',
      seq: '0',
      priceKobo: '5000000',
      reservePriceKobo: '5800000',
      buyNowPriceKobo: '',
      leaderUserId: '',
      leaderMaxKobo: '',
      endsAt: '1800000000000',
    });
  });

  it('sends increment bands as strings too, open-ended band included', () => {
    const payload = JSON.parse(seedPayload(lot)) as {
      rules: { incrementBands: Array<{ upToKobo: string | null; stepKobo: string }> };
    };
    expect(payload.rules.incrementBands).toEqual([
      { upToKobo: '10000000', stepKobo: '100000' },
      { upToKobo: null, stepKobo: '500000' },
    ]);
  });

  it('survives an amount too large for a JSON number', () => {
    const payload = JSON.parse(seedPayload({ ...lot, priceKobo: 123_456_789_012_345_678n })) as {
      priceKobo: string;
    };
    expect(payload.priceKobo).toBe('123456789012345678');
  });
});

describe('snapshotToState', () => {
  it('keeps the fields the script does not send, and takes the ones it does', () => {
    const result = parseReply(accepted);
    if (result.kind !== 'accepted') throw new Error('expected an acceptance');
    const state = snapshotToState(result.snapshot, lot);

    expect(state.priceKobo).toBe(naira(61_000));
    expect(state.leaderUserId).toBe('user_dapo');
    expect(state.seq).toBe(3);
    // Not in the reply, so carried over from the lot we already had.
    expect(state.startingPriceKobo).toBe(naira(50_000));
    expect(state.reservePriceKobo).toBe(naira(58_000));
    expect(state.rules).toBe(lot.rules);
  });
});
