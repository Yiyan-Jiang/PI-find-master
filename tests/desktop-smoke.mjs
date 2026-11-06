import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const desktopIndex = process.argv.indexOf('--desktop-root');
const desktopRoot =
  desktopIndex >= 0
    ? process.argv[desktopIndex + 1]
    : process.env.PI_DESKTOP_ROOT;
if (!desktopRoot)
  throw Error(
    '请通过 --desktop-root 或 PI_DESKTOP_ROOT 指定实际安装目录；未运行桌面验证',
  );
const chunks = path.join(
  path.resolve(desktopRoot),
  'app/resources/agent-runtime/chunks',
);
const candidates = [];
for (const file of await fs.readdir(chunks))
  if (
    /^runner-.*\.js$/.test(file) &&
    (await fs.readFile(path.join(chunks, file), 'utf8')).includes(
      'TrustedExtensionRunner',
    )
  )
    candidates.push(path.join(chunks, file));
assert.equal(
  candidates.length,
  1,
  '必须唯一定位真实 Desktop TrustedExtensionRunner',
);
const runnerPath = candidates[0];
const { TrustedExtensionRunner } = await import(pathToFileURL(runnerPath));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'find-desktop-'));
let runner,
  failed = false;
try {
  smoke: {
  await fs.writeFile(path.join(tmp, 'AGENTS.md'), 'ROOT_CONSTRAINT');
  await fs.mkdir(path.join(tmp, 'child'));
  await fs.writeFile(path.join(tmp, 'child', 'AGENTS.md'), 'CHILD_CONSTRAINT');
  await fs.writeFile(path.join(tmp, 'child', 'code.txt'), 'data');
  const diagnostics = [],
    requests = [];
  let confirmationHook;
  let prompt = 'base',
    approved = false;
  const bridge = {
    sessionId: 'desktop-smoke',
    cwd: tmp,
    getModel: () => ({ id: 'probe' }),
    setModel: async () => true,
    getThinkingLevel: () => 'medium',
    setThinkingLevel() {},
    isIdle: () => true,
    abort() {},
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    compact() {},
    getSystemPrompt: () => prompt,
    getActiveTools: () => ['Read'],
    getAllTools: () => [],
    setActiveTools() {},
    getSessionName: () => '',
    setSessionName() {},
    sendUserMessage() {},
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    requestUi: async (_e, r) => {
      requests.push(JSON.stringify(r));
      if (confirmationHook) {
        const hook = confirmationHook;
        confirmationHook = undefined;
        await hook();
      }
      return { kind: r.kind, value: approved };
    },
    publishCommands() {},
    publishDiagnostics(d) {
      diagnostics.splice(0, diagnostics.length, ...d);
    },
  };
  const createRunner = () => new TrustedExtensionRunner({
    specs: [
      {
        id: 'local.pi-find-master',
        label: 'Environment finder',
        entry: path.join(root, 'src/extension.mjs'),
        root,
        source: 'user',
      },
    ],
    bridge,
  });
  runner = createRunner();
  const reports = await runner.load();
  assert.equal(reports[0].state, 'loaded');
  const registered = runner.getAgentTools().map((t) => t.name);
  for (const name of [
    'acceptance_plan',
    'acceptance_status',
    'run_acceptance',
    'task_record',
    'task_status',
  ])
    assert.ok(
      registered.includes(name),
      'missing acceptance integration: ' + name,
    );
  prompt = await runner.emitBeforeAgentStart('task', 'base');
  assert.ok(prompt.includes('ROOT_CONSTRAINT'));
  assert.ok(!prompt.includes('CHILD_CONSTRAINT'));
  const call = {
    type: 'tool_call',
    toolName: 'Read',
    input: { path: 'child/code.txt' },
  };
  const blocked = await runner.emit('tool_call', call);
  assert.ok(blocked.block);
  assert.ok(blocked.reason.includes('CHILD_CONSTRAINT'));
  assert.equal(await runner.emit('tool_call', call), undefined);
  await fs.writeFile(path.join(tmp, 'child', 'AGENTS.md'), 'UPDATED_RULE');
  assert.ok(
    (await runner.emit('tool_call', call)).reason.includes('UPDATED_RULE'),
  );
  await runner.emit('session_compact', { type: 'session_compact' });
  assert.ok((await runner.emit('tool_call', call)).reason.includes('UPDATED_RULE'),
    '压缩后重新提供子目录规则');
  assert.equal(await runner.emit('tool_call', call), undefined,
    '规则重新提供后重试放行');
  assert.ok(
    (
      await runner.emit('tool_call', {
        toolName: 'plugin_pi_session_orchestrator_SessionTask',
        input: { action: 'spawn', task: 'vague' },
      })
    ).block,
  );
  const tool = runner
    .getAgentTools()
    .find((t) => t.name === 'prepare_delegate');
  const prepared = await tool.execute(
    'prep',
    {
      project: 'child',
      task: 'read code',
      acceptance: 'report exact file paths',
      files: ['code.txt'],
    },
    AbortSignal.timeout(60000),
  );
  const handoff = JSON.parse(prepared.content[0].text);
  assert.ok(handoff.task.includes('UPDATED_RULE'));
  assert.ok(handoff.handoffId && handoff.dispatchTask.length < 1500);
  const dispatch = async (toolName, input) => runner.emit('tool_call', { toolName, input });
  assert.equal(await dispatch('Task', { task: handoff.dispatchTask + '\n请先读取交接记录。' }), undefined);
  await runner.emitBeforeAgentStart('next user turn', 'base');
  await runner.emit('session_compact', { type: 'session_compact' });
  assert.equal(await dispatch('plugin_pi_session_orchestrator_SessionTask', {
    action: 'send', kind: 'task', message: handoff.dispatchTask,
  }), undefined);
  assert.equal(await dispatch('plugin_pi_session_orchestrator_SessionTask', {
    action: 'send', kind: 'message', message: '普通消息无需交接',
  }), undefined);
  assert.equal(
    await runner.emit('tool_call', {
      toolName: 'plugin_pi_session_orchestrator_SessionTask',
      input: { action: 'spawn', task: handoff.task },
    }),
    undefined,
  );
  await runner.dispose();
  runner = createRunner();
  assert.equal((await runner.load())[0].state, 'loaded');
  await runner.emitBeforeAgentStart('after loader reload', 'base');
  assert.equal(await dispatch('Task', { task: handoff.dispatchTask }), undefined,
    '磁盘 handoff 必须跨 loader 重载');
  assert.equal(await dispatch('plugin_pi_session_orchestrator_SessionTask', {
    action: 'spawn', task: handoff.dispatchTask,
  }), undefined);
  assert.equal(await dispatch('plugin_pi_session_orchestrator_SessionTask', {
    action: 'send', message: handoff.dispatchTask,
  }), undefined);
  assert.equal(await dispatch('Task', { task: handoff.task }), undefined,
    '完整旧模式正文也跨重载可用');
  assert.ok((await dispatch('Task', { task: handoff.dispatchTask, project: '.' })).block,
    '不能把已准备的子项目交接用于另一项目');
  await fs.writeFile(path.join(tmp, 'child', 'AGENTS.md'), 'RULE_CHANGED_AFTER_HANDOFF');
  assert.ok((await dispatch('Task', { task: handoff.dispatchTask })).reason.includes('过期'));
  await fs.writeFile(path.join(tmp, 'child', 'AGENTS.md'), 'UPDATED_RULE');
  await fs.mkdir(path.join(tmp, '.local/pi-find'), { recursive: true });
  await fs.writeFile(
    path.join(tmp, '.local/pi-find/config.json'),
    JSON.stringify({
      tools: [
        {
          id: 'probe:run',
          category: 'other',
          steps: [
            {
              command: process.execPath,
              args: ['-e', 'console.log("REAL_EXEC_OK")'],
            },
          ],
        },
      ],
    }),
  );
  const run = runner.getAgentTools().find((t) => t.name === 'run_project_tool');
  const recordTool = runner.getAgentTools().find((t) => t.name === 'task_record');
  const invokeRecord = (args) => recordTool.execute('scope-regression', args, AbortSignal.timeout(60000));
  await invokeRecord({ action: 'create', id: 'delegate-scope', title: '同任务两个子代理', requirements: [
    { id: 'read', description: '读取并核对文件', profiles: [] },
  ] });
  const prepareLinked = async (task) => JSON.parse((await runner.getAgentTools().find((t) => t.name === 'prepare_delegate').execute(
    'scope-handoff', { taskId: 'delegate-scope', task, acceptance: '报告读取结果', files: ['child/code.txt'] }, AbortSignal.timeout(60000),
  )).content[0].text);
  const firstChild = await prepareLinked('第一个子任务');
  const secondChild = await prepareLinked('第二个子任务');
  assert.equal(await dispatch('Task', { task: firstChild.dispatchTask }), undefined,
    '第二次 prepare 的审计记录不能使第一个交接过期');
  assert.equal(await dispatch('Task', { task: secondChild.dispatchTask }), undefined);
  await invokeRecord({ action: 'note', id: 'delegate-scope', text: '继续执行，任务范围未变' });
  assert.equal(await dispatch('Task', { task: firstChild.dispatchTask }), undefined,
    '普通备注不能使交接过期');
  const delegateRecordPath = path.join(tmp, '.local/pi-find/tasks/task-delegate-scope.json');
  const delegateRecord = JSON.parse(await fs.readFile(delegateRecordPath, 'utf8'));
  delegateRecord.requirements[0].description = '验收需求已实质变更';
  await fs.writeFile(delegateRecordPath, JSON.stringify(delegateRecord));
  assert.ok((await dispatch('Task', { task: firstChild.dispatchTask })).reason.includes('过期'));
  assert.ok((await dispatch('Task', { task: secondChild.dispatchTask })).reason.includes('过期'));
  await recordTool.execute('tool-task', { action: 'create', id: 'tool-flow', title: '命令批准只在本任务复用', requirements: [] }, AbortSignal.timeout(60000));
  const denied = await run.execute(
    'denied',
    { toolId: 'probe:run' },
    AbortSignal.timeout(60000),
  );
  assert.ok(denied.isError);
  approved = true;
  const executed = await run.execute(
    'allowed',
    { toolId: 'probe:run' },
    AbortSignal.timeout(60000),
  );
  assert.equal(executed.isError, false);
  assert.ok(executed.content[0].text.includes('REAL_EXEC_OK'));
  const commandApprovalCount = requests.length;
  assert.equal((await run.execute('repeat', { toolId: 'probe:run' }, AbortSignal.timeout(60000))).isError, false);
  assert.equal(requests.length, commandApprovalCount);
  await invokeRecord({ action: 'note', id: 'tool-flow', text: '只追加进展备注' });
  assert.equal((await run.execute('after-note', { toolId: 'probe:run' }, AbortSignal.timeout(60000))).isError, false);
  assert.equal(requests.length, commandApprovalCount, '备注不改变批准范围');
  const toolRecordPath = path.join(tmp, '.local/pi-find/tasks/task-tool-flow.json');
  const toolRecord = JSON.parse(await fs.readFile(toolRecordPath, 'utf8'));
  toolRecord.requirements.push({ id: 'new-scope', description: '改变了本任务验收范围', profiles: [] });
  await fs.writeFile(toolRecordPath, JSON.stringify(toolRecord));
  approved = false;
  assert.equal((await run.execute('scope-changed', { toolId: 'probe:run' }, AbortSignal.timeout(60000))).isError, true);
  assert.equal(requests.length, commandApprovalCount + 1, '任务范围变化必须重新确认');
  approved = true;
  confirmationHook = async () => {
    const record = JSON.parse(await fs.readFile(toolRecordPath, 'utf8'));
    record.title = '等待确认期间目标改变';
    await fs.writeFile(toolRecordPath, JSON.stringify(record));
  };
  const changedWhileConfirming = JSON.parse((await run.execute('scope-race', { toolId: 'probe:run' }, AbortSignal.timeout(60000))).content[0].text);
  assert.equal(changedWhileConfirming.stage, 'approval_changed', '确认后须重新核对任务范围');
  const raceRequestCount = requests.length;
  assert.equal((await run.execute('new-scope', { toolId: 'probe:run' }, AbortSignal.timeout(60000))).isError, false);
  assert.equal(requests.length, raceRequestCount + 1, '新任务范围须再次确认');
  const localConfig = path.join(tmp, '.local/pi-find/config.json');
  const originalLocal = await fs.readFile(localConfig, 'utf8');
  const changedLocal = JSON.parse(originalLocal);
  changedLocal.tools[0].steps[0].args = ['-e', 'console.log("REAL_FAILURE"); process.exit(4)'];
  await fs.writeFile(localConfig, JSON.stringify(changedLocal));
  confirmationHook = async () => { throw Error('parent host proxy timeout: extensions.ui.request'); };
  const uiFailure = JSON.parse((await run.execute('ui-timeout', { toolId: 'probe:run' }, AbortSignal.timeout(60000))).content[0].text);
  assert.equal(uiFailure.stage, 'ui_confirmation_failed');
  const timeoutRequestCount = requests.length;
  const executionFailure = JSON.parse((await run.execute('test-failed', { toolId: 'probe:run' }, AbortSignal.timeout(60000))).content[0].text);
  assert.equal(requests.length, timeoutRequestCount + 1, 'UI 超时不缓存批准');
  assert.equal(executionFailure.stage, 'execution_failed');
  assert.equal(executionFailure.steps[0].exitCode, 4);
  await fs.writeFile(localConfig, originalLocal);
  console.log('PASS: actual Desktop loader handoffs across turns/compaction/reload, scope and stale-rule rejection, task-bound UI approval reuse, UI timeout retry, real process failure');
  if (process.argv.includes('--delegation-only')) break smoke;
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('config', 'user.name', 'Desktop smoke');
  git('config', 'user.email', 'desktop@example.invalid');
  await fs.writeFile(path.join(tmp, '.gitignore'), '.local/\n');
  await fs.writeFile(
    path.join(tmp, '.pi-find.json'),
    JSON.stringify({
      acceptance: {
        profiles: {
          proof: {
            kind: 'command',
            include: ['child/code.txt'],
            steps: [
              {
                command: process.execPath,
                args: ['-e', 'console.log("REAL_PROFILE_CHECK")'],
                env: {
                  PI_FIND_PUBLIC_ENV: 'visible-setting',
                  PI_FIND_TOKEN: 'secret-fixture',
                },
              },
            ],
          },
        },
        defaultProfiles: ['proof'],
        gates: { push: ['proof'] },
      },
    }),
  );
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline');
  const tools = Object.fromEntries(
    runner.getAgentTools().map((tool) => [tool.name, tool]),
  );
  const invoke = (name, args) =>
    tools[name].execute(name, args, AbortSignal.timeout(120000));
  const configuredFile = path.join(tmp, '.pi-find.json');
  const modernConfig = await fs.readFile(configuredFile, 'utf8');
  const legacySteps = [{ command: process.execPath, args: ['-e', 'console.log("3 passed (selected legacy tests)")'] }];
  await fs.writeFile(configuredFile, JSON.stringify({ e2eSteps: legacySteps }));
  const legacyBefore = JSON.parse((await invoke('acceptance_status', {})).content[0].text);
  assert.equal(legacyBefore.mode, 'legacy');
  assert.equal(legacyBefore.ok, false);
  assert.equal(legacyBefore.legacy.find((item) => item.kind === 'e2e').receipt, null);
  const legacyEntry = legacyBefore.legacy.find((item) => item.kind === 'e2e').entry;
  const legacyRun = spawnSync(legacyEntry.command, legacyEntry.args, { cwd: tmp, encoding: 'utf8' });
  assert.equal(legacyRun.status, 0, legacyRun.stderr);
  const legacyAfter = JSON.parse((await invoke('acceptance_status', {})).content[0].text);
  assert.equal(legacyAfter.ok, false, '旧模式检查通过不能冒充新版全量验收');
  assert.equal(legacyAfter.legacy.find((item) => item.kind === 'e2e').receipt.valid, true);
  assert.ok(legacyAfter.legacy.find((item) => item.kind === 'e2e').receipt.steps[0].stdoutTail.includes('3 passed'));
  assert.ok(legacyAfter.nextStep.includes('选择范围'));
  await fs.writeFile(configuredFile, modernConfig);
  const planned = await invoke('acceptance_plan', {});
  assert.equal(planned.isError, false, planned.content[0].text);
  assert.deepEqual(JSON.parse(planned.content[0].text).changedPaths, []);
  const created = await invoke('task_record', {
    action: 'create',
    id: 'ui-flow',
    title: '恢复后仍保留验收要求',
    requirements: [
      { id: 'content', description: '核对项目命令结果', profiles: ['proof'] },
    ],
  });
  assert.equal(created.isError, false);
  assert.equal(
    (await invoke('acceptance_status', { profiles: ['proof'] })).isError,
    true,
  );
  approved = false;
  assert.equal(
    (await invoke('run_acceptance', { profile: 'proof' })).isError,
    true,
  );
  approved = true;
  const validated = await invoke('run_acceptance', { profile: 'proof' });
  assert.equal(validated.isError, false, validated.content[0].text);
  assert.ok(requests.at(-1).includes('visible-setting'));
  assert.ok(
    requests.at(-1).includes('PI_FIND_TOKEN') &&
      requests.at(-1).includes('sha256'),
  );
  assert.ok(
    !requests.at(-1).includes('secret-fixture'),
    '敏感环境值不可直接展示在确认弹窗',
  );
  const approvedConfig = await fs.readFile(
    path.join(tmp, '.pi-find.json'),
    'utf8',
  );
  const approvalCount = requests.length;
  assert.equal((await invoke('run_acceptance', { profile: 'proof' })).isError, false);
  assert.equal(requests.length, approvalCount, '同一任务与配置复用 UI 批准');
  await invoke('task_record', { action: 'create', id: 'changed-approval', title: '新的任务必须重新确认', requirements: [] });
  confirmationHook = async () => {
    const config = JSON.parse(approvedConfig);
    config.acceptance.profiles.proof.steps = [
      {
        command: process.execPath,
        args: [
          '-e',
          'require("fs").writeFileSync(".local/unapproved-command","executed")',
        ],
      },
    ];
    await fs.writeFile(path.join(tmp, '.pi-find.json'), JSON.stringify(config));
  };
  const changedApproval = await invoke('run_acceptance', { profile: 'proof' });
  assert.equal(changedApproval.isError, true, '确认期间配置变化必须拒绝执行');
  await assert.rejects(fs.access(path.join(tmp, '.local/unapproved-command')), {
    code: 'ENOENT',
  });
  await fs.writeFile(path.join(tmp, '.pi-find.json'), approvedConfig);
  assert.equal(
    (await invoke('run_acceptance', { profile: 'proof' })).isError,
    false,
  );
  const complete = await invoke('task_status', { id: 'ui-flow' });
  assert.equal(JSON.parse(complete.content[0].text).status, 'passed');
  await invoke('task_record', {
    action: 'blocker',
    id: 'ui-flow',
    text: '尚未完成人工复核',
  });
  const blockedTask = JSON.parse(
    (await invoke('task_status', { id: 'ui-flow' })).content[0].text,
  );
  assert.equal(blockedTask.status, 'blocked');
  approved = false;
  assert.equal(
    (
      await invoke('task_record', {
        action: 'resolve_blocker',
        id: 'ui-flow',
        blockerId: blockedTask.openBlockers[0].id,
        text: '人工复核完成',
      })
    ).isError,
    true,
  );
  approved = true;
  await invoke('task_record', {
    action: 'resolve_blocker',
    id: 'ui-flow',
    blockerId: blockedTask.openBlockers[0].id,
    text: '人工复核完成',
  });
  assert.ok(
    requests.at(-1).includes('尚未完成人工复核'),
    '确认界面必须展示原阻塞事项',
  );
  const linked = JSON.parse(
    (
      await invoke('prepare_delegate', {
        taskId: 'ui-flow',
        requirementIds: ['content'],
        task: '复核文件',
        acceptance: '返回证据',
        files: ['child/code.txt'],
      })
    ).content[0].text,
  );
  assert.ok(linked.task.includes('content'));
  const summary = await runner.emitBeforeAgentStart('continue', 'base');
  assert.ok(summary.includes('恢复后仍保留验收要求'));
  await fs.writeFile(path.join(tmp, 'child/code.txt'), 'changed');
  assert.ok(
    JSON.parse(
      (await invoke('acceptance_plan', {})).content[0].text,
    ).changedPaths.includes('child/code.txt'),
  );
  assert.equal((await invoke('task_status', { id: 'ui-flow' })).isError, true);
  assert.equal(
    diagnostics.filter((d) =>
      ['handler_error', 'load_error', 'unsupported_api'].includes(d.kind),
    ).length,
    0,
    JSON.stringify(diagnostics),
  );
  console.log(
    'PASS: actual desktop loader, scoped rules, delegation, acceptance permission, real command evidence, task blockers and stale evidence',
  );
  }
} catch (error) {
  failed = true;
  throw error;
} finally {
  await runner?.dispose();
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('find-desktop-'));
  if (failed) console.error('Desktop smoke failure evidence preserved:', tmp);
  else await fs.rm(tmp, { recursive: true, force: true });
}
