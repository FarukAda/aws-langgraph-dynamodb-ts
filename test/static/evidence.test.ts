import {
  evidenceClaims,
  evidenceTexts,
  indexedClaimIds,
  liveTestClaimIds,
} from './guards/evidence';

describe('docs/evidence', () => {
  it('finds claims to check, so a broken scan cannot pass silently', () => {
    expect(evidenceClaims().length).toBeGreaterThanOrEqual(9);
  });

  /**
   * A claim is citable only when both exist: the raw record a reviewer can read
   * without credentials, and a live test that fails if AWS changes the
   * behaviour. Either alone goes stale silently.
   */
  it('pairs every claim with a live test named after it', () => {
    const tested = new Set(liveTestClaimIds());
    expect(evidenceClaims().filter((claim) => !tested.has(claim.id))).toEqual([]);
  });

  it('has no live test citing a claim that does not exist', () => {
    const known = new Set(evidenceClaims().map((claim) => claim.id));
    expect(liveTestClaimIds().filter((id) => !known.has(id))).toEqual([]);
  });

  it('lists every claim in the README table, and nothing else', () => {
    expect([...indexedClaimIds()].sort()).toEqual(
      evidenceClaims()
        .map((claim) => claim.id)
        .sort(),
    );
  });

  it('names no AWS account and no local path', () => {
    const leaks = evidenceTexts().filter(({ text }) =>
      /\b\d{12}\b|[A-Za-z]:\\Users\\|AppData/.test(text),
    );
    expect(leaks.map(({ file }) => file)).toEqual([]);
  });
});
