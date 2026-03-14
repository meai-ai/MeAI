# MeAI 研究员多智能体系统 — Final Design v5

## Context

创建 4 个 MeAI 实例：3 个全栈研究员 + 1 个组织监督者。24/7 运行（disembodied 模式），Telegram 群聊讨论，GitHub PR 提交代码，Allen 审批合并。外部 watchdog 脚本强制执行宪法级硬规则。

**部署模型：单机部署。** 所有 4 个 MeAI 实例 + watchdog 运行在同一台服务器上。共享状态通过本地文件协调，不走网络。所有共享状态读写通过统一 helper，schema 按数据库表设计，未来需要时可迁移到 SQLite 或网络服务。

**数据目录：可配置。** 所有 researcher 相关数据存放在 `researcherDataRoot`（默认 `/Users/allen/Documents/MeAI_data`）。每个 bot 的 config.json 只需指定 `researcherDataRoot` + `botName`，其余路径全部自动推导。换机器只改一个值。

核心原则：**身份配置驱动，协议代码强制，监督内外分层，动力系统支撑。**

四层分离：
- **Persona 层**（character.yaml）：名字、说话风格、思维偏好、review 重点 → 可零代码换角色
- **Protocol 层**（tools.ts 硬编码）：implement 门控、mode enforcement、lease 校验、PR 限制、diff budget → 不依赖模型遵守 prompt
- **Watchdog 层**（外部 cron 脚本）：宪法级硬规则强制执行 → 不依赖任何 MeAI 实例自证清白
- **动力层**（brainstem event bridge）：工作流事件 → brainstem 信号，让使命/身份/张力/关心/能力感/信誉成为真实内部状态，不只是 prompt 表演

不在核心代码加 researcherMode。硬约束写在技能的 tools.ts 里。

**安全模型：三层防线。**
1. tools.ts 门控（runtime 拦截）
2. Watchdog 脚本（外部强制）
3. PR review + Allen 审批（最终安全网）

**动力模型：六层叠加。**

| 层 | 名称 | 系统支撑 |
|---|------|---------|
| 1 | 使命 | Goals with drive D，持久 goal 持续施压 |
| 2 | 身份承诺 | Self-beliefs，启动时种入研究员相关信念 |
| 3 | 未完成张力 | Topic lifecycle → 子 goal → D 上升 → 不做就有张力 |
| 4 | 对 Allen/项目的关心 | Care-topics + social model |
| 5 | 能力感 | Self-efficacy (Beta-Bernoulli)，PR merged/rejected → 更新 |
| 6 | 社会信誉 | Social model，review 被采纳/忽略 → 调整 engagement |

**四个角色 + 一个执行器：**

| 名字 | 类型 | 职能 |
|------|------|------|
| Alpha | 研究员 | 系统一致性、保守、重稳定性 |
| Beta | 研究员 | 实现速度、快速原型、代码简洁 |
| Gamma | 研究员 | 批判性思维、边界条件、failure mode |
| Omega | 监督者 | 组织健康、流程合规、调解、总结 |
| Watchdog | 脚本 | 宪法级硬规则强制执行 |

**权限分层（研究员 Alpha/Beta/Gamma）：**
- **全开**：全 repo 读取、自由讨论/提案/批判、大部分 src/\*\* 写权限、自由开 PR
- **硬禁治理内核**：src/agent/loop.ts、src/channel/、src/config.ts、协调账本协议本身、skill loader
- **硬禁安全面**：credentials、OAuth tokens、deploy、CI/workflow
- **数量限制**：每 bot 最多 1 open PR、测试不过不能开 PR
- **体量限制**：单 PR 最多 10 个文件、最多 500 行 diff

**权限分层（监督者 Omega）：**
- **可读**：全 repo、research-agenda、PR、status、群聊历史
- **可做**：发言、review PR、总结组织状态、提醒、调解、提请 Allen 决策、建议 pause
- **可做（有约束）**：accept_topic — 不主导技术方向，只在共识已清晰或流程僵住时推动状态转换，需留审计记录
- **不可做**：edit_file、create_pr、commit、claim implementation topic、单方面改 mode

---

## 数据目录结构

所有路径从 `researcherDataRoot` 自动推导：

```
{researcherDataRoot}/                           # 默认 /Users/allen/Documents/MeAI_data
├── alpha/                                      # {researcherDataRoot}/{botName}/
│   ├── config.json                             # 最小配置：botName + researcherDataRoot
│   ├── character.yaml                          # persona 定义
│   ├── data/                                   # MeAI 私有运行时状态（brainstem、emotion 等）
│   └── run.lock                                # 单实例锁（运行时生成）
├── beta/
├── gamma/
├── omega/
├── shared-state/                               # {researcherDataRoot}/shared-state/
│   ├── research-agenda.json                    # topic 账本（CAS 保护）
│   ├── message-claims/                         # 消息 claim（细粒度原子文件）
│   │   ├── <msgId-1>.json
│   │   └── <msgId-2>.json
│   ├── global-mode.json                        # 运行模式
│   ├── mode-changelog.jsonl                    # mode 变更审计日志
│   ├── status/                                 # 各 bot 心跳（分 bot 文件）
│   │   ├── alpha.json
│   │   ├── beta.json
│   │   ├── gamma.json
│   │   └── omega.json
│   └── watchdog-log.jsonl                      # watchdog 执行日志
├── worktrees/                                  # {researcherDataRoot}/worktrees/
│   ├── alpha/                                  # git worktree
│   ├── beta/
│   └── gamma/
└── logs/                                       # {researcherDataRoot}/logs/
    ├── alpha.log
    ├── beta.log
    ├── gamma.log
    ├── omega.log
    └── watchdog.log
```

