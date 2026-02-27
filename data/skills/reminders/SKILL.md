# reminders

Set, list, and cancel timed reminders. Fires a Telegram message when due.

## When to use

- User says "remind me to X at Y" or "in 30 minutes remind me..."
- Any request involving a future notification or follow-up
- Recurring check-ins ("remind me every Monday")

## Notes

- Reminders persist to disk and survive restarts
- Past-due reminders fire on next interaction
- Supports natural time parsing — convert user's natural language to ISO datetime before calling the tool
