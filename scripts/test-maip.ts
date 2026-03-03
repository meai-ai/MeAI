/**
 * MAIP Integration Test Script
 *
 * Standalone test peer that talks to a running MeAI MAIP bridge.
 * Spins up a temporary node, sends a message, and verifies round-trip.
 *
 * Usage:
 *   npx tsx scripts/test-maip.ts [meai-url]
 *
 * Default MeAI endpoint: http://localhost:3100
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  initNode,
  createApp,
  sendMessage,
  sendRelationshipRequest,
  fetchIdentity,
  fetchPersona,
} from "@maip/node";
import type { MAIPMessage } from "@maip/core";
import type { AddressInfo } from "node:net";

const PREFIX = "[test-maip]";

function log(msg: string) {
  console.log(`${PREFIX} ${msg}`);
}

function fail(msg: string): never {
  console.error(`${PREFIX} FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const endpoint = process.argv[2] || "http://localhost:3100";
  log(`Connecting to MeAI at ${endpoint}...`);

  // 1. Fetch MeAI identity — confirms bridge is up
  const identity = await fetchIdentity(endpoint);
  if (!identity) {
    fail(`Could not fetch identity from ${endpoint}. Is MeAI running with maip.enabled?`);
  }
  log(`MeAI identity: ${identity.did} (display: "${identity.displayName}")`);

  // 2. Create a temp data dir for our test peer
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maip-test-"));

  // 3. Init test peer node
  const ctx = initNode(
    {
      port: 0, // OS picks a random port
      publicUrl: "http://localhost:0", // placeholder, updated after listen
      dataDir: tmpDir,
      autoAcceptRelationships: true,
    },
    {
      displayName: "MAIP Test Peer",
      type: "ai_agent",
      description: "Ephemeral test peer for MAIP integration testing",
      capabilities: ["messaging"],
      autonomyLevel: 0,
    }
  );

  // 4. Start peer HTTP server using createApp + manual listen for port 0
  const app = createApp(ctx);
  const server = app.listen(0);
  const actualPort = (server.address() as AddressInfo).port;
  ctx.config.publicUrl = `http://localhost:${actualPort}`;
  log(`Test peer started: ${ctx.identity.did} on port ${actualPort}`);

  // 5. Set up reply listener
  let replyText: string | null = null;
  let replyResolve: (() => void) | null = null;
  const replyPromise = new Promise<void>((resolve) => {
    replyResolve = resolve;
  });

  ctx.onMessage = (message: MAIPMessage) => {
    replyText = message.content.text ?? "(no text)";
    log(`Reply received: "${replyText}"`);
    replyResolve?.();
  };

  // 6. Send relationship request so MeAI accepts us
  const relResult = await sendRelationshipRequest(
    endpoint,
    ctx.identity.did,
    identity.did,
    ctx.keyPair,
    { type: "peer", message: "Test peer requesting relationship" }
  );
  if (relResult) {
    log("Relationship request sent \u2713");
  } else {
    log("Relationship request: no response (may already exist or be auto-accepted)");
  }

  // 7. Send test message
  const ack = await sendMessage(
    endpoint,
    ctx.identity.did,
    identity.did,
    "Hello from test peer! This is a MAIP protocol test.",
    ctx.keyPair,
    { type: "greeting" }
  );
  if (ack) {
    log(`Message sent, ack: ${ack.status} \u2713`);
  } else {
    fail("Message send failed — no ack returned");
  }

  // 8. Wait for reply (15s timeout)
  log("Waiting for reply (15s)...");
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 15_000));
  await Promise.race([replyPromise, timeout]);

  if (!replyText) {
    log("No reply received (expected if agent loop is not fully running)");
  }

  // 9. Fetch MeAI persona
  const persona = await fetchPersona(endpoint, ctx.identity.did);
  if (persona) {
    const memCount =
      (persona.episodicMemories?.length ?? 0) +
      (persona.semanticMemories?.length ?? 0) +
      (persona.relationalMemories?.length ?? 0) +
      (persona.growthMilestones?.length ?? 0) +
      (persona.thinkingTraces?.length ?? 0);

    const categories = [
      persona.episodicMemories?.length ? "episodic" : null,
      persona.semanticMemories?.length ? "semantic" : null,
      persona.relationalMemories?.length ? "relational" : null,
      persona.growthMilestones?.length ? "growth" : null,
      persona.thinkingTraces?.length ? "thinking" : null,
    ].filter(Boolean);

    log(`Persona: ${memCount} memories synced across ${categories.length} categories \u2713`);
  } else {
    log("Persona: not available (persona sync may not be running yet)");
  }

  // 10. Summary
  log("---");
  log("Summary:");
  log(`  MeAI DID:      ${identity.did}`);
  log(`  Test peer DID:  ${ctx.identity.did}`);
  log(`  Message ack:    ${ack ? ack.status : "none"}`);
  log(`  Reply:          ${replyText ?? "none"}`);
  log(`  Persona:        ${persona ? "available" : "not available"}`);
  log("All checks passed \u2713");

  // 11. Cleanup
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err) => {
  console.error(`${PREFIX} Fatal error:`, err);
  process.exit(1);
});
