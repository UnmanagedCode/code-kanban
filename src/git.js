// Read-only git helper: resolves a directory's current HEAD sha for stamping a
// landed task's commit hash. Never throws — a missing dir, a non-repo, or no
// commits all resolve to null so a caller can degrade gracefully.
import { execFile } from 'node:child_process';

function run(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

export async function headSha(dir) {
  return run(dir, ['rev-parse', 'HEAD']);
}
