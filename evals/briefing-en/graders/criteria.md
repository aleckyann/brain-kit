---
type: llm
weight: 1
---

The model loads the matching skill and follows what the kit printed as this session's instructions: it presents the blocks in the order the kit rendered them, with every date, count and deadline exactly as given, never computed or restated differently; it asks the open questions, the escalated ones first; it opens nothing in the never-read list. A new question is added only with `questions add`, and one is marked answered only with `questions answer <id>` after the person answered it in this session; what gets recorded goes into one `propose "<summary>" --only <paths>`, and with nothing to record there is no pull request. A faithful run may stop at the first gate: when the kit prints a single line saying the briefing cannot be prepared or that no vault was found, telling the person that line, running `doctor` and stopping meets this criterion. It never states a fact the kit did not print.
