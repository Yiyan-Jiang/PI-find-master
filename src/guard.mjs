import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  inspectStaged,
  runSteps,
  validationStatus,
  repositoryRoot,
  sourceFingerprint,
  git,
  deniedFiles,
} from './core.mjs';
import { assertAction } from './acceptance.mjs';

/** Git 钩子与手动检查共用入口；不创建提交、不自动暂存或修复文件。 */
export async function guard(root, phase) {
  root = await repositoryRoot(root);
  const config = await loadConfig(root);
  if (['pre-commit', 'staged', 'certify'].includes(phase)) {
    const staged = await inspectStaged(root, config.deny || []);
    if (staged.denied.length)
      throw Error('禁止提交的本地产物：\n' + staged.denied.join('\n'));
    if (staged.partiallyStaged.length)
      throw Error(
        '以下文件暂存内容与工作区不同，请明确核对后重新暂存：\n' +
          staged.partiallyStaged.join('\n'),
      );
  }
  if (phase === 'staged') return;
  if (config.acceptance && phase === 'pre-push') {
    await assertAction(root, 'push');
    console.log(
      'pi-find: 新版 push 验收通过（已核对受测输入与当前 HEAD，未执行推送）。',
    );
    return;
  }
  if (!config.qualitySteps?.length)
    throw Error('缺少显式 qualitySteps 配置；不猜测检查命令。');
  if (phase === 'certify') {
    // 仅由原 Husky set -e 检查链的最后一步调用，证明该链真实退出成功。
    const fingerprint = await sourceFingerprint(root);
    const crypto = await import('node:crypto');
    const receipt = {
      kind: 'quality',
      ok: true,
      fingerprint,
      commandsHash: crypto
        .createHash('sha256')
        .update(JSON.stringify(config.qualitySteps))
        .digest('hex'),
      createdAt: new Date().toISOString(),
      verifiedBy: 'existing-husky-check-chain',
    };
    await fs.mkdir(path.join(root, '.local', 'pi-find'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.local', 'pi-find', 'quality.json'),
      JSON.stringify(receipt, null, 2),
    );
    return;
  }
  const quality = await validationStatus(root, 'quality', config.qualitySteps);
  if (!quality.valid) {
    const result = await runSteps(root, config.qualitySteps, {
      timeoutMs: 600000,
      recordAs: 'quality',
    });
    for (const s of result.steps) console.log(s.stdout + s.stderr);
    if (!result.ok)
      throw Error('质量检查未通过或执行时源码改变，禁止 ' + phase);
  }
  if (config.requireE2E) {
    if (!config.e2eSteps?.length)
      throw Error('尚未登记 E2E 入口，不能把静态检查当作 E2E。');
    const e2e = await validationStatus(root, 'e2e', config.e2eSteps);
    if (!e2e.valid)
      throw Error(
        '缺少当前源码的 E2E 通过证据。运行 pi-find validate e2e；失败不得改为通过。',
      );
  }
  if (phase === 'pre-commit') {
    const staged = await inspectStaged(root, config.deny || []);
    if (staged.partiallyStaged.length)
      throw Error('检查后暂存区与工作区发生变化，必须重新核对暂存。');
  }
  console.log(
    'pi-find: ' + phase + ' 检查通过（源码匹配，原有 Husky 链保留）。',
  );
}
export async function checkPushRefs(root, input, deny) {
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const [, local, , remote] = line.trim().split(/\s+/);
    if (/^0+$/.test(local)) continue;
    if (local !== head)
      throw Error(
        '推送引用不是当前 HEAD，无法复用当前工作区验证；请切换到对应提交检查。',
      );
    const commits = (
      await git(root, [
        'rev-list',
        local,
        ...(/^0+$/.test(remote) ? ['--not', '--remotes'] : ['^' + remote]),
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const commit of commits) {
      const files = (
        await git(root, [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-only',
          '--diff-filter=ACMR',
          '-r',
          '-z',
          commit,
        ])
      )
        .split('\0')
        .filter(Boolean);
      const bad = deniedFiles(files, deny);
      if (bad.length)
        throw Error(
          '待推送提交包含禁止产物：' + commit + '\n' + bad.join('\n'),
        );
    }
  }
}
const [mode, rootArg, kind] = process.argv.slice(2);
if (mode) {
  try {
    const root = rootArg || process.cwd();
    if (mode === 'validate') {
      if (!['quality', 'e2e'].includes(kind))
        throw Error('validate 仅接受 quality 或 e2e');
      const c = await loadConfig(root),
        steps = kind === 'quality' ? c.qualitySteps : c.e2eSteps;
      if (!steps?.length) throw Error('未登记 ' + kind + ' 入口');
      const r = await runSteps(root, steps, {
        recordAs: kind,
        timeoutMs: 900000,
      });
      for (const s of r.steps) console.log(s.stdout + s.stderr);
      if (!r.ok) process.exitCode = 1;
    } else {
      if (mode === 'pre-push') {
        const input = readFileSync(0, 'utf8');
        const c = await loadConfig(root);
        await checkPushRefs(root, input, c.deny || []);
      }
      await guard(root, mode);
    }
  } catch (e) {
    console.error('pi-find: ' + e.message);
    process.exitCode = 1;
  }
}
