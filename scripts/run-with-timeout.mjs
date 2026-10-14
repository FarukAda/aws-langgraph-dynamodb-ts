/**
 * Run a command, and kill it — and everything it itself spawned — if it has
 * not exited on its own within a timeout.
 *
 * `node --test --test-timeout=N` bounds only the body of each test; nothing
 * in Node bounds what happens once the last test has finished. That gap
 * matters for `npm run test:surface`: it fuzzes the public surface through
 * roughly 200 AWS SDK client wrappers a run, and a heap that size has been
 * shown to trigger a Node 24/26 teardown defect after exit
 * (`Check failed: node->IsInUse()`, hang or crash while freeing it — on Node
 * 24.21 the test child spins at 100 % CPU in its own teardown in about one
 * run in three, with every test already passed). That is why the script
 * passes `--test-force-exit`: the runner then ends the process the moment the
 * tests are done, on the exit path that skips freeing the heap, and the hang
 * does not arise. A hang there is a stall after every test already passed,
 * which `--test-timeout` cannot see and cannot stop, so this wrapper stays as
 * the backstop: it watches the whole child process from outside, and once the
 * timeout elapses it kills the child's entire process tree — not just the
 * immediate child, since `node --test` isolates each test file into its own
 * child process, and a kill that missed that grandchild would leave exactly
 * the runaway process this exists to stop. `npm run test:surface` can no
 * longer run for hours unattended; it always exits within the timeout it is
 * given.
 *
 * Usage: `node scripts/run-with-timeout.mjs <timeoutSeconds> -- <command> [args...]`
 */
import { spawn } from 'node:child_process';
import { clearTimeout, setTimeout } from 'node:timers';

import { isMain } from './is-main.mjs';

/**
 * How long to wait, after the kill itself is sent, for the child to actually
 * report its exit before giving up on it and resolving anyway. `SIGKILL` on
 * POSIX and `taskkill /F` on Windows are both meant to be unrefusable, but
 * "meant to be" is not a guarantee, and a wrapper whose whole purpose is
 * bounding a hang must not itself be able to hang waiting for the exit event
 * that proves the kill worked.
 */
const KILL_GRACE_MS = 10_000;

/**
 * The signals that mean "stop now" to this wrapper and are passed on to the
 * command's process tree before the wrapper itself exits. `SIGINT` is a
 * Ctrl-C, `SIGTERM` what a parent's timeout or a CI runner sends, `SIGHUP` a
 * closed terminal. Windows delivers a console Ctrl-C to every process on the
 * console by itself and has no `SIGTERM`, so there the listeners are inert.
 */
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Run `command` with `args`, killing it — and its whole process tree — if it
 * is still alive `timeoutMs` after it starts.
 *
 * Returns `{ status, timedOut }`, and `error` too when the command could not be
 * started (`status` is then 1). `status` is the child's own exit code when
 * it finished on its own before the timeout. Once a kill has been sent,
 * `status` is fixed at `null` regardless of what the child then reports —
 * POSIX and Windows represent a killed process differently (a signal versus
 * an exit code `taskkill` invents), and a caller that only needs to know
 * whether to trust the exit code should check `timedOut`, not `status`.
 *
 * `env` defaults to this process's own, as `child_process.spawn` does; a test
 * passes one to hand a fixture child a path with no other channel to it.
 */
export function runWithTimeout(command, args, timeoutMs, { env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
      // A POSIX child becomes the leader of its own process group, so the
      // group it heads — the child and everything it itself spawns, such as
      // the separate process `node --test` isolates each test file into —
      // can be killed as one unit via the negative-pid form below. Windows
      // has no equivalent spawn option; `taskkill /T` does the same tree walk
      // itself, from the child's own pid.
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      for (const signal of FORWARDED_SIGNALS) process.off(signal, stopEarly);
      resolvePromise(result);
    };

    let graceTimer;
    const kill = () => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
        // `spawn` itself reports a failure to launch `taskkill` (missing from
        // PATH, permission denied) asynchronously through this event; with no
        // listener, Node treats it as uncaught and crashes the wrapper before
        // the grace timer below ever gets to turn the hang it was trying to
        // stop into the 124 exit a caller can act on.
        killer.on('error', (error) => {
          console.error(`run-with-timeout: taskkill failed to run: ${error.message}`);
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // No such process group — the child already exited on its own
          // between the timer firing and this running. Nothing left to kill.
          child.kill('SIGKILL');
        }
      }
      graceTimer = setTimeout(() => {
        console.error(
          `run-with-timeout: process ${child.pid} did not report its exit within ` +
            `${KILL_GRACE_MS}ms of the kill; it may still be running`,
        );
        settle({ status: null, timedOut: true });
      }, KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      console.error(
        `run-with-timeout: "${[command, ...args].join(' ')}" did not exit within ${timeoutMs}ms; killing it`,
      );
      kill();
    }, timeoutMs);

    // The caller ending this wrapper early — Ctrl-C, a parent's own timeout —
    // ends the command's whole tree with it. Left to the default, the signal
    // would end only the wrapper, and the tree it was watching would run on
    // with nothing left to stop it: the orphan this wrapper exists to prevent,
    // made by the wrapper itself. The child's exit then settles this as a
    // failure, since a command cut short did not succeed.
    const stopEarly = () => {
      timedOut = true;
      kill();
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, stopEarly);

    child.on('error', (error) => settle({ status: 1, timedOut, error }));
    child.on('exit', (code) => settle({ status: timedOut ? null : code, timedOut }));
  });
}

/** `<timeoutSeconds> -- <command> [args...]` (the `--` is optional). */
function parseCliArgs(argv) {
  const [timeoutArg, ...rest] = argv;
  const commandArgs = rest[0] === '--' ? rest.slice(1) : rest;
  const timeoutMs = Number(timeoutArg) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || commandArgs.length === 0) return null;
  const [command, ...args] = commandArgs;
  return { command, args, timeoutMs };
}

// The entry point. scripts/ is outside jest's coverage scope; the exported
// function above is what test/scripts/run-with-timeout.test.mjs exercises.
if (isMain(import.meta.url)) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed === null) {
    console.error('usage: node scripts/run-with-timeout.mjs <timeoutSeconds> -- <command> [args...]');
    process.exit(1);
  }
  const { status, timedOut, error } = await runWithTimeout(
    parsed.command,
    parsed.args,
    parsed.timeoutMs,
  );
  if (error !== undefined) {
    console.error(`run-with-timeout: could not start "${parsed.command}": ${error.message}`);
  }
  process.exit(timedOut ? 124 : (status ?? 1));
}
