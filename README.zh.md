# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**下游 fork**，通过 GitHub Releases 发布共享 server 与桌面端 / VS Code 客户端。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 下载客户端包

共享 server 与客户端通过 [GitHub Releases](https://github.com/kuaizhongqiang/deepseek-harness/releases) 发布：

- **dsh-desktop**：Windows / macOS / Linux 安装包。桌面端内置 server CLI，共享 server 会自动启动。
- **dsh-vscode**：VS Code 扩展（`.vsix`），要求 `dsh` CLI 位于你的 `PATH`。
- **dsh-server**：便携 server 压缩包；运行 `node dsh-cli/bin.js --profile server`。

### 启动共享 server

启动 server（仅限本机回环），然后打开打印的 URL：

```sh
node dsh-cli/bin.js --profile server
```

server 绑定 `127.0.0.1`，写入 `~/.dsh/web.lock`，并向桌面端与 VS Code 客户端提供 Web UI 和 API。

### 使用视觉模型的图片输入

三个客户端都支持在输入框中以图片输入——粘贴、拖拽或一次添加多张——harness 内置了小米 MiMo-V2.5 视觉模型的目录条目（`mimo-v2.5`）。通过设置页的 Models 面板配置（为 `mimo` provider 填入密钥），或手动写入：

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    mimo:
      apiKeyEnv: MIMO_API_KEY
```

已包含图片的会话会拒绝切换到纯文本模型；选择 `mimo-v2.5`（或任何支持图片的模型）即可讨论附带的图片。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/kuaizhongqiang/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh --profile server
```

### 单独运行 Web UI

```sh
pnpm dsh web
```

在 `http://127.0.0.1:3080` 提供 Web UI。详见 [Web UI 指南](docs/user/guide/index.md)。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
