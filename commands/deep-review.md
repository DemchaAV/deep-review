---
description: Multi-angle parallel code review - ten finder agents at once, an adversarial verify pass, one ranked report.
argument-hint: "[target] [--effort quick|standard|deep] [--angles a,b,c]"
allowed-tools: Bash, Read, Write, Grep, Glob, Agent, Skill, ReportFindings
---

Run a deep review. Arguments: `$ARGUMENTS`

Follow the protocol in the `deep-review:deep-review` skill exactly, start to
finish. Load it now with the Skill tool if it is not already in context.

Plugin root for the commands in that protocol: `${CLAUDE_PLUGIN_ROOT}`

Reading of the arguments:

- The first bare word is the **target**: `working` (default when absent),
  `branch`, a PR number, a ref, or a `base..head` range.
- `--effort quick|standard|deep` picks how many angles run. Default `standard`.
- `--angles a,b,c` overrides the preset with an explicit angle list.

Everything else in `$ARGUMENTS` is context about what the user wants looked at;
carry it into every finder agent's prompt as a final line under the heading
`Reviewer's note:` so the angles know what the human is worried about.

This review only reads. Do not edit, stage or commit anything, and do not offer
to until the user has seen the report.
