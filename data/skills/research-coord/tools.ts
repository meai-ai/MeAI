/**
 * Research Coordination Tools — topic lifecycle management.
 *
 * These tools manage the research agenda: propose, discuss, accept,
 * claim, release, and track topics through their lifecycle.
 *
 * All state mutations go through store.ts helpers.
 * Fairness rules and gate checks are enforced here (protocol layer).
 */

import {
  readAgenda,
  writeAgendaWithRetry,
  readMode,
  readAllStatus,
  type Topic,
  type TopicType,
  type TopicStatus,
  type TopicDecision,
  type AcceptType,
  type Agenda,
  type BotStatus,
} from "../../../src/researcher/store.js";

import {
  onTopicClaimed,
  onTopicCompleted,
  onTopicAccepted,
  onTopicStale,
  onPRMerged,
  onCritiqueAdopted,
  onConsecutiveRejects,
} from "../../../src/researcher/brainstem-bridge.js";

// Track consecutive proposal rejects per bot (in-memory, resets on restart)
const rejectStreaks = new Map<string, number>();

// ── Helpers ────────────────────────────────────────────────────────

function generateTopicId(): string {
  return `topic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function getBotName(config: any): string {
  return config?.botName ?? "unknown";
}

function now(): number {
  return Date.now();
}

// ── Fairness Checks ────────────────────────────────────────────────

function checkClaimCooldown(agenda: Agenda, botName: string): string | null {
  // Same bot cannot claim 2 topics in a row without 1h cooldown
  const myTopics = agenda.topics
    .filter(t => t.owner === botName && ["claimed", "implementing", "pr_open", "under_review"].includes(t.status))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  if (myTopics.length >= 2) {
    const latest = myTopics[0];
    const hourAgo = now() - 60 * 60 * 1000;
    if (latest.lastActivityAt > hourAgo) {
      return `Cooldown: ${botName} claimed 2+ topics recently. Wait 1h.`;
    }
  }
  return null;
}

function checkOpenPRLimit(agenda: Agenda, botName: string): string | null {
  const openPRs = agenda.topics.filter(
    t => t.owner === botName && ["pr_open", "under_review", "changes_requested"].includes(t.status)
  );
  if (openPRs.length >= 1) {
    return `${botName} already has an open PR (${openPRs[0].id}). Complete or abandon it first.`;
  }
  return null;
}

// ── Tool Definitions ───────────────────────────────────────────────

export function getTools(config?: any): any[] {
  const botName = getBotName(config);

  return [
    // ── propose_topic ────────────────────────────────────────────
    {
      name: "research_propose_topic",
      description: "Propose a new research topic for discussion. Use when you identify an improvement opportunity in MeAI.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["research", "design", "implementation", "review"],
            description: "Topic type determines the expected output",
          },
          title: { type: "string", description: "Short title (under 80 chars)" },
          description: { type: "string", description: "What to investigate/implement and why" },
        },
        required: ["type", "title", "description"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const type = input.type as TopicType;
        const title = input.title as string;
        const description = input.description as string;

        const topic: Topic = {
          id: generateTopicId(),
          type,
          title,
          description,
          status: "proposed",
          proposedBy: botName,
          proposedAt: now(),
          owner: null,
          leaseUntil: null,
          decision: null,
          prUrl: null,
          critiques: [],
          failureCount: 0,
          lastActivityAt: now(),
        };

        const ok = writeAgendaWithRetry(data => {
          data.topics.push(topic);
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to write agenda (CAS conflict)" });
        return JSON.stringify({ success: true, topicId: topic.id, title, type });
      },
    },

    // ── accept_topic ─────────────────────────────────────────────
    {
      name: "research_accept_topic",
      description: "Accept a proposed topic after discussion. Requires at least 1 critique and the decision four-element structure (scope, nonGoals, successCheck, riskNote).",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
          scope: { type: "string", description: "What this topic will change" },
          nonGoals: {
            type: "array",
            items: { type: "string" },
            description: "What this topic will NOT touch",
          },
          successCheck: {
            type: "array",
            items: { type: "string" },
            description: "How to verify success",
          },
          riskNote: { type: "string", description: "Known risks" },
          acceptedReason: { type: "string", description: "Why accepting now" },
          acceptType: {
            type: "string",
            enum: ["consensus_clear", "deadlock_resolution"],
            description: "Whether consensus is clear or resolving a deadlock",
          },
        },
        required: ["topicId", "scope", "nonGoals", "successCheck", "riskNote", "acceptedReason", "acceptType"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          if (!["proposed", "discussing"].includes(topic.status)) {
            throw new Error(`Topic ${topicId} is ${topic.status}, cannot accept`);
          }
          if (topic.critiques.length < 1) {
            throw new Error("At least 1 critique required before accepting");
          }

          const decision: TopicDecision = {
            scope: input.scope as string,
            nonGoals: input.nonGoals as string[],
            successCheck: input.successCheck as string[],
            riskNote: input.riskNote as string,
            acceptedBy: botName,
            acceptedReason: input.acceptedReason as string,
            acceptType: input.acceptType as AcceptType,
          };

          topic.status = "accepted";
          topic.decision = decision;
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to accept topic" });

        // Bridge: notify brainstem of acceptance
        const { data: agendaAfter } = readAgenda();
        const acceptedTopic = agendaAfter.topics.find(t => t.id === topicId);
        if (acceptedTopic) {
          try { onTopicAccepted(topicId, acceptedTopic.proposedBy === botName); } catch { /* ok */ }
          // Reset reject streak for the proposer — their proposal was accepted
          rejectStreaks.set(acceptedTopic.proposedBy, 0);
        }

        return JSON.stringify({ success: true, topicId });
      },
    },

    // ── reject_topic ─────────────────────────────────────────────
    {
      name: "research_reject_topic",
      description: "Reject a proposed topic with a reason.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["topicId", "reason"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;
        const reason = input.reason as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          if (!["proposed", "discussing"].includes(topic.status)) {
            throw new Error(`Topic ${topicId} is ${topic.status}, cannot reject`);
          }
          topic.status = "rejected";
          topic.critiques.push({ by: botName, content: `Rejected: ${reason}`, at: now() });
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to reject topic" });

        // Track consecutive rejects for the proposer
        const { data: rejAgenda } = readAgenda();
        const rejTopic = rejAgenda.topics.find(t => t.id === topicId);
        if (rejTopic) {
          const proposer = rejTopic.proposedBy;
          const streak = (rejectStreaks.get(proposer) ?? 0) + 1;
          rejectStreaks.set(proposer, streak);
          try { onConsecutiveRejects(streak); } catch { /* ok */ }
        }

        return JSON.stringify({ success: true, topicId });
      },
    },

    // ── add_critique ─────────────────────────────────────────────
    {
      name: "research_add_critique",
      description: "Add a critique or comment to a topic under discussion. Required before a topic can be accepted.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
          content: { type: "string", description: "Your critique, concern, or support" },
        },
        required: ["topicId", "content"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;
        const content = input.content as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          topic.critiques.push({ by: botName, content, at: now() });
          if (topic.status === "proposed") topic.status = "discussing";
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to add critique" });
        return JSON.stringify({ success: true, topicId });
      },
    },

    // ── claim_topic ──────────────────────────────────────────────
    {
      name: "research_claim_topic",
      description: "Claim an accepted topic to work on. Assigns a 2-hour lease. Subject to fairness rules.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
        },
        required: ["topicId"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        // Omega cannot claim topics (supervisor role)
        if (botName.toLowerCase() === "omega") {
          return JSON.stringify({ success: false, error: "Omega (supervisor) cannot claim implementation topics" });
        }

        const topicId = input.topicId as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          if (topic.status !== "accepted") {
            throw new Error(`Topic ${topicId} is ${topic.status}, must be 'accepted' to claim`);
          }
          if (topic.owner) {
            throw new Error(`Topic ${topicId} already owned by ${topic.owner}`);
          }

          // Fairness checks
          const cooldownErr = checkClaimCooldown(data, botName);
          if (cooldownErr) throw new Error(cooldownErr);

          if (topic.type === "implementation") {
            const prErr = checkOpenPRLimit(data, botName);
            if (prErr) throw new Error(prErr);
          }

          topic.status = "claimed";
          topic.owner = botName;
          topic.leaseUntil = now() + 2 * 60 * 60 * 1000; // 2 hours
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to claim topic" });

        // Bridge: create sub-goal for closure drive
        const { data: claimedAgenda } = readAgenda();
        const claimedTopic = claimedAgenda.topics.find(t => t.id === topicId);
        if (claimedTopic) {
          try { onTopicClaimed(topicId, claimedTopic.title); } catch { /* ok */ }
        }

        return JSON.stringify({ success: true, topicId, owner: botName });
      },
    },

    // ── renew_lease ──────────────────────────────────────────────
    {
      name: "research_renew_lease",
      description: "Extend the lease on a claimed topic by another 2 hours.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
        },
        required: ["topicId"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          if (topic.owner !== botName) throw new Error(`Not owner of ${topicId}`);
          topic.leaseUntil = now() + 2 * 60 * 60 * 1000;
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to renew lease" });
        return JSON.stringify({ success: true, topicId });
      },
    },

    // ── release_topic ────────────────────────────────────────────
    {
      name: "research_release_topic",
      description: "Release a claimed topic so others can pick it up.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["topicId"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          topic.status = "accepted"; // back to accepted, available for claim
          topic.owner = null;
          topic.leaseUntil = null;
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to release topic" });
        return JSON.stringify({ success: true, topicId });
      },
    },

    // ── attach_pr ────────────────────────────────────────────────
    {
      name: "research_attach_pr",
      description: "Associate a GitHub PR URL with a topic.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
          prUrl: { type: "string" },
        },
        required: ["topicId", "prUrl"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;
        const prUrl = input.prUrl as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          if (topic.owner !== botName) throw new Error(`Not owner of ${topicId}`);
          topic.prUrl = prUrl;
          topic.status = "pr_open";
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to attach PR" });
        return JSON.stringify({ success: true, topicId, prUrl });
      },
    },

    // ── mark_merged ──────────────────────────────────────────────
    {
      name: "research_mark_merged",
      description: "Mark a topic as merged/completed.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
        },
        required: ["topicId"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;

        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (!topic) throw new Error(`Topic ${topicId} not found`);
          topic.status = "merged";
          topic.lastActivityAt = now();
          return data;
        });

        if (!ok) return JSON.stringify({ success: false, error: "Failed to mark merged" });

        // Bridge: accomplishment + goal completion
        try { onPRMerged(topicId); } catch { /* ok */ }

        return JSON.stringify({ success: true, topicId });
      },
    },

    // ── list_topics ──────────────────────────────────────────────
    {
      name: "research_list_topics",
      description: "List research topics, optionally filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status (optional). Use 'active' for all non-terminal states.",
          },
        },
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const { data } = readAgenda();
        const filterStatus = input.status as string | undefined;

        let topics = data.topics;
        if (filterStatus === "active") {
          const terminal: TopicStatus[] = ["merged", "rejected", "abandoned", "stale"];
          topics = topics.filter(t => !terminal.includes(t.status));
        } else if (filterStatus) {
          topics = topics.filter(t => t.status === filterStatus);
        }

        const summary = topics.map(t => ({
          id: t.id,
          type: t.type,
          title: t.title,
          status: t.status,
          owner: t.owner,
          proposedBy: t.proposedBy,
          critiques: t.critiques.length,
          leaseUntil: t.leaseUntil ? new Date(t.leaseUntil).toISOString() : null,
        }));

        return JSON.stringify({ success: true, count: summary.length, topics: summary });
      },
    },

    // ── org_summary ──────────────────────────────────────────────
    {
      name: "research_org_summary",
      description: "Generate an organization health summary. Shows bot statuses, topic progress, and fairness metrics.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      execute: async (): Promise<string> => {
        const { data } = readAgenda();
        const allStatus = readAllStatus();
        const mode = readMode();

        const terminal: TopicStatus[] = ["merged", "rejected", "abandoned", "stale"];
        const activeTopics = data.topics.filter(t => !terminal.includes(t.status));
        const completedTopics = data.topics.filter(t => t.status === "merged");

        // Per-bot stats
        const botStats: Record<string, {
          claimed: number;
          completed: number;
          openPRs: number;
          critiques: number;
          online: boolean;
        }> = {};

        for (const [name, status] of Object.entries(allStatus)) {
          botStats[name] = {
            claimed: data.topics.filter(t => t.owner === name && !terminal.includes(t.status)).length,
            completed: data.topics.filter(t => t.owner === name && t.status === "merged").length,
            openPRs: data.topics.filter(t => t.owner === name && ["pr_open", "under_review"].includes(t.status)).length,
            critiques: data.topics.reduce((sum, t) => sum + t.critiques.filter(c => c.by === name).length, 0),
            online: status.online,
          };
        }

        // Stale warnings
        const staleWarnings = activeTopics
          .filter(t => t.leaseUntil && t.leaseUntil < now())
          .map(t => `${t.id} (${t.title}): lease expired, owned by ${t.owner}`);

        return JSON.stringify({
          success: true,
          mode,
          activeTopics: activeTopics.length,
          completedTopics: completedTopics.length,
          totalTopics: data.topics.length,
          botStats,
          staleWarnings,
          topicsByStatus: {
            proposed: data.topics.filter(t => t.status === "proposed").length,
            discussing: data.topics.filter(t => t.status === "discussing").length,
            accepted: data.topics.filter(t => t.status === "accepted").length,
            claimed: data.topics.filter(t => t.status === "claimed").length,
            implementing: data.topics.filter(t => t.status === "implementing").length,
            pr_open: data.topics.filter(t => t.status === "pr_open").length,
          },
        }, null, 2);
      },
    },

    // ── submit_review ────────────────────────────────────────────
    {
      name: "research_submit_review",
      description: "Submit a structured PR review. All checklist fields are required — tool rejects incomplete reviews.",
      inputSchema: {
        type: "object",
        properties: {
          topicId: { type: "string" },
          prNumber: { type: "number" },
          scope_check: {
            type: "string",
            description: "Does the PR stay within the topic's scope? Reference nonGoals from the accept decision.",
          },
          credentials_check: {
            type: "string",
            description: "Does the PR touch any credential files? (must be 'clean' or explain)",
          },
          consistency_check: {
            type: "string",
            description: "Is the diff consistent with the topic decision?",
          },
          behavior_change: {
            type: "string",
            description: "Does the PR introduce implicit behavior changes?",
          },
          verdict: {
            type: "string",
            enum: ["approve", "request_changes", "comment"],
            description: "Review verdict",
          },
          comment: {
            type: "string",
            description: "Additional review commentary",
          },
        },
        required: ["topicId", "prNumber", "scope_check", "credentials_check", "consistency_check", "behavior_change", "verdict"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const topicId = input.topicId as string;
        const prNumber = input.prNumber as number;
        const verdict = input.verdict as string;

        // Validate all checklist fields are non-empty
        for (const field of ["scope_check", "credentials_check", "consistency_check", "behavior_change"]) {
          const val = input[field] as string;
          if (!val || val.trim().length < 5) {
            return JSON.stringify({
              success: false,
              error: `Review checklist incomplete: "${field}" must be a substantive assessment (at least 5 chars)`,
            });
          }
        }

        // Build review body
        const reviewBody = [
          `## Review by ${botName}`,
          `**Topic:** ${topicId}`,
          `**Verdict:** ${verdict}`,
          "",
          "### Checklist",
          `- **Scope check:** ${input.scope_check}`,
          `- **Credentials check:** ${input.credentials_check}`,
          `- **Consistency check:** ${input.consistency_check}`,
          `- **Behavior change:** ${input.behavior_change}`,
          "",
          input.comment ? `### Comments\n${input.comment}` : "",
        ].filter(Boolean).join("\n");

        // Record the review in the topic
        const ok = writeAgendaWithRetry(data => {
          const topic = data.topics.find(t => t.id === topicId);
          if (topic) {
            topic.critiques.push({ by: botName, content: `Review (${verdict}): ${input.comment || "see PR"}`, at: now() });
            if (verdict === "approve" && topic.status === "pr_open") {
              topic.status = "under_review";
            }
            topic.lastActivityAt = now();
          }
          return data;
        });

        return JSON.stringify({
          success: true,
          topicId,
          prNumber,
          verdict,
          reviewBody,
          note: "Post this review body as a PR comment via repo_read_pr_comments or GitHub",
        });
      },
    },
  ];
}