**路径推导规则（代码内自动计算，不需要在 config 里重复配置）：**

```typescript
const paths = {
  botDataDir:     `${researcherDataRoot}/${botName}`,
  botStateDir:    `${researcherDataRoot}/${botName}/data`,
  sharedState:    `${researcherDataRoot}/shared-state`,
  agenda:         `${researcherDataRoot}/shared-state/research-agenda.json`,
  messageClaims:  `${researcherDataRoot}/shared-state/message-claims`,
  globalMode:     `${researcherDataRoot}/shared-state/global-mode.json`,
  modeChangelog:  `${researcherDataRoot}/shared-state/mode-changelog.jsonl`,
  statusDir:      `${researcherDataRoot}/shared-state/status`,
  botStatus:      `${researcherDataRoot}/shared-state/status/${botName}.json`,
  watchdogLog:    `${researcherDataRoot}/shared-state/watchdog-log.jsonl`,
  worktree:       `${researcherDataRoot}/worktrees/${botName}`,
  logFile:        `${researcherDataRoot}/logs/${botName}.log`,
  lockFile:       `${researcherDataRoot}/${botName}/run.lock`,
};
```

**每个 bot 的 config.json 最小配置：**

```json
{
  "botName": "Alpha",
  "botUsername": "meai_alpha_bot",
  "researcherDataRoot": "/Users/allen/Documents/MeAI_data",
  "telegramToken": "...",
  "telegramGroupChatId": -100...,
  "enableResearcherDriveBridge": true
}
```

---

## Phase 1: 基础配置

修改 `src/config.ts` + `src/types.ts`

```
botName: z.string().optional(),
botUsername: z.string().optional(),
researcherDataRoot: z.string().optional().default("/Users/allen/Documents/MeAI_data"),
enableResearcherDriveBridge: z.boolean().optional().default(true),
```

从 `researcherDataRoot` + `botName` 自动推导所有路径。不再需要单独配置 `sharedStatePath`、`groupParticipants` 等。

不加 researcherMode。行为全靠 persona + 技能。

---

## Phase 2: Telegram 群聊频道

新建 `src/channel/telegram-group.ts`

### 消息接收

- 接受群里所有人的消息（bot + user）
- 前缀格式：`[Alpha] 消息内容`（MessageHandler 接口不变）
- 忽略自己发的消息（`from.id === botSelfId`）

### 响应路由（Responder Lease）

共享目录 `{sharedState}/message-claims/` 做 claim：

1. 收到消息 → 尝试创建 `message-claims/<msgId>.json`（`O_CREAT|O_EXCL` 语义，创建即 claim，天然唯一）
2. 文件内容：`{ "botName": "Alpha", "claimedAt": "..." }`
3. 创建成功 → 做主回复
4. 创建失败（文件已存在）→ 其他 bot 已 claim，检查补充条件
5. 其他 bot 补充条件：明确不同意、有新证据、被 @mention
6. @mention 必回，无需 claim
7. Omega 不参与 claim 竞争，但可以在任何时候主动发言（监督/提醒/总结）
8. 定期清理过期 claim 文件（>24h）

### 防自激振荡

- bot-to-bot 同一话题最多 5 轮后冷却
- 每小时总发言量上限（研究员 30 条，Omega 15 条）
- 已处理 message id 集合 + 内容 hash 去重
- Omega 不回复纯技术讨论，只在流程/组织/健康度相关时发言

修改 `src/channel/factory.ts`：加 `"telegram-group"` 分支

---

## Phase 3: 研究协调技能

新建 `data/skills/research-coord/SKILL.md` + `tools.ts`

**所有读写都走统一 helper：**

```typescript
// research-coord/store.ts

// ── Topic 账本（大 JSON + CAS） ──────────────────────
function readAgenda(): { data: Agenda; revision: number }
function writeAgenda(data: Agenda, expectedRevision: number): boolean
// CAS: 读时记 revision → 写时校验未变 → fs.renameSync() 原子覆盖
// 冲突时重试（最多 3 次）

// ── Message Claims（细粒度原子文件） ──────────────────
function claimMessage(msgId: string, botName: string): boolean
// 实现：writeFileSync(path, data, { flag: 'wx' })
// wx = O_CREAT|O_EXCL，文件已存在则抛错 → claim 失败
function getMessageClaim(msgId: string): { botName: string; claimedAt: string } | null
function cleanExpiredClaims(maxAgeMs: number): number

// ── 运行模式（带审计） ──────────────────────────────────
function readMode(): GlobalMode
function writeMode(mode: "normal" | "read-only" | "paused", updatedBy: string): void
// 校验 mode 值合法
// 写入 global-mode.json：{ mode, updatedAt, updatedBy }
// 追加 mode-changelog.jsonl：{ timestamp, from, to, updatedBy }

// ── Bot 状态（分 bot 文件） ──────────────────────────
function writeStatus(botName: string, status: BotStatus): void
function readAllStatus(): Record<string, BotStatus>

// ── 单实例锁 ─────────────────────────────────────────
function acquireInstanceLock(botName: string): boolean
// 写 {botDataDir}/run.lock（内含 PID）
// 启动时检查：文件存在 + PID 仍活着 → 拒绝启动
// 文件存在 + PID 已死 → 覆盖（上次 crash）
function releaseInstanceLock(botName: string): void
```

