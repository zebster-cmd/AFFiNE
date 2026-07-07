# Self-hosting AFFiNE with the Requesty copilot provider

This branch (`requesty-provider-spec`) adds a Requesty gateway provider, curated
native model variants (chat / embedding / rerank), and a
`copilot.scenarioOverrides` config that routes each AI scenario to a
Requesty-routed model.

**Working in v1:** chat, embedding, rerank.
**Not working:** image (blocked at the Requesty account/policy level) and
transcript (AFFiNE's transcript pipeline needs an audio+structured multimodal
model, not the STT `voxtral` — see the design spec §7, Finding B2). Leave those
scenarios out of `scenarioOverrides.models`.

The stock `compose.yml` pulls `ghcr.io/toeverything/affine`, which contains **none
of this code**. You must run a **custom image built from this fork** plus a
`config.json`. Three steps.

## 1. Build a custom image  ⚠️ must be built FOR linux

`.github/deployment/node/Dockerfile` does **not** build from source — it copies
**pre-built** artifacts (`packages/backend/server/dist`, the frontend `dist/`s)
and a native `server-native.node`. That native module is **platform-specific**:
building the artifacts on Windows/macOS yields a non-linux `.node` that will NOT
load in the `node:22-bookworm-slim` container.

**Recommended (reliable): build via the fork's CI.** Run the fork's existing
build workflow on GitHub Actions (linux runners) to produce and push a linux
image, then use that tag below. This side-steps the cross-platform native issue.

**Manual (only on a linux host / WSL2 / linux build container):**

```bash
# from the repo root, on linux, Node 22.23 (see .nvmrc)
yarn install
yarn workspace @affine/server-native build          # RELEASE native .node (linux)
# build the frontend dists the Dockerfile copies (see each package's build script):
#   packages/frontend/apps/web  -> dist
#   packages/frontend/admin     -> dist
#   packages/frontend/apps/mobile -> dist
yarn workspace @affine/server build                  # bundles server -> dist/main.js

docker build -f .github/deployment/node/Dockerfile \
  -t ghcr.io/zebster-cmd/affine:requesty .
docker push ghcr.io/zebster-cmd/affine:requesty      # or `docker save | docker load` locally
```

## 2. Point compose at your image (no edit to compose.yml)

`compose.override.yml` (in this dir) is auto-merged by `docker compose` and
repoints both AFFiNE services at `${AFFINE_IMAGE}`. Add to your `.env`:

```env
AFFINE_IMAGE=ghcr.io/zebster-cmd/affine:requesty
```

## 3. Provide the config

Copy `config.requesty.example.json` into your mounted config dir
(`${CONFIG_LOCATION}` → `/root/.affine/config/`) as **`config.json`**, and put
your real key in it:

```bash
cp config.requesty.example.json "$CONFIG_LOCATION/config.json"
# edit config.json: set apiKey to your Requesty key
```

The server reads `/root/.affine/config/config.json` on boot (`register.ts`) and
merges it into `AppConfig`.

> **Config format is load-bearing.** The scenario model prefix (`requesty/…`)
> must match a provider profile **id**. That is why the config uses
> `providers.profiles` with `"id": "requesty"` — do NOT use the
> `"providers.requesty": {…}` shape, which registers the id `requesty-default`
> and would require a `requesty-default/…` prefix instead.

Then:

```bash
docker compose up -d      # from .docker/selfhost/ (loads compose.yml + compose.override.yml)
```

## Caveats / before trusting a deploy

- The **ava (TS) test suite has not been run** in this workspace (Node version
  mismatch); validate it in CI on Node 22.23 (`yarn affine @affine/server
  test:copilot`). Native `cargo test model_registry` passes (11 tests).
- **Rotate any Requesty API key** that was shared in plaintext.
- Only `chat` / `embedding` / `rerank` are wired end-to-end; omit `image` and
  `transcript` from `scenarioOverrides.models`.
