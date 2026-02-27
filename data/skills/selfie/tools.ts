/**
 * Selfie skill — exposes send_selfie tool for the agent to use.
 */

import type { AppConfig } from "../../../src/types.js";
import { generateSelfie, isVisualIdentityEnabled } from "../../../src/selfie.js";
import type { SelfieTrigger } from "../../../src/selfie.js";

export function getTools(config: AppConfig): any[] {
  // Don't register the tool if visual identity is disabled
  if (!isVisualIdentityEnabled()) return [];

  return [
    {
      name: "send_selfie",
      description:
        "Generate and send a selfie/photo based on current context (activity, outfit, mood, weather). " +
        "Use when the user asks what you're doing, wants to see you, asks about your outfit, or when you want to share a moment. " +
        "The photo is automatically sent to the chat.",
      inputSchema: {
        type: "object",
        properties: {
          trigger: {
            type: "string",
            enum: ["what_doing", "outfit", "show_me", "cat", "manual"],
            description:
              "Why the selfie is being sent: " +
              "what_doing = the user asked what you're doing, " +
              "outfit = the user asked about your outfit, " +
              "show_me = the user explicitly asked for a photo, " +
              "cat = showing the cat, " +
              "manual = spontaneous share",
          },
          context: {
            type: "string",
            description:
              "Brief description of the scene to capture in the photo. " +
              "Include what you just told the user, what you're doing right now, " +
              "and any specific element the user asked for (e.g. 'sunlight', 'cat', 'outfit'). " +
              "Example: 'Just finished editing a report, stretching at desk, afternoon sunlight through office window'",
          },
        },
        required: ["trigger"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const trigger = (input.trigger as SelfieTrigger) || "manual";
        const context = (input.context as string) || undefined;

        try {
          const result = await generateSelfie(trigger, context);
          if (!result) {
            return JSON.stringify({
              success: false,
              reason: "selfie_unavailable",
              message: "Visual identity not available or rate limited",
            });
          }

          // Return the result — the agent loop will handle sending the photo
          return JSON.stringify({
            success: true,
            type: "selfie",
            imagePath: result.imagePath,
            caption: result.caption,
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err.message,
          });
        }
      },
    },
  ];
}
