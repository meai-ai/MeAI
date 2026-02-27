# phone-call

Make AI-powered outbound phone calls to book appointments, make reservations, and handle routine calls. Uses Bland.ai.

## When to use

- "Book me a tennis court at Amy Yee for Saturday 10am"
- "Call the restaurant and make a reservation for 4 at 7pm"
- "Call this number and ask about their hours"
- Any task that involves calling a business

## IMPORTANT: Always confirm before calling

Before making any call, ALWAYS tell the user:
1. Who you're about to call (phone number + name)
2. What you'll say / what you're booking
3. Wait for explicit confirmation ("yes", "go ahead", "call them")

Never make a call without user confirmation.

## Setup required

Store the Bland.ai API key in memory:
- `bland.api_key` — API key from app.bland.ai

To get an API key:
1. Sign up at app.bland.ai (free tier: 100 calls/day)
2. Copy the API key from the dashboard
3. Store it: memory_set("bland.api_key", "sk-...")

## Saved venues

Store frequently called numbers as contacts using the contacts skill.

## Call flow

1. User requests a booking → confirm details with user
2. Make the call with phone_call_make → get call_id
3. Wait ~2-3 minutes for the call to complete
4. Check result with phone_call_status → get transcript
5. Report outcome to user
6. If booking confirmed → create a calendar event

## Notes

- Calls cost ~$0.09/min (a 3-min booking call ≈ $0.27)
- Max call duration default: 5 minutes
- AI handles the full conversation including follow-up questions
- Returns full transcript for review
- Recording available for playback
