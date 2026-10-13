import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(process.env.CHAT_HYDRATION_REPORT_DIR || tmpdir(), 'chat-hydration-'));
const home = join(out, 'home');
mkdirSync(home);
const env = Object.fromEntries(
  ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'),
  CI: '1',
});
const result = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'tests/components/chat-hydration-persistence.test.tsx',
    '--reporter=json',
    '--reporter=junit',
    '--outputFile.json=' + join(out, 'report.json'),
    '--outputFile.junit=' + join(out, 'junit.xml'),
  ],
  { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
);
writeFileSync(join(out, 'output.log'), (result.stdout || '') + (result.stderr || ''));
let valid = false;
try {
  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const junit = readFileSync(join(out, 'junit.xml'), 'utf8');
  const assertions = report.testResults.flatMap((file) => file.assertionResults);
  valid =
    result.status === 0 &&
    !result.error &&
    report.success === true &&
    report.numTotalTests === 4 &&
    report.numPassedTests === 4 &&
    assertions.length === 4 &&
    assertions.every((test) => test.status === 'passed') &&
    (junit.match(/<testcase(?:\s|>)/g) || []).length === 4 &&
    !/<(?:failure|error|skipped)(?:\s|>)/.test(junit);
} catch {
  /* Missing or malformed reports cannot pass. */
}
writeFileSync(
  join(out, 'result.json'),
  JSON.stringify(
    {
      valid,
      exitCode: result.status,
      signal: result.signal,
      timeoutOrSpawnError: result.error?.code || null,
      expectedTests: 4,
    },
    null,
    2,
  ) + '\n',
);
console.log(out);
process.exitCode = valid ? 0 : 1;
