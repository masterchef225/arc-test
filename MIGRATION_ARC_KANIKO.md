# Migration: GitHub-Hosted → ARC on GKE + Kaniko + GAR Cache

Цель: уехать с `runs-on: ubuntu-latest` на self-hosted ARC runners в GKE. Docker builds через kaniko с registry cache в GAR. Phased rollout (builds → tests → all).

---

## 0. Current State (baseline)

| Что | Сейчас |
|---|---|
| Runners | GitHub-hosted `ubuntu-latest` |
| Build tool | `docker buildx build --push` (нужен docker daemon) |
| Auth → GCP | `google-github-actions/auth@v1` + `credentials_json` (SA key в GitHub secret) |
| Push registry | `gcr.io/dualdeed/<image>:<sha>` |
| Cache (опц.) | `us-central1-docker.pkg.dev/anchor-ci/internal/cache:<image>` registry cache via buildx, шадоу-jobs, ANCR-1836 |
| ARC | Нет. Только bootstrap workflow + smoke + POC job (ANCR-1893) |

Touchpoints:
- `.github/actions/build-image/action.yml`
- `.github/actions/build-go-image/action.yml`
- `.github/actions/build_node_service/action.yml`
- `.github/workflows/build-deployables.yml` — все 60+ build jobs
- `.github/workflows/anchor-self-hosted-runner-bootstrap.yml` — уже есть, переделать на ARC

---

## 1. Target Architecture

```
GKE cluster (dualdeed)
  └─ namespace: arc-systems
        actions-runner-controller (Helm)
  └─ namespace: arc-runners
        runner-scale-set "anchor-ci"        ← runs-on: [self-hosted, anchor-ci]
        runner-scale-set "anchor-ci-build"  ← runs-on: [self-hosted, anchor-ci-build] (kaniko)
        runner-scale-set "anchor-ci-test"   ← runs-on: [self-hosted, anchor-ci-test]
  └─ KSA → GSA via WIF
        push  → gcr.io/dualdeed + us-docker.pkg.dev/dualdeed/*
        cache → us-central1-docker.pkg.dev/anchor-ci/internal/kaniko-cache/*

GAR layout
  anchor-ci/internal/kaniko-cache/<image-name>   ← per-image cache repo
```

Каждый job = ephemeral runner pod. После job — pod удаляется. Никакого долгоживущего state.

---

## 2. Phased Rollout

### Phase 0 — Infra prep (1 неделя)
1. Создать GAR repo `anchor-ci/internal/kaniko-cache` (Docker format, region us-central1).
2. WIF setup:
   - GSA `arc-runner@dualdeed.iam.gserviceaccount.com`
   - Roles: `roles/artifactregistry.writer` на `kaniko-cache` + push targets, `roles/storage.objectAdmin` на GCS buckets which CI uploads to.
   - KSA `arc-runner` в `arc-runners` namespace → bind to GSA через `iam.workloadIdentityUser`.
3. Создать GSA для controller (`roles/container.developer` минимум, читать secrets).
4. PAT или GitHub App для ARC controller registration (предпочтительно GitHub App — long-lived, fine-grained).

### Phase 1 — ARC install + smoke (1 неделя)
1. Helm install `actions-runner-controller` v0.10+ в `arc-systems`.
2. Install gha-runner-scale-set Helm chart per scale-set.
3. Build кастомный runner image:
   - Base: `ghcr.io/actions/actions-runner:latest`
   - Pre-installed: `gcloud`, `kaniko` binary (`/kaniko/executor`), `git`, `jq`, `node`, `yarn`, `go` (для test runners).
   - Push в `us-central1-docker.pkg.dev/dualdeed/internal/runner-images/anchor-ci:<sha>`.
4. Smoke: переключить `self-hosted-smoke.yml` на новый scale-set, убедиться что `runs-on: [self-hosted, anchor-ci]` поднимает pod, проходит проверки.
5. POC job (`poc-build-investigation-agent-self-hosted.yml`) — заменить docker buildx на kaniko, прогнать end-to-end.

### Phase 2 — Builds migration (2-3 недели)
Цель: все Docker builds на self-hosted + kaniko.

