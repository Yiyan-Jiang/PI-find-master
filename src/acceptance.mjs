import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { git, loadConfig, runSteps, readJson, within, validationStatus } from './core.mjs';

const hash = (value) =>
  crypto
    .createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const posix = (value) => value.replaceAll('\\', '/');
const ensure = (condition, message) => {
  if (!condition) throw Error(message);
};
const plain = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) && value.every((x) => typeof x === 'string');
const keys = (value, allowed, label) =>
  ensure(
    Object.keys(value).every((key) => allowed.includes(key)),
    label + ' 包含未知字段',
  );
const local = (root) => path.join(root, '.local', 'pi-find', 'acceptance');

/** 检查每层实际祖先；不允许链接目录或链接输入，含尚未存在的输出路径。 */
export async function safeAcceptancePath(root, relative) {
  ensure(
    typeof relative === 'string' &&
      !path.isAbsolute(relative) &&
      !path.win32.isAbsolute(relative),
    '路径必须为项目内相对路径',
  );
  relative = posix(relative);
  ensure(
    !relative.split('/').includes('..') && !relative.includes('\0'),
    '路径不能包含 .. 或 NUL',
  );
  const target = path.resolve(root, relative);
  ensure(within(root, target), '路径越界');
  let current = root;
  for (const part of path
    .relative(root, target)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      const st = await fs.lstat(current);
      ensure(!st.isSymbolicLink(), '不支持符号链接或 junction：' + relative);
      ensure(
        within(root, await fs.realpath(current)),
        '真实路径越界：' + relative,
      );
    } catch (e) {
      if (e.code === 'ENOENT') break;
      throw e;
    }
  }
  return target;
}
function glob(pattern) {
  ensure(
    typeof pattern === 'string' && pattern.length > 0,
    'glob 必须为非空字符串',
  );
  pattern = posix(pattern);
  ensure(
    !path.posix.isAbsolute(pattern) &&
      !path.win32.isAbsolute(pattern) &&
      !pattern.split('/').includes('..') &&
      !pattern.includes('\0'),
    'glob 必须在项目内',
  );
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(out + '$');
}
function selected(name, p) {
  return (
    !['.local', '.git'].includes(name.split('/')[0]) &&
    (p.include || ['**']).some((g) => glob(g).test(name)) &&
    !(p.exclude || []).some((g) => glob(g).test(name))
  );
}
function validate(c) {
  ensure(plain(c) && plain(c.profiles), 'acceptance.profiles 必须是对象');
  keys(c, ['profiles', 'gates', 'defaultProfiles', 'impact'], 'acceptance');
  for (const [id, p] of Object.entries(c.profiles)) {
    ensure(idPattern.test(id) && plain(p), 'profile ID 或配置无效：' + id);
    ensure(
      ['command', 'test'].includes(p.kind),
      'profile.kind 必须为 command/test：' + id,
    );
    keys(
      p,
      [
        'kind',
        'description',
        'include',
        'exclude',
        'steps',
        'report',
        'minPassed',
        'allowSkipped',
        'environmentKeys',
      ],
      'profile',
    );
    for (const key of ['include', 'exclude'])
      if (p[key] !== undefined) {
        ensure(strings(p[key]), key + ' 必须为 glob 数组');
        p[key].forEach(glob);
      }
    ensure(
      Array.isArray(p.steps) && p.steps.length > 0,
      'profile.steps 不可为空：' + id,
    );
    for (const s of p.steps) {
      ensure(
        plain(s) && typeof s.command === 'string' && s.command.length > 0,
        'step.command 无效',
      );
      keys(s, ['command', 'args', 'cwd', 'env'], 'step');
      ensure(
        s.args === undefined || strings(s.args),
        'step.args 必须是字符串数组',
      );
      ensure(s.cwd === undefined || typeof s.cwd === 'string', 'step.cwd 无效');
      ensure(
        s.env === undefined ||
          (plain(s.env) &&
            Object.entries(s.env).every(
              ([k, v]) =>
                /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string',
            )),
        'step.env 无效',
      );
    }
    ensure(
      p.environmentKeys === undefined ||
        (strings(p.environmentKeys) &&
          p.environmentKeys.every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))),
      'environmentKeys 无效',
    );
    if (p.kind === 'test')
      ensure(
        plain(p.report) &&
          p.report.format === 'junit' &&
          Number.isInteger(p.minPassed) &&
          p.minPassed >= 1,
        'test 必须配置 JUnit 报告且 minPassed >= 1',
      );
    if (p.report) {
      ensure(
        plain(p.report) &&
          p.report.format === 'junit' &&
          typeof p.report.path === 'string' &&
          posix(p.report.path).startsWith('.local/'),
        '报告必须是 .local/ 下的 JUnit 文件',
      );
      keys(p.report, ['format', 'path'], 'report');
      glob(p.report.path);
      ensure(!/[?*]/.test(p.report.path), '报告路径不可使用通配符');
    }
    ensure(
      p.allowSkipped === undefined || typeof p.allowSkipped === 'boolean',
      'allowSkipped 必须为布尔值',
    );
  }
  ensure(
    c.defaultProfiles === undefined || strings(c.defaultProfiles),
    'defaultProfiles 必须为 ID 数组',
  );
  ensure(c.gates === undefined || plain(c.gates), 'gates 必须为对象');
  for (const ids of Object.values(c.gates || {}))
    ensure(strings(ids) && ids.length > 0, 'gate 必须有至少一个 profile');
  ensure(
    c.impact === undefined || Array.isArray(c.impact),
    'impact 必须是数组',
  );
  for (const rule of c.impact || []) {
    ensure(
      plain(rule) &&
        strings(rule.paths) &&
        rule.paths.length &&
        strings(rule.profiles) &&
        rule.profiles.length,
      'impact 必须包含 paths/profiles',
    );
    keys(rule, ['paths', 'profiles'], 'impact');
    rule.paths.forEach(glob);
  }
  return c;
}
export async function loadAcceptanceConfig(root) {
  root = await fs.realpath(root);
  await safeAcceptancePath(root, '.pi-find.json');
  await safeAcceptancePath(root, '.local/pi-find/config.json');
  const c = (await loadConfig(root)).acceptance;
  return c === undefined ? null : validate(c);
}
export async function selectProfiles(root, changedPaths) {
  const c = await loadAcceptanceConfig(root);
  if (!c) return [];
  const all = Object.keys(c.profiles),
    out = new Set(c.defaultProfiles || []);
  const conservative = [
    ...all,
    ...Object.values(c.gates || {}).flat(),
    ...(c.impact || []).flatMap((r) => r.profiles),
  ];
  if (changedPaths === undefined) conservative.forEach((id) => out.add(id));
  else
    for (const file of changedPaths) {
      const rules = (c.impact || []).filter((r) =>
        r.paths.some((g) => glob(g).test(posix(file))),
      );
      if (!rules.length) conservative.forEach((id) => out.add(id));
      else rules.flatMap((r) => r.profiles).forEach((id) => out.add(id));
    }
  return [...out];
}
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}
async function storage(root) {
  return safeAcceptancePath(root, '.local/pi-find/acceptance');
}
const runtime = () => ({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
});
const environment = (p) =>
  hash(
    Object.fromEntries(
      (p.environmentKeys || []).map((key) => [key, process.env[key] ?? null]),
    ),
  );
