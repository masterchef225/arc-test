# Pipeline Decomposition — `.github_copy/`

Карта всех 24 workflow + 15 composite actions. Что когда запускается, какие зависимости, где можно резать.

---

## 1. Triggers Map (что → когда)

| Trigger family | Workflows |
|---|---|
| `pull_request` (open/sync) | claude-code-review, external-api-doc-review, fe-preview, auto-merge-locales, build-deployables |
| `push` master | build-deployables, jest-coverage-master, external-api-staging, deploy-anchor-mcp-server, auto-merge-locales |
| `workflow_run` (chained) | update-last-green |
| `issue_comment` | claude-code-review (#review), code-review-pr-comment (#cr/done), claude (@claude), promote-docs (`/promote-docs vX.Y.Z`) |
| `pull_request_review*` | code-review-review-requested, code-review-review-submitted, claude |
| `commit_comment` | code-review-commit-comment |
| `schedule` (nightly) | build-deployables |
| `workflow_dispatch` only | anchor-self-hosted-runner-bootstrap, self-hosted-smoke, poc-build-investigation-agent-self-hosted, external-api-promote, claude-fix-drift, claude-flake-fix |
| `workflow_call` (reusable) | bundle-analysis-pr, bundle-analysis-master, jest-coverage-pr |

---

## 2. Main Pipeline: `build-deployables.yml` (4421 lines)

Один монолит. Buckets по `needs:` chain:

```
[Setup]
  configure-build      ← path diff → matrix решает что строить
  pr-metadata
  decide-docker-builders
  determine-versions
        │
        ▼
[Build] 60+ jobs, group by domain
  backend (go services)      \
  frontend (packages/*)       \  per-domain concurrency
  data                         > parallel fan-out
  billing                     /
  rnd                        /
        │
        ▼
[Test] 40+ sharded jobs
  unit / integration / e2e / Jest (sharded)
  per-team grouping
        │
        ▼
[Report]
  report-flaky-tests  ─────► async dispatch claude-flake-fix.yml
  bundle-analysis-results (calls bundle-analysis-master.yml)
  jest-coverage (calls jest-coverage-pr.yml)
  update-last-green-candidate
        │
        ▼
[Publish]
  docker push GAR
  artifacts → GCS
        │
        ▼
[Notify] per-domain Slack on failure
```

**Concurrency:** per-domain + per-shard, чтобы PR burst не блокировал master.

### Точки разрезания build-deployables

| Кандидат → reusable workflow | Что вынести |
|---|---|
| `_setup.yml` | configure-build + pr-metadata + determine-versions |
| `_build-go.yml` | все Go service builds (matrix) |
| `_build-node.yml` | node-services builds (matrix) |
| `_build-frontend.yml` | packages/frontend + seagull + backoffice |
| `_test-go.yml` | Go unit + integration shards |
| `_test-jest.yml` | Jest shards + coverage merge |
| `_test-e2e.yml` | Cypress / Playwright |
| `_publish.yml` | docker push + GCS upload |
| `_notify.yml` | per-domain Slack (уже composite, но окутать workflow) |

Главный `build-deployables.yml` становится оркестратором ~300 строк который зовёт reusable workflows.

---

## 3. Cross-Workflow Chains

```
build-deployables (master, success)
   ├──► update-last-green                    (workflow_run)
   ├──► claude-flake-fix                     (gh workflow run + artifact)
   └──► (косвенно) external-api-staging      (тот же push event)

Slack /fix-drift → Anchovy bot
   └──► claude-fix-drift                     (gh workflow run)

PR comment `/promote-docs vX.Y.Z`
   └──► promote-docs
          └──► deploy-anchor-mcp-server      (inline gh workflow run, env=prod)

Push master + paths(node-services/anchor-mcp-server/**)
   └──► deploy-anchor-mcp-server (env=demo, auto)
```

---

## 4. Workflow Inventory (compact)

### PR-driven (8)
| File | Jobs | Purpose |
|---|---|---|
| claude-code-review.yml | review-with-tracking | Auto-review PR via Claude |
| code-review-pr-comment.yml | notify | Slack on #cr/done |
| code-review-review-requested.yml | notify | Slack on reviewer assigned |
| code-review-review-submitted.yml | notify | Slack on review done |
| external-api-doc-review.yml | label-presence, llm-review | Enforce semver label + LLM review swagger |
| fe-preview.yml | build, cleanup | Ephemeral FE preview GCS |
| bundle-analysis-pr.yml (call) | bundle-analysis-pr | Bundle size delta PR comment |
| jest-coverage-pr.yml (call) | jest-coverage-pr | Coverage delta PR |

### Master/push (6)
| File | Jobs | Purpose |
|---|---|---|
| build-deployables.yml | 100+ | См. §2 |
| auto-merge-locales.yml | auto-merge-locales, update-prs-on-master-push | Resolve locale JSON conflicts |
| bundle-analysis-master.yml (call) | bundle-analysis | Bundle size baseline + alert |
| jest-coverage-master.yml | jest-coverage-master | Coverage degradation alert |
| external-api-staging.yml | upload-staging | Swagger → readme.io staging |
| deploy-anchor-mcp-server.yml | deploy | MCP server → Cloudflare Workers |

### Chained (1)
| File | Source trigger |
|---|---|
| update-last-green.yml | `workflow_run: build-deployables success on master` |

### Manual (5)
| File | Purpose |
|---|---|
| anchor-self-hosted-runner-bootstrap.yml | Bootstrap GHA runner pod в k8s |
| self-hosted-smoke.yml | Smoke test self-hosted runner |
| poc-build-investigation-agent-self-hosted.yml | POC self-hosted Docker build |
| external-api-promote.yml | Hot-patch swagger promotion |
| claude.yml | @claude trigger general |

### Comment-driven (2)
| File | Trigger |
|---|---|
| code-review-commit-comment.yml | `commit_comment` "done" |
| promote-docs.yml | `/promote-docs vX.Y.Z` PR comment |

### Auto-fix (Claude) (2)
| File | Trigger | Fan-out |
|---|---|---|
| claude-fix-drift.yml | Anchovy bot dispatch | matrix=drift clusters, max-parallel 3 |
| claude-flake-fix.yml | CI dispatch + artifact | matrix=flaky files, max-parallel 3 |

---

## 5. Composite Actions (15)

| Action | Purpose |
|---|---|
| install_node_modules | Node + yarn install w/ cache |
| build_node_service | Build+push Node Docker → GAR |
| build-image | Generic Docker build → GCR/GAR + signing |
| build-go-image | Go Docker (wraps build-image) |
| configure_build | Path-diff → build matrix |
| run-tests | `yarn epic <package>` |
| fetch_last_known_good_version | Resolve last good version GCS |
| clone_anchor_deployment | Kubeconfig + clone deploy repo |
| slack_notify | Slack post |
| notify_slack_{backend,frontend,billing,data,rnd}_on_error | Domain failure alerts |
| upload_to_gcs | GCS artifact upload |

---

## 6. Proposed Decomposition Plan

### Phase 1 — split build-deployables only (highest ROI)

```
.github/workflows/
  build-deployables.yml          ← orchestrator, ~300 lines
  _setup.yml                     ← configure-build + metadata + versions
  _build-go.yml                  ← matrix Go services
  _build-node.yml                ← matrix node-services
  _build-frontend.yml            ← packages/frontend + seagull + backoffice
  _test-go.yml                   ← Go unit + integration shards
  _test-jest.yml                 ← Jest shards
  _test-e2e.yml                  ← Cypress/Playwright
  _publish.yml                   ← docker push + GCS
  _report.yml                    ← flaky-tests + last-green + bundle + coverage
```

Все `_*.yml` = `workflow_call`. Главный workflow только `needs:` chain + матрицы вход/выход.

### Phase 2 — group code-review-* (4 workflows → 1)

`code-review-*` workflows = 4 файла × ~40 строк, разные триггеры одного домена. Merge в `code-review-events.yml` через `on: [issue_comment, pull_request_review, pull_request, commit_comment]` + job-level `if:` фильтры.

### Phase 3 — group external-api-* (3 workflows)

`external-api-doc-review.yml` + `external-api-staging.yml` + `external-api-promote.yml` + `promote-docs.yml` → один доменный файл с jobs по триггеру, плюс reusable `_external-api-lib.yml` для общей логики (swagger gen, readme upload).

### Phase 4 — bundle/coverage в общий test-reports reusable

`bundle-analysis-{pr,master}` + `jest-coverage-{pr,master}` → один `_test-reports.yml` с input `mode: pr|master`.

---

## 7. What NOT to merge

- `claude-fix-drift` + `claude-flake-fix` похожи но: разные триггеры (bot vs CI artifact), разные matrix keys, разные skills, разные dedup правила. Merge даст fewer files но больше `if:` — net negative.
- `anchor-self-hosted-runner-bootstrap` + `self-hosted-smoke` + `poc-build-investigation-agent-self-hosted` = разные lifecycle stages (bootstrap → smoke → POC). Оставить separate.
- `claude-code-review.yml` отдельно от `claude.yml` — разные scopes (PR-only auto vs @claude any).

---

## 8. Risks & Notes

- **Reusable workflow secrets:** `workflow_call` требует явный `secrets: inherit` или enumeration. Перед split проверить какие secrets каждый job дёргает.
- **Concurrency groups** при разрезании наследуются по каждому called workflow. Может потребоваться `concurrency:` на caller + callee одновременно для правильного cancellation.
- **Artifact passing** между reusable workflows: только через upload/download artifact или outputs. Большие артефакты (flake-context) — через artifacts, маленькие (versions, matrix) — через outputs.
- **Build matrix outputs** ограничены 1MB. Если configure-build выдаёт большую матрицу — оставить inline в caller, не выносить в reusable.
