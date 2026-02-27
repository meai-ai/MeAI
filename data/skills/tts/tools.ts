/**
 * TTS skill — exposes send_voice tool for the agent to use.
 */

import type { AppConfig } from "../../../src/types.js";
import { generateVoice, isTTSEnabled } from "../../../src/tts.js";
import type { VoiceTrigger } from "../../../src/tts.js";

export function getTools(config: AppConfig): any[] {
  if (!isTTSEnabled()) return [];

  return [
    {
      name: "send_voice",
      description:
        "Generate and send a voice message. Use for short emotional reactions, greetings, " +
        "teasing, excitement, or when too sleepy to type. Keep under 2 sentences — " +
        "like a real WeChat voice message. The voice automatically reflects current mood " +
        "(speed and expressiveness adjust to emotional state).",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "What to say in the voice message. Keep it short (1-2 sentences). " +
              "Write naturally as spoken Chinese, not written Chinese. " +
              "IMPORTANT: Must include proper punctuation (commas, periods, etc.) — " +
              "e.g. '哈哈，好好好，我闭嘴。' not '哈哈好好好我闭嘴'.",
          },
          trigger: {
            type: "string",
            enum: [
              "emotional_reaction",
              "greeting",
              "teasing",
              "excitement",
              "sleepy",
              "answer",
            ],
            description:
              "Why the voice message is being sent: " +
              "emotional_reaction = short emotional burst (哇/天哪/烦死了), " +
              "greeting = hello/goodbye (早安/晚安), " +
              "teasing = playful/flirty, " +
              "excitement = excited about a discovery, " +
              "sleepy = too tired to type, " +
              "answer = brief spoken answer",
          },
        },
        required: ["text", "trigger"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const text = input.text as string;
        const trigger = (input.trigger as VoiceTrigger) || "answer";

        if (!text || text.length === 0) {
          return JSON.stringify({
            success: false,
            reason: "empty_text",
            message: "No text provided for voice message",
          });
        }

        try {
          const result = await generateVoice(text, trigger);
          if (!result) {
            return JSON.stringify({
              success: false,
              reason: "tts_unavailable",
              message: "TTS not available or rate limited",
            });
          }

          return JSON.stringify({
            success: true,
            type: "voice",
            audioPath: result.audioPath,
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
