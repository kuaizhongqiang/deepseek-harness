# Agent Note: llm-pi-ai ships a harness-builtin MiMo vision provider

Status: implemented

English | [中文](2026-08-15-mimo-vision-provider.zh.md)

## Problem

The fork's desktop/VSCode/web clients attach images to user messages, but no provider route served a vision model out of the box. pi-ai 0.82 ships no xiaomi catalog, and a route the settings UI declares cannot mark a model image-capable — the model editor exposes no `input` modality field and the route falls back to `[text]` — so every image-bearing request would be refused with `MODEL_DOES_NOT_SUPPORT_IMAGES` before it reached any provider.

## Decision

`dsh-llm-pi-ai` gains a harness-declared builtin catalog (`src/builtin.ts`): the `mimo` route ships `mimo-v2.5` (text + image, 1M context / 128K output) and `mimo-v2.5-pro` (text-only) on the OpenAI-compatible endpoint `https://api.xiaomimimo.com/v1`. The builtin joins the same provider index as pi-ai's catalog — `catalogProviders()`, `catalogModels()`, and `catalogProviderIds()` merge it in — so a profile naming only `apiKeyEnv: MIMO_API_KEY` resolves the whole route, the settings Models page offers a `mimo` row with a key field, and `buildProvider` reuses the harness provider exactly as it reuses a pi-ai catalog provider. The image pipeline the harness already ships — paste/drop/multi-image drafts, the durable attachment store, host image admission, and pi-ai's base64 `image_url` encoding — then serves vision end to end with no further configuration.

MiMo answers DeepSeek-style reasoning wire (`reasoning_content`, `thinking`, `reasoning_effort`), so the builtin models declare `compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true }`. Their `thinkingLevelMap` spells every pi-ai level with a value verified against the endpoint (2026-08): `low`/`medium`/`high` are accepted, `minimal` is refused with 400, so `minimal` maps to `low` and `xhigh`/`max` map to `high`; `off` maps to `low` so an explicit Off selection never sends the bare string, and the no-effort default (`off !== null` in pi-ai's deepseek dispatch) sends `thinking: { type: 'disabled' }` — the verified fast path, since MiMo otherwise thinks by default.

## Alternatives considered

- **Ship the route as user settings only** (documentation plus a hand-edited `settings.yaml` with `defaultInput: [text, image]`). Rejected: the settings UI cannot express modalities, so the image path stays unreachable from the product surface this fork exists to ship.
- **Add an `input` modality field to the settings model editor** (`ui-settings-models`). Deferred: the builtin solves the shipped use case, and the field would modify upstream `ui-settings-models`; it remains the path for users who want a *different* OpenAI-compatible vision gateway the harness does not ship.
- **A separate `@deepseek-ai/dsh-llm-mimo` package.** Rejected: `llm-pi-ai`'s catalog has no extension point, and adding one to host a second package enlarges the upstream surface beyond the small builtin table this change adds.

## Consequences

- One line of configuration (or the Models page key field) makes MiMo usable, including images; the whole flow is pinned by the `mimo` case in `tests/provider-apis.e2e.ts` (self-skips without `MIMO_API_KEY`) and by the builtin cases in `tests/catalog.spec.ts`.
- The change modifies upstream `llm-pi-ai` (new `src/builtin.ts`, small merges in `catalog.ts`/`provider.ts`), traded against first-class vision UX; it is additive and the fork's merge discipline carries it as a small patch.
- The reasoning map is pinned to wire facts verified once; if MiMo later accepts `minimal`, the map stays conservative, never incorrect.
