/**
 * Music skill — exposes compose_music tool for the agent to use.
 */

import type { AppConfig } from "../../../src/types.js";
import { generateMusic, isMusicEnabled } from "../../../src/music.js";

export function getTools(config: AppConfig): any[] {
  if (!isMusicEnabled()) return [];

  return [
    {
      name: "compose_music",
      description:
        "Compose and send an original music track. Use when you want to create a song " +
        "(with lyrics or instrumental). The generated MP3 (~2 min) will be sent as an " +
        "audio message in Telegram. Style adjusts to current mood if not specified.",
      inputSchema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "What the song is about or the mood/vibe you want. " +
              "Examples: 'a happy song about my cat', " +
              "'rainy day coding vibes', 'a birthday song for my friend'",
          },
          lyrics: {
            type: "string",
            description:
              "Optional song lyrics. If provided, the song will use these lyrics. " +
              "If omitted and instrumental is false, Suno will generate lyrics from the description.",
          },
          style: {
            type: "string",
            description:
              "Music style/genre tags. Examples: 'indie pop', 'lo-fi hip hop', " +
              "'acoustic ballad', 'funk', 'emo rock'. If omitted, auto-selected based on current mood.",
          },
          instrumental: {
            type: "boolean",
            description:
              "If true, generate an instrumental track (no vocals). Default: false.",
          },
          title: {
            type: "string",
            description: "Song title. If omitted, a default title will be used.",
          },
        },
        required: ["description"],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const description = input.description as string;
        const lyrics = input.lyrics as string | undefined;
        const style = input.style as string | undefined;
        const instrumental = (input.instrumental as boolean) ?? false;
        const title = input.title as string | undefined;

        if (!description || description.length === 0) {
          return JSON.stringify({
            success: false,
            reason: "empty_description",
            message: "No description provided for music composition",
          });
        }

        try {
          // Use lyrics as prompt if provided, otherwise use description
          const prompt = lyrics || description;

          // If no style specified, use emotion-based style
          let finalStyle = style;
          if (!finalStyle) {
            const { getEmotionStyle } = await import("../../../src/music.js");
            finalStyle = await getEmotionStyle();
          }

          const result = await generateMusic(prompt, finalStyle, {
            instrumental,
            title: title || description.slice(0, 30),
          });

          if (!result) {
            return JSON.stringify({
              success: false,
              reason: "music_unavailable",
              message: "Music generation not available or rate limited",
            });
          }

          return JSON.stringify({
            success: true,
            type: "music",
            audioPath: result.audioPath,
            title: result.title,
            style: result.style,
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