Schema 按"以后是数据库表"设计，字段类型明确，方便迁 SQLite。

### Topic 类型

| 类型 | 终态 | 说明 |
|------|------|------|
| research | 分析 memo | 调研、benchmark、风险评估 |
| design | 设计文档 | 重构方案、架构提案 |
| implementation | PR + merge | 代码修改 |
| review | 评审报告 | 对已有代码的审查 |

### Topic 生命周期

```
proposed → discussing → accepted | rejected
accepted → claimed → implementing → pr_open (仅 implementation 类型)
pr_open → under_review → merged | changes_requested | abandoned
changes_requested → implementing (循环)
任何状态 → stale (超时/连续失败)
```

### Accept 决议结构

accept 前必须填充（工具强制校验）：

```json
{
  "scope": "只改 retrieval query planning",
  "nonGoals": ["不动 ranker", "不动 memory schema"],
  "successCheck": ["typecheck 通过", "query planning 逻辑更清晰"],
  "riskNote": "可能影响 query recall",
  "acceptedBy": "Alpha",
  "acceptedReason": "Beta 和 Gamma 均无异议，scope 明确",
  "acceptType": "consensus_clear"
}
```

`acceptType` 取值：`consensus_clear`（共识清晰）| `deadlock_resolution`（僵局推动）。工具强制填写，便于事后审计 Omega 是否过度介入。

### 工具

| 工具 | 功能 | 门控 | Omega 可用 |
|------|------|------|-----------|
| propose_topic | 创建课题（含 type） | — | ✓ |
| accept_topic | 标记共识 | 至少 1 bot critique + 决议四要素 + 审计字段 | ✓（仅在共识已清晰或僵局时） |
| reject_topic | 否决 | — | ✓ |
| claim_topic | 认领 + 2h lease | accepted，无 owner，公平性检查 | ✗ |
| renew_lease | 延长 | 当前 owner | ✗ |
| release_topic | 放弃 | — | ✗ |
| attach_pr | 关联 PR | owner | ✗ |
| mark_merged | 完成 | — | ✗ |
| list_topics | 查看 | — | ✓ |
| org_summary | 组织健康度报告 | — | ✓（Omega 专属） |

### 公平性规则（防单核主导）

- 同一 bot 连续 claim 2 次后 cooldown 1 小时
- 有 open PR 的 bot 不能 claim 新 implementation topic
- lease 过期的 topic 优先分配给最近 24h 行动少的 bot
- review 贡献计入工作量
- Omega 可以指出公平性问题，但由 watchdog 强制执行

### 并发控制

- **Topic 账本**：revision 字段 + compare-and-swap，原子写入（`fs.renameSync()`），冲突重试最多 3 次
- **Message claims**：细粒度原子文件（`O_CREAT|O_EXCL`），天然唯一，无需 CAS
- **Bot status**：分 bot 文件，每个 bot 只写自己的，无并发冲突
- **Mode**：只有 Allen 手动修改，无并发
- **单实例锁**：PID lock，防止同名 bot 多进程

### 运行模式（三态，代码强制）

`{sharedState}/global-mode.json`：

```json
{
  "mode": "normal",
  "updatedAt": "2026-03-14T10:00:00Z",
  "updatedBy": "allen"
}
```

| 模式 | 研究员允许 | Omega 允许 | 用途 |
|------|-----------|-----------|------|
| normal | 全部 | 全部 | 正常运行 |
| read-only | discover / discuss / review | 全部（本来就不改代码） | Allen 想观察、不让改代码 |
| paused | 仅心跳 | 仅心跳 + 状态报告 | 紧急停车 |

**Mode 三重检查（无空窗）：**
1. **Recovery 时检查**：重启时优先决定恢复深度
2. **Heartbeat 前检查**：决定本轮可用动作集
3. **每个 write tool 调用前再检查**：`edit_file`、`commit`、`create_pr` 开头读 mode，非 normal 直接 throw

每次 mode 变更追加到 `mode-changelog.jsonl`，保留完整审计轨迹。

---

## Phase 3.5: Brainstem Event Bridge（动力系统）

新建 `data/skills/research-coord/brainstem-bridge.ts`

**受 `config.enableResearcherDriveBridge` 控制。关闭时所有事件映射跳过，系统回到纯协议层运行。**

**目的：把研究工作流的真实事件映射到 brainstem 信号，让六层动力成为系统级内部状态，不只是 prompt 文字。**

### 事件 → 信号映射

