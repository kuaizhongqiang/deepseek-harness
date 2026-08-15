# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

This repository is a **downstream fork** of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); it ships the shared server and the desktop / VS Code clients through GitHub Releases.

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Download the client packages

The shared server and clients ship as [GitHub Releases](https://github.com/kuaizhongqiang/deepseek-harness/releases):

- **dsh-desktop** — installers for Windows, macOS, and Linux. The desktop app bundles the server CLI, and the shared server starts automatically.
- **dsh-vscode** — a VS Code extension (`.vsix`). Requires the `dsh` CLI on your `PATH`.
- **dsh-server** — a portable server tarball; run `node dsh-cli/bin.js --profile server`.

### Start the shared server

Start the server (loopback only), then open the printed URL:

```sh
node dsh-cli/bin.js --profile server
```

The server binds to `127.0.0.1`, writes `~/.dsh/web.lock`, and serves the Web UI and API that the desktop and VS Code clients attach to.

### Image input with the `describe_image` tool

All three clients support image input in the composer — paste, drag-and-drop, or add multiple images. The main conversation model stays text-only (DeepSeek V4 flash): when an image arrives, the harness stores it as a durable attachment and the model sees a hint plus the `describe_image` tool, which describes the image through a configurable OpenAI-compatible vision endpoint (Xiaomi MiMo by default). The vision backend is a tool configuration (override the `tool-describe-image` row in your profile patch), not a model switch:

```yaml
# in your profile's cordis.patch.yml
- id: tool-describe-image
  name: '@deepseek-ai/dsh-tool-describe-image'
  config:
    baseURL: https://api.xiaomimimo.com/v1
    model: mimo-v2.5
    apiKeyEnv: MIMO_API_KEY
```

Vision-capable models (e.g. MiMo) keep receiving real image content directly; sessions without `describe_image` mounted keep the historical text-only rejection.

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/kuaizhongqiang/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh --profile server
```

### Run the Web UI alone

```sh
pnpm dsh web
```

Serves the Web UI at `http://127.0.0.1:3080`. See [Web UI guide](docs/user/guide/index.md).

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