async function snapshot(root, p) {
  const stage = (await git(root, ['ls-files', '--stage', '-z']))
      .split('\0')
      .filter(Boolean),
    modes = new Map();
  for (const row of stage) {
    const m = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(row);
    ensure(m, '无法解析 Git index');
    if (selected(m[4], p)) {
      ensure(m[3] === '0', '输入存在未解决 Git 冲突');
      ensure(
        !['120000', '160000'].includes(m[1]),
        '不支持 symlink/gitlink 输入：' + m[4],
      );
      modes.set(m[4], m[1]);
    }
  }
  const names = new Set([
    ...(
      await git(root, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ])
    )
      .split('\0')
      .filter((n) => n && selected(n, p)),
    ...modes.keys(),
  ]);
  const files = [];
  for (const name of [...names].sort()) {
    const filename = await safeAcceptancePath(root, name);
    try {
      const st = await fs.lstat(filename);
      ensure(st.isFile(), '输入必须为常规文件：' + name);
      const bytes = await fs.readFile(filename);
      const mode =
        process.platform === 'win32'
          ? modes.get(name) || '100644'
          : st.mode & 0o111
            ? '100755'
            : '100644';
      files.push({ path: name, bytesHash: hash(bytes), mode });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      files.push({ path: name, deleted: true });
    }
  }
  const present = files.filter((f) => !f.deleted);
  ensure(present.length, '作用域没有匹配的现存输入');
  // Git 自己按每个路径的 attributes/换行过滤计算内容；批量 stdin 避免逐文件启动进程。
  const quoted = (name) =>
    '"' +
    name
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('\t', '\\t') +
    '"';
  const result = await runSteps(
    root,
    [
      {
        command: 'git',
        args: ['hash-object', '--stdin-paths'],
        stdin: present.map((f) => quoted(f.path)).join('\n') + '\n',
      },
    ],
    { noRecord: true, timeoutMs: 60000 },
  );
  ensure(
    result.ok && !result.steps[0].outputTruncated,
    'Git 批量内容指纹失败或输出超限',
  );
  const hashes = result.steps[0].stdout.trim().split(/\r?\n/);
  ensure(
    hashes.length === present.length &&
      hashes.every((h) => /^[a-f0-9]{40,64}$/.test(h)),
    'Git 内容指纹格式错误',
  );
  present.forEach((file, i) => (file.gitHash = hashes[i]));
  return files;
}
async function headBinding(root, p, files) {
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  const tree = (await git(root, ['ls-tree', '-r', '-z', 'HEAD']))
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const m = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      ensure(m, '无法解析 HEAD');
      return { path: m[4], mode: m[1], gitHash: m[3], type: m[2] };
    })
    .filter((f) => selected(f.path, p));
  ensure(
    tree.every((f) => f.type === 'blob' && f.mode !== '120000'),
    'HEAD 包含不支持的链接输入',
  );
  const current = files
    .filter((f) => !f.deleted)
    .map(({ path, mode, gitHash }) => ({ path, mode, gitHash }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const expected = tree
    .map(({ path, mode, gitHash }) => ({ path, mode, gitHash }))
    .sort((a, b) => a.path.localeCompare(b.path));
  ensure(
    hash(current) === hash(expected),
    '相关输入尚未对应当前 HEAD（含未提交、未跟踪、删除或模式差异）',
  );
  return head;
}

/** 严格 XML 子集：无 DTD/命名空间/自定义实体；按实际 testcase 计数并校验声明统计。 */
export function parseJUnit(xml) {
  ensure(
    typeof xml === 'string' && xml.length <= 16 * 1024 * 1024,
    'JUnit 报告过大',
  );
  xml = xml.replace(/^\uFEFF/, '');
  ensure(
    !/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(xml),
    'XML 包含非法字符',
  );
  for (const c of xml) {
    const n = c.codePointAt(0);
    ensure(!(n >= 0xd800 && n <= 0xdfff), 'XML 包含非法 Unicode 字符');
  }
  const stack = [],
    roots = [];
  let i = 0;
  const entities = (s) => {
    ensure(
      !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s) && !s.includes(']]>'),
      'XML 字符无效',
    );
    ensure(
      !/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s),
      'XML 实体无效',
    );
    for (const m of s.matchAll(/&#(x[0-9a-fA-F]+|\d+);/g)) {
      const n = m[1][0] === 'x' ? parseInt(m[1].slice(1), 16) : Number(m[1]);
      ensure(
        n === 9 ||
          n === 10 ||
          n === 13 ||
          (n >= 32 && n <= 0xd7ff) ||
          (n >= 0xe000 && n <= 0xfffd) ||
          (n >= 0x10000 && n <= 0x10ffff),
        'XML 数字实体无效',
      );
    }
    return s;
  };
  const attach = (node) => {
    if (stack.length) stack.at(-1).children.push(node);
    else roots.push(node);
  };
  while (i < xml.length) {
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      ensure(end >= 0 && !xml.slice(i + 4, end).includes('--'), 'XML 注释无效');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?xml', i)) {
      ensure(
        i === 0 &&
          /^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["'][A-Za-z0-9_-]+["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>/.test(
            xml,
          ),
        'XML 声明无效',
      );
      i = xml.indexOf('?>', i) + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const end = xml.indexOf(']]>', i + 9);
      ensure(end >= 0 && stack.length, 'CDATA 无效');
      i = end + 3;
      continue;
    }
    if (xml[i] !== '<') {
      const end = xml.indexOf('<', i),
        text = xml.slice(i, end < 0 ? xml.length : end);
      entities(text);
      ensure(stack.length || !text.trim(), 'XML 根元素之外有文本');
      i = end < 0 ? xml.length : end;
      continue;
    }
    if (xml.startsWith('</', i)) {
      const m = /^<\/([A-Za-z][\w.-]*)\s*>/.exec(xml.slice(i));
      ensure(
        m && stack.length && stack.at(-1).name === m[1],
        'XML 结束标签不匹配',
      );
      stack.pop();
      i += m[0].length;
      continue;
    }
    const m = /^<([A-Za-z][\w.-]*)/.exec(xml.slice(i));
    ensure(m, 'XML 标签无效（不支持 DTD/命名空间）');
    i += m[0].length;
    const node = { name: m[1], attrs: {}, children: [] };
    while (true) {
      const rest = xml.slice(i);
      const close = /^\s*(\/?>)/.exec(rest);
      if (close) {
        i += close[0].length;
        attach(node);
        if (close[1] === '>') stack.push(node);
        break;
      }
      const attr = /^\s+([A-Za-z][\w.-]*)\s*=\s*("[^"<]*"|'[^'<]*')/.exec(rest);
      ensure(attr, 'XML 属性无效');
      ensure(!Object.hasOwn(node.attrs, attr[1]), 'XML 属性重复');
      node.attrs[attr[1]] = entities(attr[2].slice(1, -1));
      i += attr[0].length;
    }
  }
  ensure(
    !stack.length &&
      roots.length === 1 &&
      ['testsuites', 'testsuite'].includes(roots[0].name),
    'JUnit 根结构无效',
  );
  const allowed = {
    testsuites: ['testsuite'],
    testsuite: [
      'testsuite',
      'testcase',
      'properties',
      'system-out',
      'system-err',
    ],
    testcase: [
      'failure',
      'error',
      'skipped',
      'system-out',
      'system-err',
      'properties',
    ],
    properties: ['property'],
    property: [],
    failure: [],
    error: [],
    skipped: [],
    'system-out': [],
    'system-err': [],
  };
  function visit(node) {
    ensure(Object.hasOwn(allowed, node.name), '未知 JUnit 节点：' + node.name);
    for (const child of node.children) {
      ensure(
        allowed[node.name].includes(child.name),
        'JUnit 子节点无效：' + child.name,
      );
    }
    const stats = { tests: 0, failures: 0, errors: 0, skipped: 0, passed: 0 };
    if (node.name === 'testcase') {
      ensure(
        node.attrs.status === undefined || node.attrs.status === 'run',
        '不支持未执行的 testcase status',
      );
      ensure(
        node.attrs.result === undefined || node.attrs.result === 'completed',
        '不支持未完成的 testcase result',
      );
      stats.tests = 1;
      for (const kind of ['failure', 'error', 'skipped']) {
        ensure(
          node.children.filter((x) => x.name === kind).length <= 1,
          'testcase 重复结果',
        );
        if (node.children.some((x) => x.name === kind))
          stats[
            { failure: 'failures', error: 'errors', skipped: 'skipped' }[kind]
          ] = 1;
      }
      ensure(
        stats.failures + stats.errors + stats.skipped <= 1,
        'testcase 结果互相冲突',
      );
      stats.passed = 1 - stats.failures - stats.errors - stats.skipped;
    }
    for (const child of node.children) {
      const s = visit(child);
      if (['testsuite', 'testsuites'].includes(node.name))
        for (const k of Object.keys(stats)) stats[k] += s[k];
    }
    if (['testsuite', 'testsuites'].includes(node.name))
      for (const key of ['tests', 'failures', 'errors', 'skipped'])
        if (node.attrs[key] !== undefined) {
          ensure(
            /^\d+$/.test(node.attrs[key]) &&
              Number.isSafeInteger(Number(node.attrs[key])) &&
              Number(node.attrs[key]) === stats[key],
            'JUnit 声明统计与 testcase 不一致：' + key,
          );
        }
    for (const key of ['todo', 'pending', 'disabled'])
      if (node.attrs[key] !== undefined)
        ensure(node.attrs[key] === '0', 'JUnit 含未完成测试');
    return stats;
  }
  return visit(roots[0]);
}

