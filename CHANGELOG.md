# Changelog

## 0.1.2 - 2026-08-16

- Fixes the Progressive-mode first-turn race: Pi now transforms the initial input into the anchor turn and queues the original task only after the anchor agent run starts.
- Keeps any attached images out of the anchor turn and with the queued original task.
- Applies the same safe ordering to the optional zero/whoami anchor variants.
- Adds /dsh-status with Chinese-English phase and active-tool diagnostics, plus documentation of the actual queueing behaviour.

## 0.1.1 - 2026-08-15

- Renames the package-facing C2 workflow to **Progressive mode / 渐进模式**.
- Adds `/dsh-mode progressive`, bilingual Pi command/status descriptions, and Chinese-English README documentation.
- Keeps `c2` and `DSH_C2_ANCHOR_TEXT` as backward-compatible aliases.

## 0.1.0 - 2026-08-15

- First npm Pi Package release.
- Ships the DSH-style anchored C2 experiment workflow as the default package entry point.
- Adds `/dsh-mode off|c2` runtime control, portable smoke tests, and npm package metadata.
