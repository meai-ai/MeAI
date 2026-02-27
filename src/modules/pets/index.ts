/**
 * Pets module — reference SimModule implementation.
 *
 * Reads pet config from character.yaml (pet field) and provides:
 * - Context blocks about what the pet is doing
 * - Heartbeat action: interact with pet
 * - Tool: log a pet moment
 *
 * This serves as a template for contributors creating new modules.
 */

import type { AppConfig, ToolDefinition } from "../../types.js";
import type { SimModule, ContextBlock, HeartbeatActionDef } from "../types.js";
import { getCharacter } from "../../character.js";

/** Track last pet interaction for cooldown. */
let lastInteractionAt = 0;

const petsModule: SimModule = {
  id: "pets",
  name: "Pet Simulation",

  init(_config: AppConfig): void {
    const char = getCharacter();
    if (char.pet) {
      console.log(`[modules:pets] Loaded pet: ${char.pet.name} (${char.pet.type})`);
    } else {
      console.log("[modules:pets] No pet configured in character.yaml");
    }
  },

  getContextBlocks(): ContextBlock[] {
    const char = getCharacter();
    if (!char.pet) return [];

    const pet = char.pet;
    const hour = new Date(
      new Date().toLocaleString("en-US", { timeZone: char.timezone }),
    ).getHours();

    // Simple time-based pet behavior
    let behavior: string;
    if (hour >= 0 && hour < 7) {
      behavior = `${pet.name} is curled up asleep`;
    } else if (hour >= 7 && hour < 9) {
      behavior = `${pet.name} is awake and looking for breakfast`;
    } else if (hour >= 9 && hour < 12) {
      behavior = `${pet.name} is lounging in a sunny spot`;
    } else if (hour >= 12 && hour < 14) {
      behavior = `${pet.name} is napping after lunch`;
    } else if (hour >= 14 && hour < 18) {
      behavior = `${pet.name} is being playful and active`;
    } else if (hour >= 18 && hour < 21) {
      behavior = `${pet.name} is following you around the apartment`;
    } else {
      behavior = `${pet.name} is settling down for the night`;
    }

    return [{
      header: `What ${pet.name} is doing`,
      body: `${behavior}${pet.description ? ` (${pet.description})` : ""}`,
      priority: -1, // low priority — appears after core context
    }];
  },

  getHeartbeatActions(): HeartbeatActionDef[] {
    const char = getCharacter();
    if (!char.pet) return [];

    return [{
      id: "pet_interact",
      description: `Play with or check on ${char.pet.name} (${char.pet.type})`,
      cooldownMinutes: 60,
      allowedDuringCategories: ["rest", "pet", "entertainment"],
    }];
  },

  async executeHeartbeatAction(actionId: string): Promise<boolean> {
    if (actionId !== "pet_interact") return false;

    const char = getCharacter();
    if (!char.pet) return false;

    // Check cooldown
    const now = Date.now();
    if (now - lastInteractionAt < 60 * 60 * 1000) return false;

    lastInteractionAt = now;
    console.log(`[modules:pets] Interacted with ${char.pet.name}`);
    return true;
  },

  getTools(_config: AppConfig): ToolDefinition[] {
    const char = getCharacter();
    if (!char.pet) return [];

    return [{
      name: "pet_moment",
      description: `Log a cute moment about ${char.pet.name} the ${char.pet.type}. Use when something noteworthy happens with the pet.`,
      inputSchema: {
        type: "object",
        properties: {
          moment: {
            type: "string",
            description: "What happened (e.g., 'knocked a cup off the table', 'fell asleep on my keyboard')",
          },
        },
        required: ["moment"],
      },
      execute: async (input) => {
        const moment = input.moment as string;
        console.log(`[modules:pets] Pet moment: ${moment}`);
        return `Noted: ${char.pet!.name} ${moment}`;
      },
    }];
  },
};

export default petsModule;
