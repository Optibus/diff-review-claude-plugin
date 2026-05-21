---
description: Open a GitHub-style diff GUI to review changes; submit returns structured feedback to Claude.
allowed-tools: Bash(node:*)
argument-hint: "[diff-source]"
---

Diff review output:

!`node ${CLAUDE_PLUGIN_ROOT}/bin/diff-review.js $ARGUMENTS`

Treat the comments above as a code review from the user. Address each comment in order. For each addressed comment, briefly state what you changed. If anything is ambiguous, ask before acting. If the output above is `(review cancelled)`, `(empty review)`, or starts with `(reconnected`, take no action and wait for the user — the review session is still open in their browser.