async function reportEvidence(root, p) {
  if (!p.report) return null;
  const filename = await safeAcceptancePath(root, p.report.path);
  const data = await fs.readFile(filename),
    evidence = { path: posix(p.report.path), hash: hash(data), stats: null };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    ensure(
      !/^\s*<\?xml[^?]*encoding\s*=\s*["'](?!utf-8["'])/i.test(text),
      'JUnit 首版仅支持 UTF-8 XML',
    );
    const stats = parseJUnit(text);
    evidence.stats = stats;
    ensure(stats.failures === 0 && stats.errors === 0, 'JUnit 存在失败或错误');
    ensure(p.allowSkipped || stats.skipped === 0, 'JUnit 包含禁止的 skipped');
    if (p.kind === 'test')
      ensure(stats.passed >= p.minPassed, 'JUnit 实际通过数量不足或全跳过');
    return evidence;
  } catch (e) {
    e.report = evidence;
    throw e;
  }
}
export async function runAcceptance(
  workspace,
  profileId,
  { signal, timeoutMs, expectedProfileHash } = {},
) {
  ensure(idPattern.test(profileId), 'profile ID 无效');
  const root = await fs.realpath(workspace);
  await storage(root);
  await fs.mkdir(local(root), { recursive: true });
  const receipt = {
    schemaVersion: 1,
    profileId,
    ok: false,
    status: 'failed',
    startedAt: new Date().toISOString(),
    sampling: 'before/after only; not an isolation guarantee',
    steps: [],
  };
  const file = path.join(local(root), profileId + '.json');
  let lock,
    ownsLock = false;
  try {
    try {
      lock = await fs.open(path.join(local(root), 'run.lock'), 'wx');
      ownsLock = true;
      await lock.writeFile(
        JSON.stringify({
          pid: process.pid,
          profileId,
          startedAt: receipt.startedAt,
        }),
      );
    } catch (e) {
      if (e.code === 'EEXIST')
        throw Error('验收执行锁已存在；请等待或人工核对遗留锁');
      throw e;
    }
    await atomic(file, {
      ...receipt,
      status: 'blocked',
      reason: '验收运行中，旧成功已失效',
    });
    ensure(
      timeoutMs === undefined || (Number.isFinite(timeoutMs) && timeoutMs > 0),
      'timeoutMs 必须为正数',
    );
    const c = await loadAcceptanceConfig(root),
      p =
        c && Object.hasOwn(c.profiles, profileId)
          ? c.profiles[profileId]
          : null;
    ensure(p, '未配置 profile：' + profileId);
    receipt.kind = p.kind;
    receipt.configHash = hash(p);
    if (expectedProfileHash !== undefined) {
      ensure(
        expectedProfileHash === receipt.configHash,
        '确认期间验收配置已变化，未执行命令；请重新核对并确认',
      );
      receipt.approvedProfileHash = expectedProfileHash;
    }
    receipt.runtime = runtime();
    receipt.environmentHash = environment(p);
    receipt.head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (signal?.aborted) throw Error('验收已取消');
    for (const step of p.steps) await safeAcceptancePath(root, step.cwd || '.');
    await safeAcceptancePath(root, '.local/pi-find/logs');
    if (p.report) {
      const report = await safeAcceptancePath(root, p.report.path);
      try {
        const archive = await safeAcceptancePath(
          root,
          '.local/pi-find/acceptance/history/' + crypto.randomUUID() + '.xml',
        );
        await fs.mkdir(path.dirname(archive), { recursive: true });
        await fs.rename(report, archive);
        receipt.archivedReport = path.relative(root, archive);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    receipt.inputs = await snapshot(root, p);
    const steps = p.steps.map((step) => {
      if (
        process.platform === 'win32' &&
        ['npm', 'pnpm', 'yarn'].includes(step.command)
      ) {
        ensure(
          step.args?.length === 2 &&
            step.args[0] === 'run' &&
            /^[\w:.-]+$/.test(step.args[1]),
          'Windows 包脚本只支持 manager run <安全脚本名>；其他命令请配置显式包装脚本',
        );
        return {
          ...step,
          command: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
          args: ['/d', '/s', '/c', `${step.command} run ${step.args[1]}`],
        };
      }
      return step;
    });
    const result = await runSteps(root, steps, { signal, timeoutMs });
    receipt.steps = result.steps;
    for (const step of receipt.steps)
      if (step.logPath) step.logHash = hash(await fs.readFile(step.logPath));
    ensure(result.ok, '命令失败、超时或取消');
    receipt.report = await reportEvidence(root, p);
    const after = await snapshot(root, p);
    ensure(hash(receipt.inputs) === hash(after), '验收前后输入采样不同');
    ensure(receipt.environmentHash === environment(p), '验收环境发生变化');
    ensure(
      receipt.configHash ===
        hash((await loadAcceptanceConfig(root))?.profiles[profileId]),
      '运行中配置发生变化',
    );
    receipt.ok = true;
    receipt.status = 'passed';
    receipt.reason =
      p.kind === 'command'
        ? '命令完成（不证明测试通过）'
        : '结构化测试报告通过';
  } catch (e) {
    if (e.report) receipt.report = e.report;
    receipt.reason = e?.message || String(e);
    receipt.ok = false;
    receipt.status = ownsLock ? 'failed' : 'blocked';
  } finally {
    receipt.finishedAt = new Date().toISOString();
    if (ownsLock) {
      try {
        await atomic(file, receipt);
      } finally {
        await lock?.close();
        await fs.unlink(path.join(local(root), 'run.lock'));
      }
    } else
      await atomic(
        await safeAcceptancePath(
          root,
          '.local/pi-find/acceptance/attempts/' + crypto.randomUUID() + '.json',
        ),
        receipt,
      );
  }
  return receipt;
}
export async function getAcceptanceStatus(
  workspace,
  { profileIds, action } = {},
) {
  const root = await fs.realpath(workspace);
  let c;
  try {
    c = await loadAcceptanceConfig(root);
  } catch (e) {
    return {
      configured: true,
      profiles: [],
      ok: false,
      status: 'blocked',
      reason: e.message,
    };
  }
  if (!c) {
    const config = await loadConfig(root);
    const legacy = [];
    for (const kind of ['quality', 'e2e']) {
      const steps = config[kind + 'Steps'] || [];
      const receiptPath = await safeAcceptancePath(root, `.local/pi-find/${kind}.json`);
      const receipt = await readJson(receiptPath, null);
      let validity;
      try { validity = await validationStatus(root, kind, steps); }
      catch (error) { validity = { valid: false, reason: error.message }; }
      legacy.push({
        kind, configured: steps.length > 0, steps,
        entry: { command: process.execPath, args: [path.join(import.meta.dirname, 'guard.mjs'), 'validate', root, kind] },
        receipt: receipt ? {
          path: receiptPath, ok: receipt.ok, createdAt: receipt.createdAt,
          ...validity,
          steps: receipt.steps?.map((step) => ({
            command: step.command, args: step.args, cwd: step.cwd, exitCode: step.exitCode,
            timedOut: step.timedOut, aborted: step.aborted,
            stdoutTail: step.stdout?.slice(-1500), stderrTail: step.stderr?.slice(-1500),
          })),
        } : null,
        coverage: '仅覆盖列出的旧模式命令；旧收据无结构化用例计数，不证明完整测试套件、安装版 GUI 或远程 CI 通过。',
      });
    }
    return {
      configured: false,
      profiles: [],
      ok: false,
      status: 'unconfigured',
      reason: '未配置新版 acceptance',
      mode: 'legacy', legacy,
      nextStep: '核对当前任务所需验收与旧入口的实际选择范围；已授权时执行相关旧入口。需新版证据时显式配置 acceptance 测试项与 JUnit 报告后重新运行，不能把旧收据当全量通过。',
    };
  }
  if (action !== undefined && profileIds !== undefined)
    return {
      configured: true,
      profiles: [],
      ok: false,
      status: 'blocked',
      reason: 'action 与 profileIds 不可混用；门禁必须检查配置的完整集合',
    };
  const ids =
    profileIds ??
    (action
      ? Object.hasOwn(c.gates || {}, action)
        ? c.gates[action]
        : undefined
      : c.defaultProfiles?.length
        ? c.defaultProfiles
        : Object.keys(c.profiles));
  if (!ids?.length)
    return {
      configured: true,
      profiles: [],
      ok: false,
      status: 'unconfigured',
      reason: action ? '未配置 action gate：' + action : '没有选择 profile',
    };
  let headError;
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD']);
  } catch (e) {
    headError = '需要真实 Git 仓库和至少一个 HEAD commit：' + e.message;
  }
  const profiles = [],
    checkedReceipts = new Map();
  for (const id of [...new Set(ids)]) {
    const p = Object.hasOwn(c.profiles, id) ? c.profiles[id] : null,
      item = { id, status: 'unconfigured', reason: '缺少 profile 配置' };
    profiles.push(item);
    if (!p || !idPattern.test(id)) continue;
    if (headError) {
      item.status = 'blocked';
      item.reason = headError;
      continue;
    }
    try {
      await storage(root);
      const receipt = await readJson(
        await safeAcceptancePath(
          root,
          '.local/pi-find/acceptance/' + id + '.json',
        ),
        null,
      );
      item.receipt = receipt;
      checkedReceipts.set(id, hash(receipt));
      const lock = await readJson(
        await safeAcceptancePath(root, '.local/pi-find/acceptance/run.lock'),
        null,
      );
      if (lock) {
        item.status = 'blocked';
        item.reason = '项目验收执行锁存在；运行中或遗留锁需核对';
        continue;
      }
      if (!receipt) {
        item.status = 'not_run';
        item.reason = '尚未运行';
        continue;
      }
      if (!receipt.ok) {
        item.status = receipt.status === 'blocked' ? 'blocked' : 'failed';
        item.reason = receipt.reason;
        continue;
      }
      item.status = 'stale';
      ensure(
        receipt.schemaVersion === 1 && receipt.profileId === id,
        '证据版本不匹配',
      );
      ensure(
        receipt.ok === true &&
          receipt.status === 'passed' &&
          receipt.kind === p.kind &&
          Array.isArray(receipt.steps) &&
          receipt.steps.length === p.steps.length &&
          receipt.steps.every(
            (step) =>
              step.exitCode === 0 &&
              !step.aborted &&
              !step.timedOut &&
              !step.error,
          ),
        '执行步骤证据缺失或未全部成功',
      );
      ensure(receipt.configHash === hash(p), 'profile 配置已变化');
      ensure(hash(receipt.runtime) === hash(runtime()), '运行时已变化');
      ensure(receipt.environmentHash === environment(p), '指定环境已变化');
      const inputs = await snapshot(root, p);
      ensure(hash(inputs) === hash(receipt.inputs), '作用域输入已变化');
      if (p.report) {
        const evidence = await reportEvidence(root, p);
        ensure(evidence.hash === receipt.report?.hash, '结构化报告已变化');
      }
      for (const step of receipt.steps || []) {
        ensure(
          step.logPath && within(root, step.logPath),
          '执行日志缺失或越界',
        );
        const log = await safeAcceptancePath(
          root,
          path.relative(root, step.logPath),
        );
        ensure(hash(await fs.readFile(log)) === step.logHash, '执行日志已变化');
      }
      if (action && ['push', 'release', 'deploy'].includes(action)) {
        item.status = 'blocked';
        item.head = await headBinding(root, p, inputs);
      }
      item.status = 'passed';
      item.reason =
        p.kind === 'command'
          ? '命令证据有效（不证明测试通过）'
          : '测试证据有效';
      item.kind = p.kind;
    } catch (e) {
      if (!['stale', 'blocked'].includes(item.status)) item.status = 'blocked';
      item.reason = e.message;
    }
  }
  // 返回前重新采样证据和配置；不声称多个文件之间存在原子快照。
  try {
    ensure(
      hash(await loadAcceptanceConfig(root)) === hash(c),
      '状态检查期间验收配置发生变化',
    );
    const lock = await readJson(
      await safeAcceptancePath(root, '.local/pi-find/acceptance/run.lock'),
      null,
    );
    ensure(!lock, '状态检查期间项目验收执行锁存在');
    for (const item of profiles)
      if (item.status === 'passed') {
        const receipt = await readJson(
          await safeAcceptancePath(
            root,
            '.local/pi-find/acceptance/' + item.id + '.json',
          ),
          null,
        );
        if (hash(receipt) !== checkedReceipts.get(item.id)) {
          item.status = 'stale';
          item.reason = '状态检查期间运行证据已被替换';
        }
      }
  } catch (e) {
    for (const item of profiles)
      if (item.status === 'passed') {
        item.status = 'blocked';
        item.reason = e.message;
      }
  }
  return {
    configured: true,
    action,
    profiles,
    ok: profiles.length > 0 && profiles.every((p) => p.status === 'passed'),
    checkedAt: new Date().toISOString(),
    sampling: 'before/after only; not an atomic snapshot',
  };
}
export async function assertAction(root, action) {
  const status = await getAcceptanceStatus(root, { action });
  if (!status.ok) {
    const error = Error(
      '验收门禁未通过：' +
        (status.reason ||
          status.profiles
            .map((p) => `${p.id}: ${p.status} (${p.reason})`)
            .join('; ')),
    );
    error.status = status;
    throw error;
  }
  return status;
}