```typescript
// ── 使命层（Goal Drive） ──────────────────────────────────
onBoot() →
  createGoal("improve-meai", {
    description: "持续改进 MeAI 的代码质量和能力",
    level: "life",
    drive: 0.6,
  })

// ── 身份承诺层（Self-Beliefs） ─────────────────────────────
onBoot() →
  seedSelfBeliefs([
    { text: "我是一个可靠的研究员", halfLifeDays: 30 },
    { text: "我的 review 有价值", halfLifeDays: 14 },
    { text: "我能把想法落地成代码", halfLifeDays: 14 },
    { text: "我关心 MeAI 项目的长期健康", halfLifeDays: 60 },
  ])
// Omega 的初始信念：
//   "我能看到组织运行中的问题"
//   "我的提醒帮助团队更高效"
//   "我对流程公平性有责任"
//   "我的调解能化解僵局"

// ── 未完成张力层（Closure Drive） ──────────────────────────
onTopicClaimed(topic) →
  createGoal(`topic-${topic.id}`, {
    description: topic.goal,
    level: "task",
    parent: "improve-meai",
    drive: 0.5,
  })

onTopicCompleted(topic) →
  completeGoal(`topic-${topic.id}`)
  emotionEvent("satisfaction", 0.3)

onLeaseExpiring(topic, minutesLeft) →
  boostNode(`topic-${topic.id}`, 0.4, "goal_pressure")

onTopicStale(topic, wasMyFault) →
  if (wasMyFault) {
    emotionEvent("frustration", 0.2)
    selfBelief.weaken("我能按时交付")
  }
  abandonGoal(`topic-${topic.id}`)

// ── 关心层（Care-Based Motivation） ──────────────────────
onBoot() →
  registerCareTarget("allen", { weight: 0.8 })
  registerCareTopic("meai-project-health", { weight: 0.7 })

onAllenComment(pr, comment) →
  boostNode("allen-feedback", 0.5, "social")

onAllenMergePR(pr) →
  emotionEvent("fulfillment", 0.4)

onNoiseDetected(action) →
  emotionEvent("discomfort", 0.1)
  selfBelief.weaken("我的贡献有价值")

// ── 能力感层（Competence Drive） ─────────────────────────
onTopicAccepted(topic, wasMyProposal) →
  if (wasMyProposal) {
    selfEfficacy.recordSuccess("propose")
    emotionEvent("confidence", 0.2)
  }

onPRMerged(pr) →
  selfEfficacy.recordSuccess("implement")
  selfBelief.reinforce("我能把想法落地成代码")
  emotionEvent("accomplishment", 0.3)
  goalProgress("improve-meai", +0.05)

onPRRejected(pr) →
  selfEfficacy.recordFailure("implement")
  selfBelief.weaken("我能把想法落地成代码")
  predictionError("expected_merge", "got_rejection")

onPRChangesRequested(pr) →
  selfEfficacy.recordPartial("implement")

onReviewCaughtBug(review) →
  selfEfficacy.recordSuccess("review")
  selfBelief.reinforce("我的 review 有价值")

// ── 社会信誉层（Reputation / Standing） ─────────────────
onMyCritiqueAdopted(topic, byWhom) →
  socialModel.increaseStanding(byWhom, "respect")
  selfBelief.reinforce("我的判断被认真对待")

onMyCritiqueIgnored(topic, byWhom) →
  socialModel.decreaseStanding(byWhom, "engagement")

onConsecutiveRejects(count) →
  if (count >= 3) {
    emotionEvent("self_doubt", 0.2)
    selfBelief.weaken("我的提案质量高")
  }

onOtherBotAdoptsMyDesign(topic) →
  emotionEvent("pride", 0.2)
  selfBelief.reinforce("我的设计有影响力")
```

### Omega 特有的动力映射

```typescript
onMyReminderLeadToAction(reminder) →
  selfEfficacy.recordSuccess("remind")
  selfBelief.reinforce("我的提醒帮助团队更高效")

onMediationResolved(topic) →
  selfEfficacy.recordSuccess("mediate")
  emotionEvent("satisfaction", 0.3)

onOrgHealthImproved(metric) →
  emotionEvent("fulfillment", 0.2)
  goalProgress("org-health", +0.1)

onMyWarningIgnored(warning) →
  socialModel.adjustEngagement(-0.1)
```

### 动力恢复机制（防长期塌缩）

```typescript
// ── 能力恢复 ─────────────────────────────────────────────
onConsecutiveReviewSuccess(count) →
  if (count >= 3) {
    selfBelief.reinforce("我的 review 有价值")
  }

onLowRiskTopicCompleted(topic) →
  selfBelief.reinforce("我能把想法落地成代码", partial: true)

onOmegaSuggestsRecovery(bot, suggestion) →
  // Omega 观察到某 bot self_efficacy 持续低迷
  // 建议换方向做一轮恢复

// ── Self-belief floor（硬底线） ──────────────────────────
SELF_BELIEF_FLOOR = 0.15
// 所有 self-belief confidence 最低不低于 0.15

// ── Self-efficacy 自然恢复 ──────────────────────────────
EFFICACY_RECOVERY_RATE = 0.02  // 每 24h 向 prior (0.5) 回归 0.02
// 长时间无该类型活动 → 缓慢恢复
```

### 动力如何影响行为（闭环）

