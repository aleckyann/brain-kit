# Ask the vault

Today is {{today}}. Vault: {{vault}}.

The person asked a question this vault may answer. Answer from the vault, not from memory, and read only as much of it as the answer needs.

1. Start at the vault's `index.md`. It links every area.
2. Follow links to the notes the question needs, and only those. Never load the whole vault.
3. For each note you rely on, weigh three things: whether it carries `verified` (the owner confirmed it), whether its `stale_after` date has passed, and what its `sources` say the fact came from. When a note is unverified or stale, say so in the answer.
4. When the answer needs more than three notes, hand the reading to the `vault-reader` subagent, with the question, and answer from what it returns.
5. Answer with the paths you relied on. When the answer is not in hand, say which of these three states applies:
   - **not verified**: the answer depends on a source you could not read;
   - **not found**: you looked where it should be and found nothing;
   - **don't know**: the vault does not hold it.
6. Never invent. A guess dressed up as an answer is worse than any of the three states.
