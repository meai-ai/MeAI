# Creating a SimModule

SimModules add new life simulation dimensions to MeAI — pets, finance, fitness, cooking, plants, commute, dating, etc. — without editing any core files.

## Quick Start

1. Create `src/modules/<your-module>/index.ts`
2. Export a default `SimModule` instance
3. Restart MeAI — your module is auto-discovered

## Directory Structure

```
src/modules/
├── types.ts          # SimModule interface (don't edit)
├── registry.ts       # Auto-discovery registry (don't edit)
└── your-module/
    └── index.ts      # Your module — exports default SimModule
```

## Minimal Example

```typescript
import type { AppConfig } from "../../types.js";
import type { SimModule, ContextBlock } from "../types.js";

const myModule: SimModule = {
  id: "fitness",
  name: "Fitness Tracker",

  init(config: AppConfig): void {
    console.log("[modules:fitness] Initialized");
  },

  getContextBlocks(): ContextBlock[] {
    return [{
      header: "Today's workout",
      body: "Morning yoga session completed. Feeling limber.",
      priority: 0,
    }];
  },
};

export default myModule;
```

## SimModule Interface

```typescript
interface SimModule {
  readonly id: string;          // Unique ID: "pets", "finance"
  readonly name: string;        // Display name: "Pet Simulation"
  readonly dependencies?: string[]; // Init after these modules

  init(config: AppConfig): void | Promise<void>;
  teardown?(): void | Promise<void>;

  getContextBlocks?(): ContextBlock[];         // Inject into system prompt
  getHeartbeatActions?(): HeartbeatActionDef[]; // Autonomous behaviors
  executeHeartbeatAction?(id: string): Promise<boolean>;
  getTools?(config: AppConfig): ToolDefinition[]; // Agent tools
  characterConfigKey?: string;                    // Reads character.yaml modules.<key>
}
```

### Context Blocks

Returned by `getContextBlocks()`. Injected into the system prompt every turn.

```typescript
interface ContextBlock {
  header: string;     // Section heading
  body: string;       // Body text (markdown)
  priority?: number;  // Higher = earlier in prompt. Default: 0
}
```

### Heartbeat Actions

Returned by `getHeartbeatActions()`. The heartbeat LLM can choose your action during its 5-minute pulse.

```typescript
interface HeartbeatActionDef {
  id: string;                         // "feed_pet"
  description: string;                // Shown to heartbeat LLM
  cooldownMinutes: number;            // Min time between executions
  allowedDuringCategories?: string[]; // Schedule categories where allowed
}
```

### Tools

Returned by `getTools(config)`. Available to the agent during conversation.

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<string>;
}
```

## Character Config

If your module needs per-character configuration, set `characterConfigKey`:

```typescript
const module: SimModule = {
  id: "finance",
  characterConfigKey: "finance",
  // ...
};
```

Then in `character.yaml`:

```yaml
modules:
  finance:
    portfolio:
      - AAPL
      - GOOGL
    risk_tolerance: moderate
```

Access it in your module:

```typescript
import { getCharacter } from "../../character.js";

const config = getCharacter().modules.finance as FinanceConfig;
```

## Reference Implementation

See `src/modules/pets/index.ts` for a complete working example (~100 lines) with context blocks, heartbeat actions, and tools.

## How It Works

1. On startup, `moduleRegistry.discover()` scans `src/modules/*/index.ts`
2. Modules are topologically sorted by `dependencies`
3. `moduleRegistry.initAll(config)` calls `init()` on each module
4. Each agent turn: context blocks injected into system prompt, tools registered
5. Each heartbeat: module actions available alongside core actions (explore, post, etc.)