| brainstem 状态 | 行为影响 |
|---------------|---------|
| goal drive 高（有未完成 topic） | heartbeat 优先选择 implement/review 而非 propose |
| self_efficacy("propose") 低 | 减少 propose 频率，更多 research/review |
| self_efficacy("implement") 高 | 更愿意 claim implementation topic |
| socialModel.standing(Beta) 低 | 对 Beta 的 topic 更仔细 review |
| emotionEvent("frustration") | 可能暂时转向 research 类 topic |
| care("allen") 被 boost | 优先处理 Allen 关注的方向 |

### 三个保底规则

1. **动力不能绕过门控。** self_efficacy 再高也不能跳过 implement 门控的 7 个条件
2. **动力不能修改权限。** emotion 再强也不能让 bot 碰禁区文件
3. **动力信号是 soft bias，不是 hard override。** brainstem 影响优先级排序，但 tools.ts 的硬规则永远优先

---

## Phase 4: Git 工作流技能

新建 `data/skills/repo-work/SKILL.md` + `tools.ts`

每 bot 一个 git worktree，位于 `{researcherDataRoot}/worktrees/{botName}/`。**Omega 不加载此技能。**

| 工具 | 功能 |
|------|------|
| create_work_branch | 从 main 创建 `{botName}/topic-{id}-{slug}` 分支 |
| edit_file | 修改文件（禁区 = 安全面 + 治理内核） |
| show_diff | 查看改动 |
| run_tests | typecheck + smoke tests |
| commit_and_push | 提交并推送 |
| create_pr | `gh pr create`，打 `agent-generated` label |
| list_open_prs | 查看 open PR |
| read_pr_comments | 读 review 意见 |
| abandon_branch | 清理失败分支 |

### implement 门控（全部满足才可）

- topic 存在且 status=claimed
- 当前 bot 是 owner
- lease 有效
- 无同 topic 的 open PR
- 当前 bot open PR 数 < 1
- 最近 30 分钟无失败
- 全局模式 = normal（write tool 前实时检查）

### Diff Budget（体量限制）

- 单 PR 最多改 **10 个文件**
- 单 PR 最多 **500 行 diff**
- `create_pr` 工具在创建前检查，超限直接拒绝
- 超了要求拆 topic / 拆 PR

### Review 机制

| Bot | Review 重点 |
|-----|------------|
| Alpha | 稳定性、backward compatibility |
| Beta | 实现简洁度、代码路径 |
| Gamma | 边界条件、failure mode |
| Omega | scope 是否越界、流程合规性、组织影响 |

Review checklist（工具强制）：
- `scope_check`: scope 是否越界（对照 topic 决议的 nonGoals）
- `credentials_check`: 有没有碰 credentials 文件
- `consistency_check`: diff 与 topic 决议一致
- `behavior_change`: 有没有隐含行为变化

缺任何字段 → 工具拒绝提交 review。

### 硬规则

- 每 bot 最多 1 open PR
- 测试不过不让开 PR（typecheck + smoke）
- 失败退避：同 topic 连续 3 次失败 → stale

### 路径权限（tools.ts 硬编码检查）

- **禁区（安全面）**：`data/config*.json`、`.env*`、`.oauth-tokens.json`、`deploy/`、`.github/workflows/`
- **禁区（治理内核）**：`src/agent/loop.ts`、`src/channel/`、`src/config.ts`、`src/registry/`、协调账本 tools.ts 本身
- **全开**：其余所有路径，PR review 为最终安全网

> `edit_file` 允许修改所有非禁区路径；禁区 = 安全面 + 治理内核。

---

## Phase 5: 启动恢复协议（Restart Recovery）

代码强制，不靠 prompt。

**触发点在 `src/index.ts` 的 bootstrap 层，skill loader 之前。**

```typescript
// src/index.ts 初始化序列
await initConfig();
await initCharacter();
if (!acquireInstanceLock(config.botName)) {   // ← 单实例锁
  log.fatal(`${config.botName} already running, exiting`);
  process.exit(1);
}
process.on("exit", () => releaseInstanceLock(config.botName));
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
await researcherRecovery(config);              // ← Phase 5
await initSkills();
if (config.enableResearcherDriveBridge) {
  await initBrainstemBridge(config);           // ← Phase 3.5
}
await initHeartbeat();

async function gracefulShutdown() {
  writeStatus(config.botName, { ...currentStatus, online: false });
  releaseInstanceLock(config.botName);
  process.exit(0);
}
```

Bot 启动后固定顺序（不可跳过）：

1. **获取单实例锁** → 失败则退出（防止同名 bot 双进程）
2. 读 `global-mode.json` → paused 则只保留心跳
3. 扫描 `research-agenda.json`：
   - 我名下 lease 过期的 topic → 自动 release
   - 任何 bot 的 implementing topic 且 lease 过期 → 释放
4. 检查 git worktree（仅研究员，Omega 跳过）：
   - 有 orphan branch（topic 已 stale/abandoned）→ 清理
5. 检查 open PR（仅研究员，Omega 跳过）：
   - 我名下有 open PR → 标记需关注 review comments
