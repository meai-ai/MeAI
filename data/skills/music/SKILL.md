# Music Composition

Compose original music using the Suno API. Can create songs with lyrics or instrumental tracks.

## When to use

- User asks you to write a song / compose / hum a tune
- You're in a mood and want to express it through music
- You want to create a song for the user
- You found an interesting topic and want to write a song about it
- You want to make background music / instrumentals
- User mentions music, melodies, or songs

## When NOT to use

- You just composed something recently (wait at least 30 minutes)
- You've composed too many today (max 5 per day)
- User is just casually chatting about music, not asking you to compose

## How to use

Call the `compose_music` tool. Pass a description, style, and lyrics (optional). The system generates a full song (~2 minutes) and sends it as an MP3 audio message.

Style can be chosen based on your current mood, or let the user specify.
