import { ciCheckNames, requiredCheckNames } from './guards/release-gate';

/**
 * The gate used to compare "checks that succeeded" against "checks registered
 * so far", which is satisfied the moment the first fast job reports — so a poll
 * landing before the unit matrix, integration, conformance and package smoke
 * had even started would publish the package. It now names what it requires,
 * and this pins that list against the jobs CI actually defines: a job added to
 * ci.yml without being required, or a required name that no longer exists,
 * fails here instead of silently weakening the gate.
 */
describe('the release gate requires every CI check (REL-02)', () => {
  it('requires exactly the checks the CI workflow produces', () => {
    expect([...requiredCheckNames()].sort()).toEqual([...ciCheckNames()].sort());
  });

  it('expands every matrix job, so one required name exists per combination', () => {
    const names = ciCheckNames();
    expect(names).toContain('test (node 22 on ubuntu-latest)');
    expect(names).toContain('test (node 24 on macos-latest)');
    expect(names.filter((name) => name.startsWith('test (node '))).toHaveLength(6);
    expect(names.filter((name) => name.startsWith('conformance ('))).toHaveLength(2);
  });

  it('leaves no unexpanded expression in any required name', () => {
    for (const name of requiredCheckNames()) expect(name).not.toContain('${{');
  });
});
