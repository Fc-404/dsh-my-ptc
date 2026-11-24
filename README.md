# dsh-my-ptc（我的PTC）

DeepSeek Harness 的 PTC 中文预设 + billion-context 活动记忆插件，合成一个 bundle。

## 组成

### 1. 预设 `my-ptc` / 我的PTC

继承官方 `ptc` 预设的全部插件与工具（含 PTC 的 `run_code` SDK，工具清单不变），只替换系统提示词中的两段中文文本：

- **persona 前缀**：强制中文思考（含工具调用注释）、回复语言跟随用户、代码/路径/命令原样；工作方式：有疑问先问清楚、有方案先给方案、回复简洁。
- **计划模式段**：官方 plan-mode 规则的中文翻译。

### 2. 插件 `bili-active-memory`

DSH 启动时执行一次，幂等地给 billion-context 的压缩提示词注入「活动记忆」规则（摘要最前面的固定段：R/C/D/A 编号条目 + 归档区，≤12 条，T1→T2→T3 逐层原样承接）。

- 只修改 `compress.prompts` 四个字段 + `compress.acknowledgePromptsRisk`，其余配置原样保留
- 段落已含「活动记忆」标记 → 不动（尊重手改）
- 原子写入（临时文件 + rename），写前备份 `.bak-<时间戳>`
- 写后调用 bili `POST /__bili/config/reload` 热重载
- 任何失败只记日志，不影响 DSH 启动

## 安装

需要：DeepSeek Harness（web profile）、billion-context。

```bash
# 1. 克隆到本地（示例路径）
git clone git@github.com:Fc-404/dsh-my-ptc.git ~/dsh-bundles/my-ptc

# 2. 以 link 方式安装进 profile
cd ~/.dsh/profiles/web
pnpm add "link:$HOME/dsh-bundles/my-ptc"

# 3. 在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 末尾追加
#    "@local/dsh-my-ptc"

# 4. 重启 DSH
```

## 配置

插件条目 config（默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `18787` | bili 服务端口 |
| `retries` | `8` | reload 重试次数 |
| `enabled` | `true` | 设为 false 可停用 |

配置文件路径解析优先级：`config.configPath` → `BILI_CONFIG` / `BILI_CONFIG_FILE` → `BILI_CONFIG_DIR/billion-context.json` → `XDG_CONFIG_HOME/billion-context/billion-context.json` → `~/.config/billion-context/billion-context.json`。

## 说明

- `KERNEL` 常量是 billion-context 默认四段压缩提示词的内嵌副本，仅在配置为空时用于生成完整提示词；配置已含「活动记忆」标记时不会被覆盖。上游 bili 更新默认文本后，本插件不会自动同步（已有配置不受影响）。
- 本 bundle 只改 bili 配置文件、不修改 billion-context 源码。

## 文件

- `cordis.patch.yml` — bundle 补丁：注册预设 `preset-my-ptc` 与启动插件 `bili-active-memory`
- `plugin.js` — 活动记忆启动插件
- `package.json` — bundle 元数据