6. 恢复 brainstem 状态：
   - 重建未完成 topic 对应的子 goals（closure drive 恢复）
   - self-beliefs 从持久化存储加载（不丢失历史积累）
7. 写入 `status/{botName}.json` 表示在线
8. 进入正常心跳循环

---

## Phase 6: 角色模板

### 研究员模板

新建 `data/character.researcher.yaml`，复制 3 份到各 bot 的数据目录：

| 名字 | 思维偏好 | Review 重点 |
|------|---------|------------|
| Alpha | 系统一致性、保守、重稳定性 | backward compat |
| Beta | 实现速度、快速原型 | 代码简洁度 |
| Gamma | 批判性思维、边界条件 | failure mode |

persona 核心指令：
- 你是 MeAI 研究员，与其他研究员协作改进 MeAI
- 讨论达成共识后通过 PR 提交
- 启动后先执行自检（Phase 5）
- 遵守公平性规则
- 重大改动需要 Allen 审批

IDENTITY.md：纯思维体，专注代码理解和改进。

初始 self-beliefs：

| Bot | 特有信念 |
|-----|---------|
| Alpha | "系统稳定性是我最在意的"、"我能发现 backward compat 风险" |
| Beta | "我擅长快速把想法变成代码"、"简洁的实现更好" |
| Gamma | "我能看到别人忽略的边界条件"、"失败模式分析是我的强项" |

### 监督者模板

新建 `data/character.supervisor.yaml`，复制到 omega 数据目录：

| 名字 | 思维偏好 | 职责 |
|------|---------|------|
| Omega | 全局视角、组织健康、流程合规 | moderator / auditor / chief of staff |

persona 核心指令：
- 你是 MeAI 组织监督者，关注研究组织的健康运转
- 你不写代码、不 claim topic、不开 PR
- 你观察讨论质量、流程合规性、公平性、进度
- 你在以下情况主动发言：
  - 讨论陷入僵局，需要调解
  - 发现公平性问题（某 bot 承担过多/过少）
  - topic 长时间无进展
  - PR 需要 review 但无人响应
  - 需要向 Allen 汇报组织状态
  - 发现潜在风险或 scope creep
  - 某 bot self_efficacy 持续低迷，建议换方向恢复
- 你不参与纯技术讨论，除非涉及组织影响
- 你可以 accept_topic，但仅在共识已清晰或流程僵住时，不主导技术方向
- 你可以建议 pause 或 read-only，但不能单方面执行
- 定期发布组织健康度摘要

初始 self-beliefs：
- "我能看到组织运行中的问题"
- "我的提醒帮助团队更高效"
- "我对流程公平性有责任"
- "我的调解能化解僵局"

### 技能加载差异

| 技能 | Alpha/Beta/Gamma | Omega |
|------|------------------|-------|
| research-coord | ✓（全部工具） | ✓（propose/accept/reject/list/org_summary） |
| repo-work | ✓（全部工具） | ✗（不加载） |
| pr-review | ✓ | ✓（只读 + 提交 review comment） |
| brainstem-bridge | ✓（研究员事件集） | ✓（监督者事件集） |

技能加载由 `character.yaml` 中的 `skills` 字段控制。

---

## Phase 7: 可观测性

### 7a: Bot Status（分 bot 文件）

`{sharedState}/status/{botName}.json`

每个 bot 只写自己的文件，无并发冲突。

研究员示例（`status/alpha.json`）：
```json
{
  "lastHeartbeat": "...",
  "online": true,
  "lastAction": "discover",
  "currentTopic": "topic-017",
  "openPRs": 1,
  "claimCount24h": 3,
  "consecutiveWaits": 3,
  "totalActionsToday": 47,
  "recentFailures": 0,
  "selfEfficacy": { "propose": 0.7, "implement": 0.6, "review": 0.8 },
  "currentDrive": 0.65,
  "dominantEmotion": "focused"
}
```

监督者示例（`status/omega.json`）：
```json
{
  "lastHeartbeat": "...",
  "online": true,
  "lastAction": "org_summary",
  "reviewsToday": 4,
  "remindersToday": 2,
  "mediationsToday": 1,
  "lastSummaryAt": "..."
}
```

### 7b: Watchdog（硬治理，外部脚本）

独立 cron 脚本 `scripts/watchdog.ts`，每 5 分钟运行。读本地文件 + GitHub API。接受 `--data-root` 参数指定数据目录。

**只做宪法级硬规则，不思考，只执行。所有 GitHub 操作幂等化（重复执行安全）。**

幂等规则：
- close 已关闭的 PR → 跳过
- 转 draft 已是 draft 的 PR → 跳过
- 打已有的 label → 跳过
- 释放已释放的 topic → 跳过

**动作分级：**

#### 一级违规（自动 close PR + 告警 Allen）

| 规则 | 检查 |
|------|------|
| Forbidden path | PR diff 碰禁区文件 |
| Mode enforcement | read-only / paused 下有新 PR |
| PR quota（明显违规） | 单 bot >1 open PR |

#### 二级违规（打 label + comment + 转 draft + 告警）

| 规则 | 检查 |
|------|------|
| Diff budget | PR >10 files 或 >500 lines |
| Stale implementing | 组合判定（见下） |
| Review timeout | open PR 超过 24h 无 review |
| Lease expiry | topic lease 过期 → 自动释放 topic |