1. Создать новый composite `actions/build-image-kaniko/action.yml` (рядом со старым, не вместо).
2. Параллельно: добавить `runner_target` input в `configure_build` action для выбора cloud/self-hosted.
3. Канарейка: один сервис (e.g., `anchor-mcp-server`) → self-hosted + kaniko. Master + PR. Сравнить:
   - Build time (cold/warm cache)
   - Image digest (must match between cloud buildx и kaniko для того же Dockerfile)
   - Push success rate
4. Постепенно переключать сервисы по доменам:
   - Backend Go services (~20) → 1 неделя
   - Node services (~15) → 1 неделя
   - Frontend (`packages/frontend`, `packages/backoffice`, `packages/seagull`) → 1 неделя
5. Удалить старый `build-image` action после полной миграции и недели зелёного master.

### Phase 3 — Tests migration (2-3 недели)
1. Создать отдельный scale-set `anchor-ci-test` (без kaniko, но с node/go/yarn).
2. Канарейка: один shard Go unit tests → self-hosted.
3. Sharded test jobs (Jest, Go integration) — переключать batch-ами.
4. e2e (Playwright/Cypress) — последними, требуют больше ресурсов на pod (CPU/memory limits в RunnerSet spec).
5. Удалить cloud runner references из workflow после полной миграции.

### Phase 4 — Cleanup (1 неделя)
1. Удалить `credentials_json` secret из repo (WIF replace).
2. Удалить старый `anchor-self-hosted-runner-bootstrap.yml` (manual GHA registration), заменить ARC автоматикой.
3. Документация: `docs/ci/self-hosted-runners.md`, runbook для on-call.

---

## 3. Kaniko Build Action (drop-in replacement)

### Concept

Заменить `docker buildx build --push` на `/kaniko/executor`:

```bash
/kaniko/executor \
  --context=dir://${WORKSPACE} \
  --dockerfile=${DOCKERFILE_PATH} \
  --destination=gcr.io/dualdeed/${IMAGE_NAME}:${GITHUB_SHA} \
  --destination=gcr.io/dualdeed/${IMAGE_NAME}:latest \   # if tag_as_latest
  --cache=true \
  --cache-repo=us-central1-docker.pkg.dev/anchor-ci/internal/kaniko-cache/${IMAGE_NAME} \
  --cache-ttl=168h \
  --build-arg=GIT_COMMIT_ID=${SHORT_SHA} \
  --snapshot-mode=redo \
  --use-new-run \
  --compressed-caching=false   # for large layers, reduce memory
```

### Auth (no credentials_json)

WIF через KSA → GSA. Kaniko читает GCP credentials через `GOOGLE_APPLICATION_CREDENTIALS` или metadata server (GKE Workload Identity). Никакого `docker login` не нужно — kaniko напрямую идёт в registry.

Минимально, что нужно в action:
```yaml
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: projects/.../providers/github-actions
    service_account: arc-runner@dualdeed.iam.gserviceaccount.com
```
Либо (если runner pod уже под KSA с WIF) — ничего, kaniko видит metadata server сам.

### Action file structure

```
.github/actions/build-image-kaniko/action.yml
.github/actions/build-go-image-kaniko/action.yml
```

Inputs совпадают с текущими (gcp_project, image_name, path, platform, tag_as_latest, enable_registry_cache) — drop-in совместимость. `credentials_json` deprecated (WIF используется автоматом).

### Platform

`linux/amd64` only. Multi-arch (linux/arm64) если нужен — отдельный kaniko запуск + manifest list (`crane index` или `docker manifest`). Текущие jobs все amd64 — multi-arch не критично.

---

## 4. ARC RunnerSet Spec (sketch)

`anchor-ci-build` scale-set (Helm values):
```yaml
githubConfigUrl: https://github.com/anchor-g/mono
githubConfigSecret: arc-github-app
minRunners: 2
maxRunners: 30
runnerScaleSetName: anchor-ci-build

template:
  spec:
    serviceAccountName: arc-runner   # WIF-bound
    containers:
      - name: runner
        image: us-central1-docker.pkg.dev/dualdeed/internal/runner-images/anchor-ci:<sha>
        resources:
          requests: { cpu: 2, memory: 4Gi, ephemeral-storage: 30Gi }
          limits:   { cpu: 6, memory: 12Gi, ephemeral-storage: 60Gi }
        env:
          - name: KANIKO_CACHE_REPO_BASE
            value: us-central1-docker.pkg.dev/anchor-ci/internal/kaniko-cache
```

