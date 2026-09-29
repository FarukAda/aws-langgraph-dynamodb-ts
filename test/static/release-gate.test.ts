import {
  ciCheckNames,
  jobBodies,
  readWorkflow,
  requiredCheckNames,
  topLevelPermissions,
  triggers,
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
describe('the release gate requires every CI check', () => {
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

  it('starts from a pushed tag and nothing else, so no dispatch can publish a branch', () => {
    expect(triggers('release.yml')).toEqual(['push']);
    expect(readWorkflow('release.yml')).toMatch(/^ {4}tags: \['v\*'\]$/m);
    expect(readWorkflow('release.yml')).not.toMatch(/^ {4}branches:/m);
  });

  it('passes --ignore-scripts to every npm publish', () => {
    const publishes = jobs.publish.map(command).filter((line) => line?.startsWith('npm publish'));
    expect(publishes).toHaveLength(2);
    for (const line of publishes) expect(line).toContain('--ignore-scripts');
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
    /** A comment naming the command is not a publish; only the commands are held to the tarball. */
    const publishes = jobs.publish.filter(
      (line) => !/^\s*#/.test(line) && /\bnpm publish\b/.test(line),
    );
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) expect(line).toContain('"./${TARBALL}"');
    expect(jobs.publish.join('\n')).toContain('TARBALL: ${{ needs.verify.outputs.tarball }}');
  });
});

/**
 * The live tier is a publish gate only while it cannot pass vacuously and
 * grants nothing beyond its one job. A skipped Jest suite exits 0, so the
 * zero-test check is what stops a run that made no AWS call from going green.
 */
describe('the live-AWS workflow', () => {
  const text = readWorkflow('integration-live.yml');

  it('runs on release tags only', () => {
    expect(triggers('integration-live.yml')).toEqual(['push']);
    expect(text).toMatch(/^ {4}tags: \['v\*'\]$/m);
  });

  it('grants nothing at the top of the workflow', () => {
    expect(topLevelPermissions('integration-live.yml')).toBe('permissions: {}');
  });

  it('fails a run that passed having run no test', () => {
    expect(text).toContain('--json --outputFile=jest-aws.json');
    expect(text).toContain(`numPassedTests`);
    expect(text).toMatch(/if \[ "\$\{PASSED\}" -lt 1 \]; then\s+echo "::error::[^"]*"\s+exit 1/);
  });
});

/**
 * What the release vouches for beyond a green CI: the commit is one `main`
 * holds, the files it ships carry provenance a consumer can verify, and nothing
 * outside GitHub's own actions runs with the token that creates the release.
 */
describe('the release refuses what it cannot vouch for', () => {
  const jobs = jobBodies('release.yml');
  const uses = (lines: string[]): string[] =>
    lines
      .map((line) => /^\s+(?:-\s+)?uses:\s*(\S+)/.exec(line)?.[1])
      .filter((action) => action !== undefined);

  it('refuses a tag whose commit main does not hold', () => {
    const text = jobs.verify.join('\n');
    expect(text).toMatch(/git merge-base --is-ancestor "\$\{GITHUB_SHA\}" FETCH_HEAD/);
    expect(text).toMatch(/^\s+fetch-depth:\s*0\b/m);
  });

  it('restores no cache in the job that builds what is published', () => {
    expect(jobs.verify.join('\n')).not.toMatch(/^\s+cache:/m);
  });

  /**
   * Before the publish, like everything else that can fail: signing talks to
   * services that can be down, and a failure after `npm publish` would leave a
   * live version with no GitHub release.
   */
  it('attests the tarball and the SBOMs in the publish job, before publishing', () => {
    const text = jobs.publish.join('\n');
    expect(text).toMatch(/^\s+attestations:\s*write\b/m);
    const attest = jobs.publish.findIndex((line) =>
      /uses: actions\/attest-build-provenance@[0-9a-f]{40}/.test(line),
    );
    const publish = jobs.publish.findIndex((line) =>
      /npm publish "\.\/\$\{TARBALL\}" --ignore-scripts --access public --provenance/.test(line),
    );
    expect(attest).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(attest);
    for (const subject of [
      '${{ needs.verify.outputs.tarball }}',
      'sbom.runtime.cyclonedx.json',
      'sbom.build.cyclonedx.json',
    ]) {
      expect(jobs.publish.slice(attest, publish).join('\n')).toContain(subject);
    }
  });

  it('creates the GitHub release with gh and no third-party action', () => {
    const actions = uses(jobs['github-release']);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
    const text = jobs['github-release'].join('\n');
    expect(text).toMatch(/\bgh release create\b[^\n]*--verify-tag/);
    expect(text).toMatch(/\bgh release edit\b/);
    expect(text).toContain('provenance.intoto.jsonl');
  });
});