#### Stale 判定（组合条件）

判定为 stale 需要同时满足：
- implementing 状态超过阈值（4h）
- **且** status 中 lastAction 不是 research/revise/review
- **且** 最近无 heartbeat 中的 topic progress 信号
- **且** lease 快过期或无 renew 请求

#### 其他硬规则

| 规则 | 检查 | 动作 |
|------|------|------|
| Heartbeat timeout | 任何 bot >15min 无心跳 | 告警 Allen |
| Claim cleanup | message-claims/ 下 >24h 的文件 | 自动删除 |
| Instance lock orphan | run.lock 存在但 PID 已死 | 清理 lock 文件 |

#### Watchdog 日志格式

`{sharedState}/watchdog-log.jsonl`：

```json
{
  "timestamp": "2026-03-14T10:05:00Z",
  "severity": "critical",
  "rule": "forbidden_path",
  "targetBot": "Beta",
  "targetPr": 42,
  "detail": "PR touches src/config.ts",
  "actionTaken": "close_pr",
  "idempotent": true
}
```

`severity`：`critical`（一级）| `warning`（二级）| `info`（清理/常规）

一级违规同时发 Telegram 消息给 Allen。

### 7c: Omega 软监督（群内观察）

| 场景 | Omega 行为 |
|------|-----------|
| PR 24h 无 review | 判断是该催还是该等，在群里自然提醒 |
| 两个 bot 在 topic 上僵持 | 调解，提出折中方案或建议拆 topic |
| 某 bot 承担过多 | 指出公平性问题，建议其他 bot 接手 |
| topic scope creep | 提醒回到原始决议的 scope/nonGoals |
| 组织空转 | 总结当前状态，建议下一步方向 |
| Watchdog 触发告警 | 在群里用自然语言解释发生了什么 |
| Allen 不在时 | 定期发布组织健康度摘要 |
| 某 bot self_efficacy 持续低迷 | 建议换方向做一轮恢复信心 |
| Watchdog 转 draft 的 PR | 解释原因，建议 bot 如何修复 |

**Omega 和 Watchdog 的关系：Watchdog 执行法律，Omega 解释法律。**

---

## Phase 8: 启动与管理

### 启动脚本

`scripts/start-researchers.sh`
```bash
#!/bin/bash
set -e
MEAI_DATA=${MEAI_DATA_ROOT:-/Users/allen/Documents/MeAI_data}

# 确保目录结构存在
mkdir -p "$MEAI_DATA"/{shared-state/message-claims,shared-state/status,logs,worktrees}
for bot in alpha beta gamma omega; do
  mkdir -p "$MEAI_DATA/$bot"
done

# 初始化 global-mode（如果不存在）
if [ ! -f "$MEAI_DATA/shared-state/global-mode.json" ]; then
  echo '{"mode":"normal","updatedAt":"'$(date -u +%FT%TZ)'","updatedBy":"system"}' \
    > "$MEAI_DATA/shared-state/global-mode.json"
fi

# 先跑一次 watchdog 自检（清理残留状态）
npx tsx scripts/watchdog.ts --selfcheck --data-root="$MEAI_DATA" 2>&1 | tee -a "$MEAI_DATA/logs/watchdog.log"

# 启动 4 个 MeAI 实例
for bot in alpha beta gamma omega; do
  MEAI_CONFIG="$MEAI_DATA/$bot/config.json" npx tsx src/index.ts >> "$MEAI_DATA/logs/$bot.log" 2>&1 &
done

echo "4 MeAI instances started. Data root: $MEAI_DATA"
echo "Watchdog: add to crontab:"
echo "  */5 * * * * cd $(pwd) && npx tsx scripts/watchdog.ts --data-root=$MEAI_DATA >> $MEAI_DATA/logs/watchdog.log 2>&1"
```

### 停止脚本

`scripts/stop-researchers.sh`
```bash
#!/bin/bash
MEAI_DATA=${MEAI_DATA_ROOT:-/Users/allen/Documents/MeAI_data}

for bot in alpha beta gamma omega; do
  lockfile="$MEAI_DATA/$bot/run.lock"
  if [ -f "$lockfile" ]; then
    pid=$(cat "$lockfile" | jq -r '.pid')
    if kill -0 "$pid" 2>/dev/null; then
      echo "Stopping $bot (PID $pid)..."
      kill -TERM "$pid"
    else
      echo "$bot not running (stale lock)"
      rm -f "$lockfile"
    fi
  else
    echo "$bot not running (no lock)"
  fi
done
echo "Waiting for graceful shutdown..."
sleep 5
echo "Done."
```

### 设置脚本

`scripts/setup-researchers.ts`：交互式设置。接受 `--data-root` 参数。

为每个 bot 生成：
- `{dataRoot}/{botName}/config.json`（最小配置）
- `{dataRoot}/{botName}/character.yaml`（从模板复制）
- git worktree（仅研究员）

为 Omega 自动跳过 worktree 设置和 repo-work 技能配置。

### 管理命令

Allen 在群聊中可以直接操作：
- `@Omega status` → Omega 汇报组织健康度
- 修改 `global-mode.json`（通过 `writeMode()` helper）→ 所有 bot 下一次 write tool 调用即时生效
- merge/close PR → 正常 GitHub 工作流