Test scale-set: меньше storage, больше CPU/memory для параллельных тестов.

---

## 5. Cache Strategy

### Per-image cache repos (рекомендация)
```
us-central1-docker.pkg.dev/anchor-ci/internal/kaniko-cache/<image-name>
```
Один cache repo на image = чистая инвалидация, проще debug, kaniko ищет cache hits по точным command hashes.

### TTL
`--cache-ttl=168h` (7 days). Старые слои GAR cleanup policy подчистит.

### GAR cleanup policy
```
Delete untagged images older than 14d
Keep 50 most recent versions per image
```
Применить на `anchor-ci/internal/kaniko-cache` repo.

### Cache warming
Master builds → write cache. PR builds → read cache. Запрет писать кэш с PR (защита от poisoning):
```bash
if [ "${GITHUB_EVENT_NAME}" = "pull_request" ]; then
  CACHE_FLAGS="--cache=true --cache-copy-layers=true"   # read only
else
  CACHE_FLAGS="--cache=true --cache-copy-layers=true --cache-repo=..."   # write
fi
```
Точнее: kaniko по умолчанию читает и пишет в `--cache-repo`. Для read-only — поднять отдельный read-only cache repo, или skip `--cache-repo` write на PR через два прохода. Простейший вариант — IAM: PR runners получают `roles/artifactregistry.reader` only на cache repo.

**Решение:** два KSA — `arc-runner-pr` (reader) и `arc-runner-master` (writer). Selector по `github.event_name` в workflow для выбора runner label.

---

## 6. Security & Isolation

- **WIF** = no long-lived SA keys в repo secrets. Удалить `credentials_json` secret после миграции.
- **PR не пишет в cache** = no poisoning attacks от форков/неверифицированных PR.
- **Ephemeral runners** = pod удаляется после job, нет cross-job state leak.
- **Network policy** в `arc-runners` namespace: deny egress кроме GAR/GCR, GitHub API, npm/yarn registries, GCS.
- **Pod security**: non-root, read-only rootfs где возможно (kaniko требует write в `/kaniko`, `/workspace`).
- **Secrets**: ARC controller использует GitHub App private key из k8s Secret. Rotate quarterly.

---

## 7. Cost Model

Baseline (GitHub-hosted):
- ~$0.008/min × ~3000 build-min/day × 30 = ~$720/month builds only
- Test minutes сравнимо или больше

Self-hosted GKE node pool:
- 4× `n2d-standard-16` preemptible = ~$400/month, держит ~40 parallel runners
- GAR storage (cache): ~$0.10/GB/month × ~200GB cache = $20/month
- Egress GAR → runners (внутри VPC) = бесплатно

Расчётная экономия: ~50-60% от текущих GH minutes, при условии что utilization > 40%.

---

## 8. Risks & Mitigations

| Риск | Mitigation |
|---|---|
| Kaniko image digest ≠ buildx digest для того же Dockerfile | Канарейка с digest diff. Большинство случаев: ok. Edge cases (BuildKit-specific syntax, `--mount=type=cache`) — конвертировать Dockerfile или оставить buildx job до решения. |
| Kaniko OOM на больших слоях (frontend bundles) | `--compressed-caching=false`, поднять memory limit pod до 16Gi для FE builds. Отдельный large-build scale-set если нужно. |
| ARC controller flake → no runners → CI stall | Multi-replica controller. PagerDuty alert на pending workflow > 5min. Fallback runner label `ubuntu-latest` на критичных jobs (deploy gates). |
| WIF mis-config → push fails | Pre-migration: GSA permission audit. Smoke job проверяет `gcloud auth list` + test push в throwaway repo. |
| Self-hosted runner получает untrusted PR code → exfiltration via cache write | См. §6: PR runners read-only на cache repo, network policy egress allowlist. |
| `secrets.GITHUB_TOKEN` scope на self-hosted = такой же, но runtime сторонний | ARC ограничивает только registration token. Job-level GITHUB_TOKEN не утекает за пределы pod (ephemeral). |
| Storage exhaustion на nodes (Docker layer leftovers нет, но workspace big) | `ephemeral-storage` limits + node autoscaler. Cleanup pod hook не нужен (pod ephemeral). |
| Cache thrashing при частых Dockerfile изменениях | Ожидаемо. Cache hit rate target > 60%. Метрика в Grafana по GAR pull counts. |

