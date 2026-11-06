import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const SKIP = new Set([
  '.git',
  '.local',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'target',
  'build',
  '.worktrees',
  '__pycache__',
]);
export const within = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (
    !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)
  );
};
async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
export async function readJson(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
export async function git(root, args) {
  const r = await runSteps(root, [{ command: 'git', args }], {
    timeoutMs: 60000,
    noRecord: true,
  });
  if (!r.ok || r.steps[0].outputTruncated)
    throw Error(
      r.steps[0].outputTruncated
        ? 'Git 输出超过上限，拒绝使用不完整结果'
        : r.steps[0].stderr ||
            r.steps[0].stdout ||
            (r.steps[0].timedOut ? 'Git 命令超过 60 秒未完成' : 'Git failed'),
    );
  return r.steps[0].stdout;
}
export async function repositoryRoot(root) {
  return (await git(root, ['rev-parse', '--show-toplevel'])).trim();
}

/** 有限扫描声明文件和工具文件名；不读取凭证，也不执行所发现的脚本。 */
export async function discover(workspace) {
  const root = await fs.realpath(workspace),
    tools = [],
    configFiles = [],
    rules = [],
    environments = [],
    caches = [],
    repositories = [],
    diagnostics = [];
  let visited = 0,
    truncated = false;
  async function scan(dir, depth) {
    if (++visited > 100) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (!['EACCES', 'EPERM', 'ENOENT'].includes(e.code)) throw e;
      diagnostics.push({ path: dir, error: e.message });
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    const rel = path.relative(root, dir).replaceAll('\\', '/');
    const prefix = rel || '.';
    if (names.has('.git')) repositories.push(dir);
    for (const n of ['AGENTS.override.md', 'AGENTS.md', 'AGENT.md'])
      if (names.has(n)) rules.push(path.join(dir, n));
    for (const n of [
      'pyproject.toml',
      'uv.lock',
      'requirements.txt',
      'Cargo.toml',
      'Makefile',
      'Taskfile.yml',
      'justfile',
      'package.json',
    ])
      if (names.has(n))
        configFiles.push(
          path.relative(root, path.join(dir, n)).replaceAll('\\', '/'),
        );
    if (names.has('package.json')) {
      let pkg;
      try {
        pkg = await readJson(path.join(dir, 'package.json'), {});
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        diagnostics.push({
          path: path.join(dir, 'package.json'),
          error: e.message,
        });
        pkg = {};
      }
      const manager = names.has('pnpm-lock.yaml')
        ? 'pnpm'
        : names.has('yarn.lock')
          ? 'yarn'
          : 'npm';
      for (const [name, value] of Object.entries(pkg.scripts || {}))
        if (typeof value === 'string')
          tools.push({
            id: prefix + ':' + manager + ':' + name,
            kind: 'package-script',
            cwd: dir,
            source: path.join(dir, 'package.json'),
            script: name,
            declaredCommand: value,
            manager,
            category: /e2e|smoke/.test(name)
              ? 'e2e'
              : /lint|check|typecheck|format:check/.test(name)
                ? 'quality'
                : /build|pack/.test(name)
                  ? 'build'
                  : 'other',
          });
    }
    for (const n of ['.venv', '.local/venv/backend'])
      for (const p of ['Scripts/python.exe', 'bin/python'])
        if (await exists(path.join(dir, n, p)))
          environments.push({ type: 'python', path: path.join(dir, n, p) });
    for (const n of ['.local/cache', '.local/downloads', 'node_modules'])
      if (await exists(path.join(dir, n))) caches.push(path.join(dir, n));
    const workflows = path.join(dir, '.github', 'workflows');
    if (await exists(workflows)) {
      const st = await fs.lstat(workflows);
      if (!st.isSymbolicLink())
        for (const e of await fs.readdir(workflows, { withFileTypes: true }))
          if (e.isFile() && /\.ya?ml$/.test(e.name))
            configFiles.push(
              path
                .relative(root, path.join(workflows, e.name))
                .replaceAll('\\', '/'),
            );
    }
    if (names.has('tools')) {
      const st = await fs.lstat(path.join(dir, 'tools'));
      if (st.isDirectory() && !st.isSymbolicLink())
        for (const e of (
          await fs.readdir(path.join(dir, 'tools'), { withFileTypes: true })
        ).slice(0, 150))
          if (e.isFile() && /\.(ps1|sh|py|mjs|js)$/.test(e.name))
            tools.push({
              id: prefix + ':file:' + e.name,
              kind: 'script-file',
              cwd: dir,
              source: path.join(dir, 'tools', e.name),
              category: /e2e|smoke/.test(e.name)
                ? 'e2e'
                : /build|pack/.test(e.name)
                  ? 'build'
                  : 'other',
              requiresArguments: true,
            });
    }
    if (depth < 2)
      for (const e of entries)
        if (
          e.isDirectory() &&
          !e.isSymbolicLink() &&
          !SKIP.has(e.name) &&
          !e.name.startsWith('.')
        )
          await scan(path.join(dir, e.name), depth + 1);
  }
  await scan(root, 0);
  return {
    root,
    repositories,
    rules,
    environments,
    caches,
    configFiles,
    tools,
    truncated,
    diagnostics,
  };
}

/** 按真实路径加载目标文件的祖先规则；子目录规则不泄漏到兄弟目录。 */
export async function rulesFor(workspace, target) {
  const root = await fs.realpath(workspace);
  let resolved = path.resolve(root, target || root);
  let ancestor = resolved;
  const missing = [];
  // 短路径与目录别名先统一为真实路径；新文件沿已有祖先解析。
  while (true) {
    try {
      resolved = path.join(await fs.realpath(ancestor), ...missing);
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return [];
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  if (!within(root, resolved)) return [];
  let dir = resolved;
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) dir = path.dirname(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    dir = path.dirname(dir);
  }
  const chain = [];
  while (within(root, dir)) {
    // 不跟随指向项目外的链接读取规则。
    try {
      if (!within(root, await fs.realpath(dir))) return [];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    chain.unshift(dir);
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  const result = [];
  for (const folder of chain)
    for (const n of ['AGENTS.override.md', 'AGENTS.md', 'AGENT.md']) {
      const p = path.join(folder, n);
      if (!(await exists(p))) continue;
      const actual = await fs.realpath(p);
      if (!within(root, actual)) throw Error('规则文件指向工作区之外：' + p);
      const st = await fs.stat(p);
      if (st.size > 128000) throw Error('规则文件过大，请拆分：' + p);
      const text = await fs.readFile(p, 'utf8');
      result.push({
        path: p,
        text,
        hash: crypto.createHash('sha256').update(text).digest('hex'),
        legacy: n === 'AGENT.md',
      });
      break;
    }
  return result;
}

/** 串行运行真实程序，保存退出码，首个失败即停；超时终止 Windows 进程树。 */
export async function runSteps(root, steps, options = {}) {
  const results = [];
  let receipt;
  let before, evidenceError;
  if (options.recordAs) {
    try { before = await sourceFingerprint(root); }
    catch (error) { evidenceError = error.message; }
  }
  for (const step of steps) {
    try {
    if (options.signal?.aborted) {
      results.push({
        command: step.command,
        args: step.args || [],
        cwd: path.resolve(root, step.cwd || '.'),
        exitCode: null,
        started: false,
        aborted: true,
        timedOut: false,
        stdout: '',
        stderr: '执行前已取消',
        durationMs: 0,
      });
      break;
    }
    const cwd = path.resolve(root, step.cwd || '.');
    if (!within(root, cwd)) throw Error('执行目录必须在指定项目内');
    const start = Date.now();
    let timedOut = false,
      aborted = false;
    let logPath;
    if (!options.noRecord) {
      const dir = path.join(root, '.local', 'pi-find', 'logs');
      await fs.mkdir(dir, { recursive: true });
      logPath = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.log`);
      await fs.writeFile(logPath, '');
    }
    const result = await new Promise((resolve, reject) => {
      const child = spawn(step.command, step.args || [], {
        cwd,
        env: { ...process.env, ...step.env },
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: [step.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '',
        spawnError,
        started = false,
        inputError,
        outputBytes = 0,
        writes = Promise.resolve();
      child.once('spawn', () => { started = true; });
      const limit = 512000;
      const capture = (b) => {
        outputBytes += b.length;
        if (logPath) {
          writes = writes.then(() => fs.appendFile(logPath, b));
          void writes.catch(() => {});
        }
      };
      if (step.stdin !== undefined) {
        child.stdin.on('error', (e) => {
          inputError = e;
          const message = Buffer.from('\n进程输入异常：' + e.message + '\n');
          capture(message);
          stderr += message.toString('utf8');
        });
        child.stdin.end(step.stdin);
      }
      child.stdout.on('data', (b) => {
        capture(b);
        stdout = (stdout + b.toString('utf8')).slice(-limit);
      });
      child.stderr.on('data', (b) => {
        capture(b);
        stderr = (stderr + b.toString('utf8')).slice(-limit);
      });
      const kill = () => {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore' },
          );
          killer.on('error', () => child.kill());
        } else if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (e) {
            if (e.code !== 'ESRCH') child.kill('SIGKILL');
          }
        }
      };
      const abort = () => {
        aborted = true;
        kill();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs || 120000);
      timer.unref();
      child.once('error', (e) => {
        spawnError = e;
        const message = Buffer.from('\n进程启动异常：' + e.message + '\n');
        capture(message);
        stderr += message.toString('utf8');
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        const observed = {
          command: step.command, args: step.args || [], cwd, started,
          exitCode: spawnError || inputError ? null : code,
          error: (spawnError || inputError)?.message, signal, stdout, stderr,
          outputTruncated: outputBytes > limit, logPath, timedOut, aborted,
          durationMs: Date.now() - start,
        };
        writes.then(() => resolve(observed),
          error => resolve({ ...observed, logError: error.message }));
      });
    });
    results.push(result);
    if (result.exitCode !== 0 || result.timedOut || result.aborted) break;
    if (
      step.requireOutputPattern &&
      !new RegExp(step.requireOutputPattern).test(result.stdout + result.stderr)
    ) {
      result.exitCode = 1;
      result.stderr +=
        '\n检查没有报告要求的实际通过结果（不能把全跳过当成通过）。';
      break;
    }
    } catch (error) {
      // 后续步骤的准备失败不能抹掉前面已经产生的真实副作用。
      results.push({ command: step.command, args: step.args || [],
        cwd: path.resolve(root, String(step.cwd || '.')), started: false,
        exitCode: null, error: error.message, stdout: '', stderr: error.message,
        aborted: false, timedOut: false, durationMs: 0 });
      break;
    }
  }
  const ok =
    results.length === steps.length &&
    results.length > 0 &&
    results.every((s) => s.exitCode === 0 && !s.timedOut && !s.aborted);
  evidenceError ||= results.find(step => step.logError)?.logError;
  if (options.recordAs && !evidenceError) {
    try {
      const after = await sourceFingerprint(root);
      const dir = path.join(root, '.local', 'pi-find');
      await fs.mkdir(dir, { recursive: true });
      receipt = {
        kind: options.recordAs, ok: ok && before === after, fingerprint: after,
        sourceChangedDuringRun: before !== after, steps: results,
        createdAt: new Date().toISOString(), commandsHash: hash(steps),
      };
      await fs.writeFile(path.join(dir, options.recordAs + '.json'), JSON.stringify(receipt, null, 2));
      if (!receipt.ok && ok) evidenceError = '执行前后源码变化，结果不能作为当前源码证据';
    } catch (error) { evidenceError = error.message; }
  }
  return { ok: ok && !evidenceError && (!receipt || receipt.ok), executionOk: ok,
    started: results.some(step => step.started), evidenceError, steps: results, receipt };
}
const hash = (x) =>
  crypto
    .createHash('sha256')
    .update(typeof x === 'string' ? x : JSON.stringify(x))
    .digest('hex');
export async function sourceFingerprint(root) {
  const files = (
    await git(root, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ])
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const h = crypto.createHash('sha256');
  for (const name of files) {
    if (name.startsWith('.local/')) continue;
    const p = path.join(root, name);
    h.update(name + '\0');
    try {
      const st = await fs.lstat(p);
      if (st.isDirectory()) {
        h.update(
          (await exists(path.join(p, '.git')))
            ? await sourceFingerprint(p)
            : await git(root, ['ls-files', '--stage', '--', name]),
        );
      } else
        h.update(
          st.isSymbolicLink() ? await fs.readlink(p) : await fs.readFile(p),
        );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      h.update('[deleted]');
    }
  }
  return h.digest('hex');
}
export async function validationStatus(root, kind, steps) {
  const receipt = await readJson(
    path.join(root, '.local', 'pi-find', kind + '.json'),
    null,
  );
  return {
    kind,
    valid:
      !!receipt?.ok &&
      receipt.fingerprint === (await sourceFingerprint(root)) &&
      (!steps || receipt.commandsHash === hash(steps)),
    createdAt: receipt?.createdAt,
    sourceChangedDuringRun: receipt?.sourceChangedDuringRun,
  };
}
function matches(name, pattern) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp('^' + escaped + '$').test(name);
}
export function deniedFiles(files, deny) {
  return files.filter((n) => deny.some((p) => matches(n, p)));
}
export async function inspectStaged(root, deny) {
  const staged = (
    await git(root, [
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
      '-z',
    ])
  )
    .split('\0')
    .filter(Boolean);
  const unstaged = new Set(
    (await git(root, ['diff', '--name-only', '-z']))
      .split('\0')
      .filter(Boolean),
  );
  return {
    staged,
    denied: deniedFiles(staged, deny),
    partiallyStaged: staged.filter((n) => unstaged.has(n)),
  };
}

export async function loadConfig(root) {
  const shared = await readJson(path.join(root, '.pi-find.json'), {}),
    local = await readJson(
      path.join(root, '.local', 'pi-find', 'config.json'),
      {},
    );
  return {
    ...{ tools: [], deny: [], requireE2E: false },
    ...shared,
    ...local,
    ...(shared.acceptance !== undefined || local.acceptance !== undefined
      ? { acceptance: { ...shared.acceptance, ...local.acceptance } }
      : {}),
  };
}
export function commandForTool(tool) {
  if (tool.steps) return tool.steps;
  if (
    tool.kind === 'package-script' &&
    (!/^[\w:.-]+$/.test(tool.script) ||
      !['npm', 'pnpm', 'yarn'].includes(tool.manager))
  )
    throw Error('脚本名称包含 shell 特殊字符，请通过显式程序/参数配置调用。');
  if (tool.kind === 'package-script')
    return process.platform === 'win32'
      ? [
          {
            command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/s', '/c', `${tool.manager} run ${tool.script}`],
            cwd: tool.cwd,
          },
        ]
      : [{ command: tool.manager, args: ['run', tool.script], cwd: tool.cwd }];
  throw Error(
    '脚本需要参数；请先读取脚本说明并用显式配置登记，不猜测调用参数。',
  );
}
