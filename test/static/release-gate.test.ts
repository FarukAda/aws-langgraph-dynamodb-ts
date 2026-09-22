import {
  ciCheckNames,
  jobBodies,
  requiredCheckNames,
  topLevelPermissions,
} from './guards/release-gate';

/**
 * The gate used to compare "checks that succeeded" against "checks registered
 * so far", which is satisfied the moment the first fast job reports — so a poll
 * landing before the unit matrix, integration, conformance and package smoke
 * had even started would publish the package. It now names what it requires,
 * in scripts/required-checks.json, and this pins that list against the jobs
 * the workflows actually define: a job added to ci.yml without being required,
 * or a required name that no longer exists, fails here instead of silently
 * weakening the gate.
 */
describe('the release gate requires every CI check (REL-02)', () => {
  it('requires exactly the checks the CI workflow produces', () => {
    expect([...requiredCheckNames()].sort()).toEqual([...ciCheckNames()].sort());
  });

  it('expands every matrix job, so one required name exists per combination', () => {
    const names = ciCheckNames();
    expect(names).toContain('test (node 22 on ubuntu-latest)');
    expect(names).toContain('test (node 24 on macos-latest)');
    expect(names.filter((name) => name.startsWith('test (node '))).toHaveLength(9);
    expect(names.filter((name) => name.startsWith('conformance ('))).toHaveLength(2);
  });

  it('leaves no unexpanded expression in any required name', () => {
    for (const name of requiredCheckNames()) expect(name).not.toContain('${{');
  });

  it('requires the live-AWS tier, which its own workflow produces', () => {
    expect(requiredCheckNames()).toContain('live-aws integration');
    expect(ciCheckNames()).toContain('live-aws integration');
  });
});

/**
 * Trusted Publishing lets any process in a job holding `id-token: write` in
 * release.yml mint an npm publish credential. So only the publish job may hold
 * it, and that job must run no third-party code: no install, no package
 * script, no action GitHub does not own, only npm's own bundled binary
 * publishing the tarball verify packed.
 */
describe('only the publish job can mint a credential, and it runs no third-party code', () => {
  const jobs = jobBodies('release.yml');
  const holdsIdToken = (lines: string[]): boolean =>
    lines.some((line) => /^\s+id-token:\s*write\b/.test(line));
  /** A shell command, at the start of a `run:` line or of a block-scalar line. */
  const command = (line: string): string | undefined =>
    /^\s+(?:-\s+)?(?:run:\s*)?([a-z][\w.-]*(?:\s.*)?)$/.exec(line)?.[1];

  it('grants nothing at the top of the workflow', () => {
    expect(topLevelPermissions('release.yml')).toBe('permissions: {}');
  });

  it('gives id-token to publish and to no other job', () => {
    expect(Object.keys(jobs).sort()).toEqual(['github-release', 'publish', 'verify']);
    expect(Object.keys(jobs).filter((id) => holdsIdToken(jobs[id]))).toEqual(['publish']);
  });

  it('runs no install and no package script in the publish job', () => {
    const installsOrRuns = /^(?:npm\s+(?:ci|install|i|run|exec|test|rebuild)|npx|yarn|pnpm)\b/;
    const commands = jobs.publish.map(command).filter((line) => line !== undefined);
    expect(commands.some((line) => line.startsWith('npm publish'))).toBe(true);
    expect(commands.filter((line) => installsOrRuns.test(line))).toEqual([]);
  });

  it('uses only actions GitHub owns in the publish job', () => {
    const actions = jobs.publish
      .map((line) => /^\s+(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1])
      .filter((action) => action !== undefined);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
  });

  it('publishes the tarball verify packed, not a fresh pack', () => {
    const publishes = jobs.publish.filter((line) => /\bnpm publish\b/.test(line));
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) expect(line).toContain('"./${TARBALL}"');
    expect(jobs.publish.join('\n')).toContain('TARBALL: ${{ needs.verify.outputs.tarball }}');
  });
});
