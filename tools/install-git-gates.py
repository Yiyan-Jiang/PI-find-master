"""只生成手动 Git hooks 接入说明；不修改仓库、hooks 或 Git 配置。"""
import argparse
import pathlib

GUIDE = """# Pi Find Master 手动 Git hooks 接入
1. 在目标仓库查看 git config --get core.hooksPath，确认现有 Husky/其他 hooks 链。
2. 备份要修改的 hook、权限及相关本机配置，记录原路径；不要改全局 Git 配置。
3. 在项目配置 acceptance profiles 和 push gate，主动运行真实验收：
   pi-find run smoke --root /path/to/project
4. 在现有 pre-push 原检查成功后调用：
   pi-find gate push --root /path/to/project
   把示例路径替换成工作区路径；不要用 eval 或拼接不可信 shell 参数。
   若 pi-find 不在 hook 的 PATH，使用本机已核对的 Node 和 CLI 绝对路径。
5. 保留原 hook 的退出码与 stdin 引用处理；pre-push 的 stdin 可能只能消费一次。
   新 gate 检查当前 HEAD；它不证明全部远端引用，不替代原 pre-push 或远端 CI。
6. 用临时仓库分别验证旧检查失败、新 gate 失败、成功、原 stdin 消费与恢复行为。
7. 回滚时恢复原 hook 文件和权限，移除自己添加的调用；不要删除别人的 hooks。

此辅助不自动安装，以免破坏原检查链。Git hooks 可以被绕过，不是安全边界。
共享配置不授权执行。不得根据旧 legacy receipts 声称新 acceptance gate 通过。
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, help="将说明保存到新文件；拒绝覆盖")
    args = parser.parse_args()
    if args.output:
        with args.output.open("x", encoding="utf-8") as output:
            output.write(GUIDE)
        print(str(args.output.resolve()))
    else:
        print(GUIDE)


if __name__ == "__main__":
    main()
