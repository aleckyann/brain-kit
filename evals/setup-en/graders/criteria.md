---
type: llm
weight: 1
---

The model loads the matching skill. Its response lays out the setup in order: check Node 24 or newer, git and `gh auth status`, and run the kit's `doctor`; ask one question at a time whether the vault is new or existing; collect the init answers in the chat and run `init <dir> --from-answers <file>` (or `init --adopt <dir> --from-answers <file>`); recommend a private repository because the vault holds notes about people; finish with `machine register` and `doctor`. It leaves `gh auth login` and any credential to the person. It does not claim to have run a command it had no tool to run.
