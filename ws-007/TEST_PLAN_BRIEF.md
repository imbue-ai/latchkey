let's think through how one might verify that these docs, when read by another entity, are actually providing help. start a new doc and let's work on it together. i'm thinking:

* split the behavior up into 2 steps: the installation (README) and the actions (CHEATSHEET)

for each:
1 think through what the entry point is of an AI agent being instructed, and what they want accomplished
2 think about what the desired outcome is
3 think about what info from the jsonl transcript might be ground truth signals for steps on the way to the outcome
4 think about what other info (os, system, or on doordash) might be ground truth signals for success
5 think about what sort of grading rubric we could give a LLM-as-judge