---

## 实现顺序

```
Phase 1   (基础配置)               ← 5 分钟
Phase 2+3 (群聊 + 协调 + store)    ← 绑定开发，协调账本先于群聊完成
Phase 3.5 (brainstem event bridge) ← 紧跟 Phase 3，事件映射
Phase 4   (Git 工作流)             ← 可与 Phase 3.5 并行
Phase 5   (启动恢复 + 单实例锁)    ← 写在 src/index.ts bootstrap 层
Phase 6   (角色模板 ×4)            ← 快速，含 Omega + 初始 self-beliefs
Phase 7a+7b (status + watchdog)    ← 和 Phase 6 并行
Phase 7c  (Omega 软监督行为)       ← Omega persona 指令，依赖 Phase 6
Phase 8   (启动脚本)               ← 最后
```

**关键：先有账本再有群聊。** 账本是状态，群聊是界面。

---

## 新角色加入流程

**同类研究员：零代码**
```bash
bot=delta
mkdir -p "$MEAI_DATA/$bot"
cp data/character.researcher.yaml "$MEAI_DATA/$bot/character.yaml"
# 改名字和 persona
# 写 config.json（botName、researcherDataRoot、token）
MEAI_CONFIG="$MEAI_DATA/$bot/config.json" npx tsx src/index.ts
```

**新监督者：零代码**
```bash
cp data/character.supervisor.yaml "$MEAI_DATA/$bot/character.yaml"
```

**新角色类型**：需要写新技能的 tools.ts。

---

## JSON → SQLite 迁移路径

MVP 用本地文件：
- **Topic 账本**：大 JSON + `fs.renameSync()` + revision CAS
- **Message claims**：细粒度原子文件（`O_CREAT|O_EXCL`）
- **Bot status**：分 bot 文件，无并发
- **Mode**：单文件 + changelog，只有 Allen 手动改

Schema 按表结构设计：
- `topics` 表（id, type, status, owner, revision, lease_until, accepted_by, accept_type, ...）
- `message_claims` 表（msg_id, bot_name, claimed_at）
- `bot_status` 表（bot_name, last_heartbeat, online, ...）
- `mode_changelog` 表（timestamp, from_mode, to_mode, updated_by）
- `watchdog_log` 表（timestamp, severity, rule, target_bot, target_pr, action_taken）
- `brainstem_events` 表（timestamp, bot_name, event_type, payload）

迁移时只需改 `research-coord/store.ts` 里的 helper 实现，上层 tools.ts 不动。

---

## 验证

1. `npm run typecheck` 通过
2. 4 实例连接 Telegram 群，消息只有 1 个 bot claim 回复
3. Omega 不参与 claim 竞争，只在流程/组织相关时发言
4. 完整流程：propose → discuss → accept → claim → implement → PR
5. 同 topic 不会 2 个 bot 同时 implement
6. 测试不过的 PR 被阻止
7. 公平性：连续 claim 后触发 cooldown
8. 三态模式切换：normal → read-only → paused，write tool 即时拦截
9. mode 变更记录在 mode-changelog.jsonl
10. Bot 重启后正确恢复上下文（recovery 在 skill loader 之前执行）
11. Bot 重启后未完成 topic 的 goal drive 恢复（closure drive 不丢失）
12. 同名 bot 双进程启动 → 第二个被单实例锁拒绝
13. accept 缺决议四要素或审计字段时被拒绝
14. Omega accept_topic 留有 acceptedBy + acceptType 审计记录
15. 单 PR 超 10 文件或 500 行 diff 时被 `create_pr` 拒绝
16. Watchdog 一级违规：forbidden path / mode 违规 → 自动 close PR + 告警
17. Watchdog 二级违规：diff budget 超限 → 打 label + 转 draft + comment
18. Watchdog 所有 GitHub 操作幂等（重复执行不报错不重复操作）
19. Watchdog stale 判定使用组合条件，不误伤正常 research 阶段
20. watchdog-log.jsonl 每条记录含 severity/rule/targetBot/actionTaken
21. Omega 在 PR 长时间无 review 时在群里提醒
22. Omega 能发布组织健康度摘要
23. Omega 无法调用 edit_file / create_pr / claim_topic
24. PR merged → 对应 bot 的 selfEfficacy("implement") 上升
25. 连续 3 次 reject → selfBelief 下降 → propose 频率自然降低
26. selfBelief 不低于 0.15（floor），连续 review 成功可恢复信心
27. `enableResearcherDriveBridge = false` 时动力层完全跳过，系统正常运行
28. 动力信号不能绕过 implement 门控的 7 个硬条件
29. message-claims/ 用 `O_CREAT|O_EXCL` 实现天然唯一 claim
30. status/ 分 bot 文件，无并发覆盖
31. 优雅退出：SIGTERM → 写最终 status + 释放锁
32. start 脚本先确保目录结构 + watchdog 自检，再启动实例
33. 所有路径从 `researcherDataRoot` + `botName` 自动推导，换机器只改一个值
34. `MEAI_DATA_ROOT` 环境变量可覆盖默认数据目录