---

## 9. Observability

- **GKE → GCP Monitoring**: runner pod CPU/memory/disk, ARC controller health.
- **GitHub → ARC metrics**: `actions-runner-controller` exposes Prometheus metrics (queued workflows, running runners, scale events).
- **Build duration tracking**: добавить в kaniko action step output `build_duration_sec`, push в BigQuery dataset `ci_metrics` для trending.
- **Cache hit rate**: парсить kaniko stdout, считать `cache hit`/`cache miss` events. Alert если hit rate < 40%.
- **Dashboards**:
  - "ARC Capacity" — queued vs running runners
  - "Build Performance" — p50/p95 build duration per image, cold vs warm
  - "Cache Health" — hit rate, GAR storage growth

---

## 10. Files to Touch / Create

### Create
- `infra/arc/values-controller.yaml` (Helm values)
- `infra/arc/values-scale-set-anchor-ci.yaml`
- `infra/arc/values-scale-set-anchor-ci-build.yaml`
- `infra/arc/values-scale-set-anchor-ci-test.yaml`
- `infra/arc/runner-image/Dockerfile` (custom runner w/ kaniko, gcloud, etc.)
- `infra/arc/runner-image/build.sh` (CI для самого runner image)
- `.github/actions/build-image-kaniko/action.yml`
- `.github/actions/build-go-image-kaniko/action.yml`
- `.github/actions/build_node_service-kaniko/action.yml`
- `docs/ci/self-hosted-runners.md` (runbook)
- `docs/ci/kaniko-cache.md` (cache invalidation, debug)

### Modify
- `.github/workflows/build-deployables.yml` — `runs-on:` per job, use new kaniko actions
- `.github/actions/configure_build/action.yml` — add `runner_target` output
- `.github/workflows/anchor-self-hosted-runner-bootstrap.yml` — replace manual flow with ARC reference (or delete)

### Delete (после миграции)
- Secret `credentials_json` (GitHub repo settings, after WIF fully wired)
- Старые composite actions (`build-image`, `build-go-image`, `build_node_service`) после grace period

---

## 11. Rollback Strategy

Каждая фаза reversible:
- Phase 2 канарейка fail → revert один workflow file (`runs-on:` back to ubuntu-latest, use старый action). Старые actions сохраняем до завершения Phase 4.
- ARC controller down → manual `kubectl scale deploy/arc-runner-set --replicas=0`, jobs идут на cloud (если оставлен fallback runs-on label).
- Kaniko build digest mismatch на prod image → rebuild через старый buildx path в hot-patch ветке.

Trigger для rollback:
- Build failure rate self-hosted > 5% за 24h
- p95 build time self-hosted > 2× cloud baseline
- Push failures (auth/network) > 1%

---

## 12. Open Questions

- Поддержка ARM (`linux/arm64`) для MCP server (Cloudflare Workers — нет, но если когда-то будет нужен — kaniko multi-arch усложнит)?
- nightly schedule jobs — приоритет на self-hosted (могут ночью тянуть весь cluster) или dedicated low-prio scale-set?
- `claude-code-review.yml` и Anthropic API calls — self-hosted ok, но нужно ли VPC egress в Anthropic? Скорее всего да (network policy allowlist).
- POC self-hosted timeout 60min vs cloud 28min — почему 2× медленнее? Cold cache? Node CPU? Перед массовой миграцией — root cause найти.

---

## TL;DR

1. Поставить ARC в GKE с GitHub App registration.
2. Кастомный runner image с kaniko + gcloud + node/go.
3. WIF KSA → GSA, удалить `credentials_json` secret.
4. Новый `build-image-kaniko` action параллельно со старым. Канарейка → постепенный rollout по доменам.
5. Cache в GAR `anchor-ci/internal/kaniko-cache/<image>`, write только с master, read-only с PR (IAM split).
6. Phased: builds (2-3 нед) → tests (2-3 нед) → cleanup (1 нед). Всего ~8 недель end-to-end.
