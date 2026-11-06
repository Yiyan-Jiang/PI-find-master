import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-acceptance-'));
const exec = (command, args) => {
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const call = (...args) => {
  const r = spawnSync(
    process.execPath,
    [cli, ...args, '--root', root, '--json'],
    { encoding: 'utf8' },
  );
  return {
    ...r,
    data: (() => {
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    })(),
  };
};
let checks = 0;
const check = (v, label) => {
  assert.ok(v, label);
  checks++;
  console.log(`ok ${checks}: ${label}`);
};
if (process.argv.includes('--stdin-regression')) {
  try {
    const { runSteps } = await import('../src/core.mjs');
    const result = await runSteps(root, [
      {
        command: process.execPath,
        args: ['-e', 'process.stdin.destroy();process.exit(0)'],
        stdin: 'x'.repeat(4 * 1024 * 1024),
      },
    ]);
    check(
      !result.ok &&
        result.steps[0].exitCode === null &&
        result.steps[0].error &&
        result.steps[0].stderr.includes('进程输入异常') &&
        (await fs.readFile(result.steps[0].logPath, 'utf8')),
      'real subprocess early stdin close fails with persisted input error',
    );
    console.log('acceptance stdin regression E2E passed: 1 check');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  process.exit(0);
}
// 审查修复只跑真实仓库/进程定向回归，避免重复执行整套。
if (process.argv.includes('--regressions')) {
  try {
    exec('git', ['init', '-q']);
    exec('git', ['config', 'user.email', 'test@example.invalid']);
    exec('git', ['config', 'user.name', 'Acceptance regression']);
    await fs.writeFile(path.join(root, '.gitignore'), '.local/\n');
    await fs.writeFile(path.join(root, 'source.txt'), 'input\n');
    const cfg = {
      acceptance: {
        profiles: {
          command: {
            kind: 'command',
            include: ['source.txt'],
            steps: [
              {
                command: process.execPath,
                args: ['-e', 'console.log("first-step-completed")'],
              },
            ],
          },
          test: {
            kind: 'test',
            include: ['source.txt'],
            steps: [{ command: process.execPath, args: ['runner.mjs'] }],
            report: { format: 'junit', path: '.local/report.xml' },
            minPassed: 1,
          },
        },
        defaultProfiles: ['command'],
        gates: { push: ['test'] },
      },
    };
    const save = () =>
      fs.writeFile(path.join(root, '.pi-find.json'), JSON.stringify(cfg));
    await save();
    await fs.writeFile(path.join(root, 'runner.mjs'), '');
    exec('git', ['add', '.']);
    exec('git', ['commit', '-qm', 'fixture']);
    check(
      call('run', 'command').status === 0,
      'regression command fixture passes',
    );
    check(
      call('gate', 'constructor').data.status === 'unconfigured',
      'prototype action name is explicitly unconfigured',
    );
    const engineUrl = new URL('../src/acceptance.mjs', import.meta.url).href;
    const api = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {getAcceptanceStatus} from ${JSON.stringify(engineUrl)};console.log(JSON.stringify(await getAcceptanceStatus(${JSON.stringify(root)},{profileIds:['command'],action:'push'})));`,
      ],
      { encoding: 'utf8' },
    );
    check(
      !JSON.parse(api.stdout).ok,
      'cross-process API cannot override gate with profileIds',
    );
    await fs.writeFile(
      path.join(root, '.local/pi-find/acceptance/run.lock'),
      JSON.stringify({ profileId: 'test' }),
    );
    check(
      call('status').data.profiles[0].status === 'blocked',
      'existing project lock blocks old successful status',
    );
    await fs.rm(path.join(root, '.local/pi-find/acceptance/run.lock'));
    const receiptPath = path.join(
      root,
      '.local/pi-find/acceptance/command.json',
    );
    const originalReceipt = await fs.readFile(receiptPath, 'utf8');
    await fs.writeFile(
      receiptPath,
      JSON.stringify({ ...JSON.parse(originalReceipt), steps: [] }),
    );
    check(
      !call('status').data.ok,
      'missing execution steps cannot count as successful evidence',
    );
    await fs.writeFile(receiptPath, originalReceipt);
    cfg.acceptance.profiles.command.steps.push({
      command: 'pi-find-nonexistent-binary',
      args: [],
    });
    await save();
    const failed = call('run', 'command');
    check(
      !failed.data.ok &&
        failed.data.steps.length === 2 &&
        failed.data.steps[0].stdout.includes('first-step-completed') &&
        failed.data.steps[1].error &&
        (await fs.readFile(failed.data.steps[1].logPath, 'utf8')),
      'spawn failure preserves prior real steps and startup error log',
    );
    await fs.writeFile(
      path.join(root, '.local/pi-find/config.json'),
      JSON.stringify({ acceptance: { defaultProfiles: ['toString'] } }),
    );
    check(
      call('status').data.profiles[0].status === 'unconfigured',
      'prototype profile ID remains unconfigured',
    );
    await fs.rm(path.join(root, '.local/pi-find/config.json'));
    for (const [label, xml] of [
      [
        'unexecuted',
        '<testsuite tests="1"><testcase status="notrun"/></testsuite>',
      ],
      [
        'CDATA control',
        '<testsuite tests="1"><testcase><system-out><![CDATA[\u0000]]></system-out></testcase></testsuite>',
      ],
      ['false declared count', '<testsuite tests="8"><testcase/></testsuite>'],
    ]) {
      await fs.writeFile(
        path.join(root, 'runner.mjs'),
        `import fs from 'node:fs';fs.mkdirSync('.local',{recursive:true});fs.writeFileSync('.local/report.xml',${JSON.stringify(xml)});`,
      );
      check(call('run', 'test').status !== 0, 'strict JUnit rejects ' + label);
    }
    console.log(`acceptance regression E2E passed: ${checks} checks`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  process.exit(0);
}
try {
  exec('git', ['init', '-q']);
  exec('git', ['config', 'user.email', 'test@example.invalid']);
  exec('git', ['config', 'user.name', 'Acceptance E2E']);
  await fs.writeFile(path.join(root, '.gitignore'), '.local/\n');
  await fs.writeFile(path.join(root, 'source.txt'), 'hello\n');
  check(call('init').status === 0, 'init creates public configuration');
  check(
    call('status').data.profiles[0].status === 'not_run',
    'repository without HEAD can query development evidence',
  );
  const config = {
    acceptance: {
      profiles: {
        verify: {
          kind: 'test',
          include: ['source.txt'],
          steps: [{ command: process.execPath, args: ['runner.mjs'] }],
          report: { format: 'junit', path: '.local/report.xml' },
          minPassed: 1,
        },
        command: {
          kind: 'command',
          include: ['source.txt'],
          steps: [
            { command: process.execPath, args: ['-e', 'console.log("done")'] },
          ],
        },
        timeout: {
          kind: 'command',
          include: ['source.txt'],
          steps: [
            {
              command: process.execPath,
              args: [
                '-e',
                'require("fs").writeFileSync(".local/started","yes");setInterval(()=>{},1000)',
              ],
            },
          ],
        },
      },
      defaultProfiles: ['verify'],
      gates: { push: ['verify'] },
      impact: [{ paths: ['source.txt'], profiles: ['verify'] }],
    },
  };
  const writeConfig = () =>
    fs.writeFile(path.join(root, '.pi-find.json'), JSON.stringify(config));
  const report = (xml) =>
    fs.writeFile(
      path.join(root, 'runner.mjs'),
      `import fs from 'node:fs';fs.mkdirSync('.local',{recursive:true});fs.writeFileSync('.local/report.xml',${JSON.stringify(xml)});`,
    );
  const good =
    '<testsuites tests="1" failures="0" errors="0" skipped="0"><testsuite tests="1"><testcase name="real"/></testsuite></testsuites>';
  await writeConfig();
  await report(good);
  check(call('run', 'command').status === 0, 'unborn Git permits real command acceptance');
  check(call('plan').data.reasonCode === 'no_head', 'unborn Git returns complete candidate plan');
  check(call('gate', 'push').data.profiles[0].status === 'blocked', 'unborn Git delivery remains blocked');
  exec('git', ['add', '.']);
  exec('git', ['commit', '-qm', 'fixture']);
  const publicBefore = await fs.readFile(
    path.join(root, '.pi-find.json'),
    'utf8',
  );
  check(
    call('init').data.created === false &&
      (await fs.readFile(path.join(root, '.pi-find.json'), 'utf8')) ===
        publicBefore,
    'init does not overwrite existing public config',
  );
  check(call('status').status !== 0, 'not run blocks');
  check(call('run', 'verify').status === 0, 'real test report passes');
  check(call('gate', 'push').status === 0, 'HEAD input bound');
  await fs.writeFile(path.join(root, 'outside.txt'), 'out');
  check(call('status').status === 0, 'outside scope reused');
  await fs.writeFile(path.join(root, 'source.txt'), 'changed');
  check(call('status').status !== 0, 'scope changed stale');
  check(call('run', 'verify').status === 0, 'dirty development can run');
  check(
    call('gate', 'push').status !== 0,
    'uncommitted related input blocks push',
  );
  exec('git', ['add', 'source.txt']);
  exec('git', ['commit', '-qm', 'updated input']);
  check(call('gate', 'push').status === 0, 'new HEAD with same inputs reuses');
  await fs.unlink(path.join(root, 'source.txt'));
  check(call('status').status !== 0, 'deleted scope stale');
  await fs.writeFile(path.join(root, 'source.txt'), 'changed');
  await fs.writeFile(path.join(root, '.local/report.xml'), 'tampered');
  check(call('status').status !== 0, 'report hash checked');
  await report(
    '<testsuite tests="1" skipped="1"><testcase><skipped/></testcase></testsuite>',
  );
  check(call('run', 'verify').status !== 0, 'all skipped fails');
  await report(
    '<testsuite tests="1" errors="1"><testcase><error>broken</error></testcase></testsuite>',
  );
  check(call('run', 'verify').status !== 0, 'report error fails');
  await report('<testsuite tests="1"><testcase/></WRONG>');
  check(call('run', 'verify').status !== 0, 'malformed XML fails');
  await report('<testsuite tests="8"><testcase/></testsuite>');
  check(
    call('run', 'verify').status !== 0,
    'JUnit declared counts cannot invent passed tests',
  );
  await report('<testsuite tests="1"><testcase status="notrun"/></testsuite>');
  check(
    call('run', 'verify').status !== 0,
    'unexecuted testcase status cannot count as passed',
  );
  await fs.writeFile(
    path.join(root, 'runner.mjs'),
    'console.log("no report");',
  );
  check(
    call('run', 'verify').status !== 0,
    'stale report archived cannot pass',
  );
  check(
    call('run', 'command').status === 0,
    'command does not require test count',
  );
  check(
    call('run', 'timeout', '--timeout', '100').status !== 0,
    'real process timeout fails',
  );
  await fs.rm(path.join(root, '.local/started'), { force: true });
  const engineUrl = new URL('../src/acceptance.mjs', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import fs from 'node:fs';import {runAcceptance} from ${JSON.stringify(engineUrl)};const c=new AbortController();const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(root, '.local/started'))})){clearInterval(poll);c.abort();}},20);const cap=setTimeout(()=>c.abort(),30000);console.log(JSON.stringify(await runAcceptance(${JSON.stringify(root)},'timeout',{signal:c.signal})));clearTimeout(cap);clearInterval(poll);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  await new Promise((resolve) => child.once('close', resolve));
  const cancelled = JSON.parse(output);
  check(
    cancelled.ok === false && cancelled.steps.some((s) => s.aborted),
    'real running subprocess AbortSignal cancellation persisted',
  );
  const engine = await import('../src/acceptance.mjs');
  check(
    (await engine.selectProfiles(root, ['unknown.xyz'])).length > 1,
    'unknown impact remains conservative',
  );
  check(
    !(
      await engine.getAcceptanceStatus(root, {
        profileIds: ['command'],
        action: 'unknown-action',
      })
    ).ok,
    'profileIds cannot override unknown action gate',
  );
  check(
    !(
      await engine.getAcceptanceStatus(root, {
        profileIds: ['command'],
        action: 'push',
      })
    ).ok,
    'profileIds cannot bypass required gate profiles',
  );
  config.acceptance.profiles.verify.include = ['new*.txt'];
  await writeConfig();
  await report(good);
  await fs.writeFile(path.join(root, 'new1.txt'), 'one');
  check(call('run', 'verify').status === 0, 'untracked scope can run');
  check(
    call('gate', 'push').status !== 0,
    'untracked related input not delivered',
  );
  await fs.writeFile(path.join(root, 'new2.txt'), 'two');
  check(call('status').status !== 0, 'new matching file invalidates');
  config.acceptance.profiles.verify.steps = [
    {
      command: process.execPath,
      args: [
        '-e',
        'require("fs").writeFileSync("new3.txt","during");require("fs").writeFileSync(".local/report.xml",' +
          JSON.stringify(good) +
          ')',
      ],
    },
  ];
  await writeConfig();
  check(
    call('run', 'verify').status !== 0,
    'new matching input during command fails',
  );
  config.acceptance.profiles.command.environmentKeys = ['PI_ACCEPTANCE_E2E'];
  config.acceptance.defaultProfiles = ['command'];
  await writeConfig();
  check(
    call('run', 'command').status === 0,
    'environment bound command passes',
  );
  process.env.PI_ACCEPTANCE_E2E = 'changed';
  check(call('status').status !== 0, 'selected environment invalidates');
  delete process.env.PI_ACCEPTANCE_E2E;
  await fs.mkdir(path.join(root, '.local/pi-find'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.local/pi-find/config.json'),
    JSON.stringify({ acceptance: { defaultProfiles: ['missing'] } }),
  );
  check(
    call('status').data.profiles[0].status === 'unconfigured',
    'local acceptance shallow override preserves public profiles and exposes missing ID',
  );
  await fs.rm(path.join(root, '.local/pi-find/config.json'));
  await fs.writeFile(
    path.join(root, '.local/pi-find/config.json'),
    JSON.stringify({ acceptance: { defaultProfiles: ['toString'] } }),
  );
  check(
    call('status').data.profiles[0].status === 'unconfigured',
    'prototype names cannot resolve as configured profile',
  );
  await fs.rm(path.join(root, '.local/pi-find/config.json'));
  config.acceptance.profiles.command.include = ['nothing-matches'];
  await writeConfig();
  check(call('run', 'command').status !== 0, 'no matching scope cannot pass');
  config.acceptance.profiles.command.include = ['source.txt'];
  config.acceptance.profiles.command.steps = [
    {
      command: process.execPath,
      args: ['-e', 'console.log("first-step-completed")'],
    },
    { command: 'pi-find-nonexistent-binary', args: [] },
  ];
  await writeConfig();
  const spawnFailure = call('run', 'command');
  check(
    spawnFailure.status !== 0 &&
      spawnFailure.data.steps.length === 2 &&
      spawnFailure.data.steps[0].stdout.includes('first-step-completed') &&
      spawnFailure.data.steps[1].error &&
      call('status').data.profiles[0].status === 'failed',
    'later spawn exception preserves completed steps and failure logs',
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pi-acceptance-outside-'),
  );
  try {
    await fs.symlink(
      outside,
      path.join(root, '.local/escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    config.acceptance.profiles.command.steps = [
      {
        command: process.execPath,
        args: ['--version'],
        cwd: '.local/escape/missing',
      },
    ];
    await writeConfig();
    check(
      call('run', 'command').status !== 0,
      'nonexistent child under escaping ancestor rejected',
    );
  } finally {
    await fs.rm(path.join(root, '.local/escape'), { force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
  config.acceptance.profiles.command.steps = [
    { command: process.execPath, args: ['--version'] },
  ];
  await writeConfig();
  await fs.rm(path.join(root, '.local/started'), { force: true });
  const controller = new AbortController(),
    pending = engine.runAcceptance(root, 'timeout', {
      signal: controller.signal,
    });
  let started = false;
  for (let i = 0; i < 1000; i++) {
    try {
      await fs.access(path.join(root, '.local/started'));
      started = true;
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!started) {
    controller.abort();
    await pending;
    throw Error('cancellation fixture did not start');
  }
  try {
    check(
      call('run', 'command').data.status === 'blocked',
      'project lock rejects concurrent profile process',
    );
  } finally {
    controller.abort();
  }
  check(
    (await pending).steps.some((s) => s.aborted),
    'running process tree cancellation recorded',
  );
  await fs.writeFile(
    path.join(root, '.gitattributes'),
    'source.txt text eol=lf\n',
  );
  await fs.writeFile(path.join(root, 'source.txt'), 'normalized\n');
  exec('git', ['add', '.gitattributes', 'source.txt']);
  exec('git', ['commit', '-qm', 'normalized input']);
  await fs.writeFile(path.join(root, 'source.txt'), 'normalized\r\n');
  config.acceptance.gates.push = ['command'];
  await writeConfig();
  check(
    call('run', 'command').status === 0 && call('gate', 'push').status === 0,
    'Git normalized CRLF input binds to LF HEAD',
  );
  const commit = exec('git', ['rev-parse', 'HEAD']).trim();
  exec('git', [
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,' + commit + ',module-fixture',
  ]);
  config.acceptance.profiles.command.include = ['module-fixture'];
  await writeConfig();
  check(
    call('run', 'command').status !== 0,
    'gitlink input explicitly rejected',
  );
  exec('git', ['update-index', '--force-remove', 'module-fixture']);
  check(call('--help').status === 0, 'help succeeds');
  console.log(`acceptance E2E passed: ${checks} checks`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
