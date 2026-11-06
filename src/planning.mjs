import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from './core.mjs';
import { loadAcceptanceConfig, selectProfiles } from './acceptance.mjs';

const note = '只制定检查计划，未执行检查，不是交付通过证明';

/** 只读 Git 改动规划；不创建缓存、证据或锁，不执行 profile steps。 */
export async function planAcceptance(workspace, { base = 'HEAD' } = {}) {
  let configured = false;
  const result = {
    configured,
    ok: false,
    changedPaths: [],
    profiles: [],
    note,
  };
  try {
    const root = await fs.realpath(workspace);
    const config = await loadAcceptanceConfig(root);
    configured = config !== null;
    result.configured = configured;
    const repository = await fs.realpath(
      (await git(root, ['rev-parse', '--show-toplevel'])).trim(),
    );
    if (path.relative(root, repository) !== '')
      throw Error('规划必须在 Git 仓库根目录执行；请用 --root 指定仓库根目录');
    if (!configured) return { ...result, reason: '未配置新版 acceptance' };
    if (typeof base !== 'string' || !base.length || base.includes('\0'))
      throw Error('base 必须为非空 Git ref');
    const baseCommit = (
      await git(root, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${base}^{commit}`,
      ])
    ).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit))
      throw Error('Git 未返回单一有效的基准 commit');
    result.baseCommit = baseCommit;
    const changed = await git(root, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      baseCommit,
      '--',
      '.',
    ]);
    const untracked = await git(root, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    result.changedPaths = [
      ...new Set(
        (changed + untracked)
          .split('\0')
          .filter(
            (name) => name && !['.local', '.git'].includes(name.split('/')[0]),
          ),
      ),
    ].sort();
    const selected = await selectProfiles(root, result.changedPaths);
    result.profiles = selected.map((id) => {
      const profile = Object.hasOwn(config.profiles, id)
        ? config.profiles[id]
        : null;
      return {
        id,
        kind: profile?.kind ?? null,
        description: profile?.description ?? '',
        configured: !!profile,
      };
    });
    result.ok = result.profiles.every((profile) => profile.configured);
    if (!result.ok) result.reason = '选择结果包含未配置的 profile';
    return result;
  } catch (error) {
    return { ...result, configured, ok: false, reason: error.message };
  }
}
