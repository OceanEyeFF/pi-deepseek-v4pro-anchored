# Pi DeepSeek V4 Pro Anchored

[简体中文](./README.zh-CN.md)

`pi-deepseek-v4pro-anchored` is an installable [Pi Package](https://pi.dev/packages) that applies a progressive, DSH-style tool workflow to DeepSeek V4 Pro in Pi.

## Progressive mode (default)

**Progressive mode** starts a new interactive session with a small, focused tool catalog, then expands the catalog only after a short anchor turn and at a turn boundary:

1. Start with a minimal DSH-compatible environment: a one-line persona plus `bash` and `str_replace_editor`.
2. Before the first ordinary interactive task, run a short anchor turn.
3. Quietly promote the next work turn to a small discovery-tool set, allowing the model to unlock only the tools it needs.

The original experiment called this workflow **C2**. That is now an experiment identifier and a backward-compatible alias only; the user-facing name is **Progressive mode**. The included experiment found this variant to be the best overall trade-off for one DeepSeek V4 Pro research task. It is evidence for a workflow hypothesis, not a guarantee of better quality, cost, or safety for every model or task.

## Install

Pi's package gallery indexes npm packages carrying the `pi-package` keyword. Install the published package with:

```bash
pi install npm:pi-deepseek-v4pro-anchored
```

Try it once without installing:

```bash
pi -e npm:pi-deepseek-v4pro-anchored
```

Pi loads the package globally by default. Use `-l` with `pi install` for a project-local installation.

## Use with DeepSeek V4 Pro

Configure your preferred Pi provider and select DeepSeek V4 Pro before starting a session. This package deliberately does not register a provider, select a model, or handle API credentials.

Progressive mode is enabled by default. The first ordinary interactive message is queued behind an anchor turn; slash commands, resumed sessions, RPC, and print-mode requests are not intercepted.

Runtime commands:

```text
/dsh-mode progressive  enable Progressive mode (minimal first, expand on demand)
/dsh-mode off          restore native Pi behaviour and tools
/dsh-mode               show the active mode
/dsh ...                alias for /dsh-mode
/dsh-mode c2            legacy alias for progressive
```

Set `DSH_MODE=off` before launching Pi to install the commands but leave the workflow disabled initially.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DSH_MODE=off\|progressive` | Initial mode; package default is `progressive`. |
| `DSH_MODE=c2` | Legacy alias for `progressive`. |
| `DSH_ANCHOR_TEXT` | Replaces the short anchor-turn message. |
| `DSH_C2_ANCHOR_TEXT` | Legacy alias for `DSH_ANCHOR_TEXT`. |
| `DSH_ANCHOR_PROMOTE_HINT=0\|1` | `0` is the Progressive-mode default: silently promote. `1` sends a promotion hint (the D2 experiment variant). |
| `DSH_ANCHOR_SHELL=bash\|pwsh` | Selects the minimal shell schema. |
| `DSH_ANCHOR_COMPACTION_TOOLS=...` | Controls the post-compaction working set. |

For an existing configuration, replace `DSH_MODE=c2` with `DSH_MODE=progressive` and `DSH_C2_ANCHOR_TEXT` with `DSH_ANCHOR_TEXT` when convenient. Both old forms continue to work.

## Compatibility and security

- Pi: `@earendil-works/pi-coding-agent` (tested with 0.83.0 and packaged against 0.84.2)
- Node.js: 22.19.0 or later
- This is an extension with Pi's normal full user permissions. Install it only from sources you trust and review it before use.

The extension uses a deliberately restrictive initial tool catalogue. It does not provide sandboxing, internet isolation, model access, or credential management.

## Evidence and limitations

The included [experiment report](./exp/REPORT.md) compares six one-off runs of the same research task. Its C2 experiment-group result—the workflow now named Progressive mode—was $0.047, 309 lines of output, and 24/25 fact-coverage items. The study is `n=1` per group and limited to a single model/task; benchmark it against your own workload before relying on the result.

Raw web captures and model session traces stay out of the public package/repository by default. They remain in the original local research directory.

## Development

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

The npm tarball contains only the package entry point, its runtime files, and release documentation. Pi loads TypeScript extensions through jiti; no build step is required.

## License and attribution

MIT. See [NOTICE](./NOTICE) for upstream research and implementation references.
