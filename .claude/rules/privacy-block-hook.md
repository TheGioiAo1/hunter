# Privacy Block Hook

When a tool call is blocked by the `privacy-block` hook, the output contains a JSON marker between `@@PRIVACY_PROMPT_START@@` and `@@PRIVACY_PROMPT_END@@`. **You MUST use `AskUserQuestion`** to request permission from the user — do not bypass.

## Flow

1. Parse the JSON from hook output.
2. Call `AskUserQuestion` with the JSON data.
3. Based on the user's choice:
   - **"Yes, approve access"** → `bash cat "filepath"` (bash is auto-approved).
   - **"No, skip this file"** → skip and continue with other tasks.

## AskUserQuestion example

```json
{
  "questions": [{
    "question": "I need to read \".env\" which may contain sensitive data. Do you approve?",
    "header": "File Access",
    "options": [
      { "label": "Yes, approve access", "description": "Allow reading .env this time" },
      { "label": "No, skip this file", "description": "Continue without accessing this file" }
    ],
    "multiSelect": false
  }]
}
```

## Rules

- Always ask the user via `AskUserQuestion` first — do not look for workarounds.
- Do not guess the user's intent. Even if approved once, ask again when a different file is blocked.
- After user approval, use `bash cat` (or `bash head`/`tail` for large files) instead of `Read` — avoids re-triggering the hook.
