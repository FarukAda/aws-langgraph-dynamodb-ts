import type { LifecycleRule } from '@aws-sdk/client-s3';

import {
  alreadyCorrect,
  assertNoIdCollision,
  ttlRule,
} from '../../../../../src/shared/codec/s3/rules';
import { S3_RELEASE_GRACE_DAYS } from '../../../../../src/shared/constants';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

const PREFIX = 'langgraph-checkpoints/';
const TTL_ID = 'langgraph-ttl-langgraph-checkpoints';
const TTL_DAYS = 30;
const TAGS = [{ Key: 'team', Value: 'platform' }];

/** An enabled rule holding `days` of noncurrent retention, shaped by `over`. */
function holding(days: number, over: Partial<LifecycleRule> = {}): LifecycleRule {
  return {
    ID: 'a-rule-this-package-did-not-write',
    Status: 'Enabled',
    NoncurrentVersionExpiration: { NoncurrentDays: days },
    ...over,
  };
}

/** The retention the ttl rule would carry over a bucket holding `rules`. */
function floorOver(rules: LifecycleRule[]): number | undefined {
  return ttlRule(TTL_ID, PREFIX, TTL_DAYS, rules).NoncurrentVersionExpiration?.NoncurrentDays;
}

/**
 * S3 honours the shorter of two overlapping expirations, so the retention
 * written has to be the longest one already governing these keys. Which rules
 * those are is the whole question: counting one that governs nothing pins this
 * package's grace at a value nobody asked for, and missing one that governs
 * everything silently shortens a window an operator chose.
 */
describe('the rules that set the floor', () => {
  it('is the release grace when the bucket holds no rules at all', () => {
    expect(floorOver([])).toBe(S3_RELEASE_GRACE_DAYS);
  });

  const governing: [string, LifecycleRule][] = [
    ['no filter at all, which is bucket-wide', holding(90)],
    ['a filter naming this very prefix', holding(90, { Filter: { Prefix: PREFIX } })],
    [
      'a filter naming a prefix this one starts with',
      holding(90, { Filter: { Prefix: 'langgraph-' } }),
    ],
    [
      'a nested prefix this one starts with',
      holding(90, { Filter: { And: { Prefix: 'langgraph-', Tags: TAGS } } }),
    ],
    ['tags and no prefix at either level', holding(90, { Filter: { And: { Tags: TAGS } } })],
    ['a size bound and no prefix', holding(90, { Filter: { ObjectSizeGreaterThan: 1024 } })],
    ['the legacy prefix set to nothing, which is bucket-wide', holding(90, { Prefix: '' })],
    [
      'the legacy prefix naming a prefix this one starts with',
      holding(90, { Prefix: 'langgraph-' }),
    ],
  ];

  it.each(governing)('raises the floor for a rule with %s', (_name, rule) => {
    expect(floorOver([rule])).toBe(90);
  });

  const notGoverning: [string, LifecycleRule][] = [
    ['a filter naming an unrelated prefix', holding(90, { Filter: { Prefix: 'other-app/' } })],
    [
      'a nested prefix naming an unrelated one',
      holding(90, { Filter: { And: { Prefix: 'other-app/', Tags: TAGS } } }),
    ],
    ['the legacy prefix naming an unrelated one', holding(90, { Prefix: 'other-app/' })],
    ['a prefix beneath this one', holding(90, { Filter: { Prefix: `${PREFIX}store/` } })],
    ['a disabled status, which governs nothing at all', holding(90, { Status: 'Disabled' })],
  ];

  it.each(notGoverning)('leaves the floor at the grace for a rule with %s', (_name, rule) => {
    expect(floorOver([rule])).toBe(S3_RELEASE_GRACE_DAYS);
  });

  it('takes the longest of the rules that govern, ignoring the rest', () => {
    expect(
      floorOver([
        holding(7),
        holding(120, { Filter: { And: { Prefix: 'langgraph-', Tags: TAGS } } }),
        holding(365, { Filter: { Prefix: 'other-app/' } }),
        holding(400, { Status: 'Disabled' }),
      ]),
    ).toBe(120);
  });

  it('ignores a governing rule that expires no noncurrent version', () => {
    expect(floorOver([{ ID: 'transitions-only', Status: 'Enabled' }])).toBe(S3_RELEASE_GRACE_DAYS);
  });

  /**
   * The rule this package writes is itself in the set, so a floor once written
   * outlives the rule that justified it. That is what never-lower means, and
   * the README says so: the way back down is to delete this package's rule.
   */
  it('keeps a floor it wrote once the rule that justified it is gone', () => {
    const ours = ttlRule(TTL_ID, PREFIX, TTL_DAYS, [holding(90)]);
    expect(floorOver([ours])).toBe(90);
  });

  /**
   * The status test answers "does this rule constrain these keys", which is the
   * right question of a foreign rule and the wrong one of the rule being
   * replaced: that value is this package's own committed floor, and an operator
   * who disables the rule to pause expiry during an incident must not find the
   * recovery window cut to a day on the next deploy.
   */
  it('keeps the floor the held rule committed to even when it has been disabled', () => {
    const ours: LifecycleRule = {
      ID: TTL_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Disabled',
      Expiration: { Days: TTL_DAYS },
      NoncurrentVersionExpiration: { NoncurrentDays: 60 },
    };
    expect(
      ttlRule(TTL_ID, PREFIX, TTL_DAYS, [ours], ours).NoncurrentVersionExpiration?.NoncurrentDays,
    ).toBe(60);
  });

  it('still refuses a disabled rule it does not hold', () => {
    const held: LifecycleRule = { ID: TTL_ID, Filter: { Prefix: PREFIX }, Status: 'Enabled' };
    expect(
      ttlRule(TTL_ID, PREFIX, TTL_DAYS, [held, holding(90, { Status: 'Disabled' })], held)
        .NoncurrentVersionExpiration?.NoncurrentDays,
    ).toBe(S3_RELEASE_GRACE_DAYS);
  });
});

