# Deploy AFFiNE + Requesty on Coolify

Plug-and-play deploy of this fork (Requesty copilot provider, curated native
model variants, and `scenarioOverrides`). You configure Requesty entirely via
Coolify environment variables — no config files to edit.

## Prerequisite: a pullable image

Coolify does **not** build this image (AFFiNE's Dockerfile needs pre-built
artifacts). The fork CI workflow `.github/workflows/requesty-selfhost-image.yml`
builds and pushes `ghcr.io/<owner>/affine:requesty`. Make it pullable one of two
ways:

- **Public (simplest):** in GitHub → your fork → Packages → `affine` → Package
  settings → change visibility to **Public**. Then Coolify pulls with no creds.
- **Private:** add a GHCR registry credential in Coolify (Keys & Tokens →
  Registries) using a PAT with `read:packages`.

## Coolify steps

1. **New Resource → Docker Compose** (Git-based). Point it at this repo/branch
   (`requesty-provider-spec`) and set the **Compose file path** to
   `.coolify/docker-compose.yaml`.
2. **Set environment variables** (below). Only `REQUESTY_API_KEY` is required.
3. **Set the domain** on the `affine` service (Coolify assigns one or use your
   own); the service listens on port **3010**. Also set
   `AFFINE_SERVER_EXTERNAL_URL` to that same `https://…` URL.
4. **Deploy.** On boot the container writes `config.json` from your env vars,
   runs DB migrations (`self-host-predeploy.js`), then starts the server.

## Environment variables

| Variable                                      | Required    | Default                                   | Purpose                                 |
| --------------------------------------------- | ----------- | ----------------------------------------- | --------------------------------------- |
| `REQUESTY_API_KEY`                            | **yes**     | —                                         | Your Requesty API key                   |
| `REQUESTY_BASE_URL`                           | no          | `https://router.requesty.ai/v1`           | **The Requesty endpoint — change here** |
| `REQUESTY_SCENARIOS_ENABLED`                  | no          | `true`                                    | Turn scenario routing on/off            |
| `REQUESTY_MODEL_CHAT`                         | no          | `requesty/sference/glm-5.2`               | Model for chat                          |
| `REQUESTY_MODEL_EMBEDDING`                    | no          | `requesty/nebius/Qwen/Qwen3-Embedding-8B` | Model for embeddings                    |
| `REQUESTY_MODEL_RERANK`                       | no          | `requesty/nebius/qwen/qwen3-32b`          | Model for rerank                        |
| `AFFINE_IMAGE`                                | no          | `ghcr.io/zebster-cmd/affine:requesty`     | Image tag to run                        |
| `AFFINE_SERVER_EXTERNAL_URL`                  | recommended | —                                         | Public `https://…` URL of the app       |
| `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | no          | `affine`                                  | Postgres creds                          |

> **Model id format is load-bearing.** Model values MUST be prefixed
> `requesty/…` — the prefix must match the provider profile id, which this
> compose fixes to `requesty`. Change the model _after_ the prefix (e.g.
> `requesty/zai/glm-5.2`); keep the `requesty/` prefix.

## Changing the Requesty endpoint / models later

Edit the env var in Coolify and redeploy — the container regenerates
`config.json` on every start. E.g. set `REQUESTY_BASE_URL` to a self-hosted
Requesty gateway, or point `REQUESTY_MODEL_CHAT` at a different Requesty model.

## Known limits (this iteration)

- Wired end-to-end: **chat, embedding, rerank**. **Image** (Requesty
  policy-gated) and **transcript** (needs an audio+structured multimodal model,
  not the STT variant) are **not** wired — leave their models unset.
- The image is CI-**built** and boots the bundler, but a full **runtime smoke
  test** (container serves + a live chat turn routes to Requesty) has not been
  done — verify after first deploy.
- The **ava test suite** hasn't run in CI yet; and **rotate** any key shared in
  plaintext.
