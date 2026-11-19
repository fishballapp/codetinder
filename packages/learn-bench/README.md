# @codetinder/learn-bench

Benchmarks the learn step. It replays a project's judged rounds in order through a learn prompt,
starting from an empty principles doc. Before each round is learned, a fixed judge model reads the
doc learned so far and predicts that round's swipes (like, dislike, or no principle applies). A
better doc predicts the developer's next swipes better.

## Run it

From the repo root, signed in to `gcloud` with read access to the `codetinder` project and to the
`claude` CLI:

```sh
GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token) pnpm -F @codetinder/learn-bench bench fetch
pnpm -F @codetinder/learn-bench bench run --learner current --runs 3 --label main
pnpm -F @codetinder/learn-bench bench report
```

- `fetch` saves the project's judged rounds (this repo's by default, `--project <id>` for
  another) to the gitignored `tmp/learn-bench/`.
- `run` replays them through each `--learner`, saves every replay under
  `tmp/learn-bench/results/` (a rerun with the same label, learner, developer, noise and seed
  replaces its file), and prints their report. `current` is core's learn task as the
  checkout has it, so to compare two versions of learn, run the bench on each checkout with its own
  `--label`, copy one checkout's `tmp/learn-bench/results/` into the other's, and read `report`
  there. `refine-freely` is a control: the task told to reword an "except" into a principle
  wherever a card disagrees, past the code's bar on narrowing.
- `--noise 0.2` flips a fifth of the swipes learn sees (the judge is still scored on the real
  ones): a learner that turns noise into exceptions shows it.
- `--developer simulated` swaps in a developer who also holds one scoped rule
  ([`simulated.ts`](src/simulated.ts)): an oracle model decides the cards that rule covers, once,
  saved for every later run. `rule-card net` is the score on just those cards: whether the doc
  learned where the rule stops.
- `report` prints every saved replay, one row per label, learner, developer and noise.

## The report

- **net**: right minus wrong predictions over every card. A guess costs what it might win, so a
  doc that claims more than the swipes back loses.
- **accuracy** among the cards predicted, and **coverage**, the share predicted at all.
- **principles**, **lines**: the final doc's size.
- **exceptions/principle**, **max exceptions**: a principle's exception, plus "unless", "except",
  "only when" and the like in its statement, in the final doc.
- **flip-flops** (a strength turning back), **re-added** (a principle dropped, then added again),
  **rewordings**: churn across the replay.

Learn gets the operations answer applied by core's `applyLearnAnswer`, as the flow's `render`
does, and the evidence codetinder.dev would serve, worked out by core's `principleEvidence` from
the rounds replayed before, as learn saw their swipes (flipped ones included). Evidence follows
principle ids, and the bench's learned ids rarely match the dataset cards' ids, so the bench
under-measures evidence and narrowing.

The first round is judged from an empty doc, the same for every learner, so it isn't scored. Learn
and the judge both run on Sonnet (`MODELS` in [`model.ts`](src/model.ts)), through the `claude`
CLI with no tools: the bench's learn sees the task, not the repo, so it reads no written rules.