describe('alreadyCorrect', () => {
  const desired = (): LifecycleRule => ttlRule(TTL_ID, PREFIX, TTL_DAYS, []);

  it('holds for a rule that already says what would be written', () => {
    expect(alreadyCorrect(desired(), desired())).toBe(true);
  });

  it('does not hold when the bucket carries no such rule', () => {
    expect(alreadyCorrect(undefined, desired())).toBe(false);
  });

  const differing: [string, Partial<LifecycleRule>][] = [
    ['a disabled status', { Status: 'Disabled' }],
    ['no filter, as a rule written in the older schema has', { Filter: undefined }],
    ['a filter naming another prefix', { Filter: { Prefix: 'other-app/' } }],
    ['another expiration in days', { Expiration: { Days: 7 } }],
    ['a marker reclaim where days belong', { Expiration: { ExpiredObjectDeleteMarker: true } }],
    ['another noncurrent retention', { NoncurrentVersionExpiration: { NoncurrentDays: 9 } }],
  ];

  it.each(differing)('does not hold for a rule with %s', (_name, over) => {
    expect(alreadyCorrect({ ...desired(), ...over }, desired())).toBe(false);
  });

  /** Unmanaged fields must not provoke a write, or every call would rewrite the bucket. */
  it('holds for a rule that differs only in a field this package does not manage', () => {
    const held = { ...desired(), Transitions: [{ Days: 10, StorageClass: 'GLACIER' as const }] };
    expect(alreadyCorrect(held, desired())).toBe(true);
  });
});

/**
 * The guard has to read a rule's scope exactly where `scopeOf` reads it. While
 * it looked only at `Filter.Prefix`, a rule written in the older schema named
 * its scope somewhere the guard could not see: the guard waved it through and
 * the rewrite replaced that scope with this package's own, so the objects the
 * operator's rule governed lost their expiration and nothing governed them.
 */
describe('assertNoIdCollision', () => {
  const ID = TTL_ID;

  /** The refusal this rule provokes, or a failure saying it provoked none. */
  function refusal(rule: LifecycleRule): { code?: string; context?: { field?: string } } {
    try {
      assertNoIdCollision(rule, PREFIX, ID);
    } catch (error) {
      return error as { code?: string; context?: { field?: string } };
    }
    throw new Error('expected the rule id collision to be refused');
  }

  const accepted: [string, LifecycleRule | undefined][] = [
    ['no rule at that id at all', undefined],
    ['a rule scoping this very prefix', { ID, Filter: { Prefix: PREFIX }, Status: 'Enabled' }],
    ['a rule naming no scope anywhere', { ID, Status: 'Enabled' }],
    [
      'a rule in the older schema scoping this very prefix',
      { ID, Prefix: PREFIX, Status: 'Enabled' },
    ],
  ];

  it.each(accepted)('takes over %s', (_name, rule) => {
    expect(() => assertNoIdCollision(rule, PREFIX, ID)).not.toThrow();
  });

  const refused: [string, LifecycleRule][] = [
    [
      'a filter scoping another prefix',
      { ID, Filter: { Prefix: 'someone-elses/' }, Status: 'Enabled' },
    ],
    [
      'a nested filter scoping another prefix',
      { ID, Filter: { And: { Prefix: 'someone-elses/', Tags: TAGS } }, Status: 'Enabled' },
    ],
    [
      'the older schema scoping another prefix',
      { ID, Prefix: 'someone-elses/', Status: 'Enabled' },
    ],
    ['the older schema scoping the whole bucket', { ID, Prefix: '', Status: 'Enabled' }],
  ];

  it.each(refused)('refuses %s', (_name, rule) => {
    expect(refusal(rule)).toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3.keyPrefix' },
    });
  });

  /** Narrowing a bucket-wide rule to this prefix would strip the rest of the bucket. */
  it('names the scope it refuses to replace', () => {
    expect(() => assertNoIdCollision({ ID, Prefix: '', Status: 'Enabled' }, PREFIX, ID)).toThrow(
      'is already used by the prefix ""',
    );
  });
});
