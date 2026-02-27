# email-summary

Connect to Gmail via IMAP and summarize unread emails. Helps triage your inbox from Telegram.

## When to use

- "Any important emails?"
- "Check my inbox"
- "Summarize unread emails"
- "Do I have email from X?"

## Setup required

Store Gmail credentials in memory:
- `email.imap_user` — Gmail address
- `email.imap_app_password` — Google App Password (NOT the regular password)

To generate an App Password:
1. Go to myaccount.google.com → Security → 2-Step Verification → App passwords
2. Create one for "Mail" / "Other (MeAI)"
3. Store it with memory_set

## Notes

- Reads only — never sends, deletes, or modifies emails
- Returns subject, from, date for unread messages
- Can filter by sender or search term
- Summarize important emails and let the user decide what needs attention
