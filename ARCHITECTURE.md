# Architecture

Two parts. [What runs today](#what-runs-today) is the waitlist at codetinder.dev. [The hackathon
version](#the-hackathon-version-parked) is the design of the product that won, as it ran on GitLab
Duo Agent Platform, Cloud Run and Firestore. It is parked: its code is in this repository and gated
by CI, but nothing deploys it, and it is the reference the next version is built from.

## What runs today

```
visitor ──▶ codetinder.dev ──▶ Cloudflare Worker `codetinder-web`
                                  ├─ static assets: the Astro site (apps/site)
                                  └─ POST /api/waitlist ──▶ D1 database `codetinder`
```

- **One Worker, `codetinder-web`** (`apps/worker-web`). The site is its static assets; only
  `/api/waitlist` runs the Worker first. Every other path is a file of the site or the site's 404
  page with status 404, so the hackathon version's paths (`/projects`, `/rounds/<id>`,
  `/auth/callback`, `/flow-steps/v1.js`, the rest of `/api/*`) are all closed. Nobody can sign in,
  add a project or connect anything.
- **The site** (`apps/site`) is prerendered Astro with two React islands, the waitlist form and the
  swipe demo; the form reads plain values from `@codetinder/api/waitlist-form` (the
  email pattern, the platforms, the consent wording ids, the hidden field's name) and ships no
  Effect runtime. The site shares `packages/core` and `packages/ui` with the parked app.
  `apps/worker-web/scripts/assemble-assets.ts` puts the build and its `_headers` into `dist/`.
- **The endpoint** is declared once as an Effect `HttpApi` (`packages/api`, `waitlist.ts`) and
  implemented in `apps/worker-web`. A request is `{ email, consent, platform?, website? }`:
  `platform` is `github`, `gitlab` or `both`; `consent` is the id of the wording the visitor saw.
  It answers `{"status":"joined"}` for a new address and a repeat alike, so it tells nobody who is
  already on the list.
- **Abuse handling**, in this order: a rate limit per client address (Cloudflare's Rate Limiting
  binding, 5 requests a minute, counted in each Cloudflare location on its own, and approximate: a
  burst gets well past 5 before it is refused); no query string, so an address never travels in a
  URL; `Content-Type: application/json` required, which makes a browser on another origin send a
  preflight that gets no CORS headers; a body cap of 1,024 bytes, with a well-formed
  `Content-Length` required; strict validation of the body, with an ASCII-only address; and a
  hidden form field, `website`, which a bot fills in: such a request is answered as joined and
  stored nowhere.
- **Logs.** Workers Logs keep the Worker's own error and console logs. Per-request invocation logs
  are off, because they record each request's URL and metadata, and the waitlist's promise is that
  no IP address is kept.
- **Storage** is the D1 database `codetinder`, in Cloudflare's EU jurisdiction, with one table,
  `waitlist_entry` (`apps/worker-web/migrations/0001_waitlist.sql`, whose comments say what each
  column is for). A row holds the address as typed, the address lower-cased (unique), the optional
  platform, the consent wording id and the join time. A repeat signup keeps the first join time and
  consent and takes a platform if it names one. No IP address and no user agent are stored, and no
  email is sent. The table holds personal data, so a change to it is a new migration, never an edit.
- **No runtime secrets.** The only secret is the Cloudflare deploy token, loaded at deploy time.
- **Deploy.** Every push to `main` runs every gate (`ci.yml`), then `cd.yml` runs
  `pnpm -F @codetinder/worker-web run deploy`: build the site, apply the D1 migrations, then one
  `wrangler deploy` that also sets the Worker's custom domains to `DOMAINS` in
  `apps/worker-web/scripts/deploy-worker.ts`. Migrations go first, so a migration must keep the
  Worker that is still live working.
- **Reading the list and removing a person** are commands in
  [`apps/worker-web/README.md`](apps/worker-web/README.md).

## The hackathon version (parked)

CodeTinder first ran as a GitLab Duo flow, a round API on Google Cloud Run with Firestore, and a
React app for swiping. This part describes that design as it ran. Nothing in it is deployed, and the
GitLab group it ran in is archived, so the flow can no longer be released or run by its author. The
next version replaces the Duo flow with an ordinary CI job on GitHub and GitLab and keeps the rest
of the design; what GitLab's platform does and does not allow was learned the hard way, and the
parts of the design that exist because of it say so.

### Shape

```
developer ── pushes ──▶ merge request ── trigger ──▶ Duo flow `codetinder` (on a CI runner)
    │                     ▲                            ├─ Duo agent: the LLM steps
    │                     │ notes, commits             └─ `flow-steps`: everything else
    │                     └─────────────────────────────────┤       ▲
    │                                     rounds, ID token  ▼       │  the flow-steps bundle
    └── swipes on ─────────────────────────────────────▶ the server (Cloud Run) ──▶ Firestore
                                                               │
                                                               └── GitLab API, as the developer ──▶ MR notes
```

- **The automation is one Duo flow**, `codetinder`, run by its own service account. Its triggers
  are the only entry points; there is no webhook server.
- **The LLM work is done by the flow's Duo agent**, on GitLab's model and credits. A flow sees no
  custom CI/CD variables, so it holds no API key of ours.
- **Everything deterministic is `flow-steps`**, an internal CLI the flow downloads from the server
  and runs on the runner: reading the MR, checking the agent's pick, running the tests, uploading
  the round, writing the principles doc. People never run it.
- **The server** is one Cloud Run service: the swipe app, an API keeping the record of every round
  (the picked function, its context, its cards) and every swipe (who, which verdict, when), and the
  `flow-steps` bundle. The app signs the developer in with GitLab OAuth; the API lets them read a
  round only if GitLab lets them read its project's code.
- **The rest lives in GitLab**: the trigger comments and proposals in the MR, principles in the repo.

### The loop

One merge request, start to finish. The developer's say is the swipes, and accepting the proposal
unless the project lets it push.

**1. Generate.** A round starts the ways the project chose: when an MR is opened or marked ready,
when the flow's service account is added as a reviewer, on every push; and always when a developer
asks, with a comment `@<handle> round`. A run does not know much from its event (an MR event's goal
is only the MR's IID), so the CLI reads the rest through the API. **There is one round per
commit**: before the agent, which is billed per call, the run claims the commit on the server, and
only the run that gets it goes on. A developer's ask on a commit that has its round makes a fresh
round that replaces it as the commit's. A fork's MR, and an MR that changes no code (prose, images,
lockfiles), stop at routing, before any agent call.

1. The agent reads the diff and picks one changed function worth judging. If none qualifies it
   declines with a reason. It answers to the `round` schema:
   - the function: its file and exact original text;
   - for TypeScript and JavaScript, its **context**: every definition the function depends on that
     its file declares or imports by a relative path, with the import lines of the packages it uses;
   - 4 to 8 **cards**. Each is the original function with **one change** applied on its own, never
     stacked on another card: one operation, named from Fowler's catalogue where one fits (Extract
     Function, Replace Loop with Pipeline, …). Every line the operation doesn't need stays
     byte-identical and behaviour is unchanged. A change a formatter or linter would settle is never
     a card. A card holds its **after** (the whole function with the change, plus any extracted
     helper), the operation and a sentence on what it changed, the **principle** it tests (a
     kebab-case id and one statement) with its **stance** (the after `supports` or `opposes` it),
     and its **kind**: `explore` (a principle the project has no view on), `confirm`, `challenge`,
     `consistency` (a pair testing one principle with opposite stances; liking both halves cancels
     out) or `boundary` (a change right on the line between a principle and its exception).
   - The task gives the agent the project's principles and its **questions** from the server: every
     principle a card has tested, with tallies and **age**, the number of judged rounds since a card
     on it last got a verdict. A card reuses an existing id when it tests the same idea, so swipes on
     different rounds add up. **Rounds stay fresh**: a question judged in one of the last 3 judged
     rounds rests, and at least half of a round's cards must ask something that is not resting.
2. `flow-steps round` checks the answer against its schema and the pick (the function's text appears
   exactly once in its file). In a TypeScript project it writes the context and function as one file
   and typechecks it with the project's own compiler, as written and with each card's after swapped
   in: the original passing proves the context is complete; a card failing is dropped. **An answer
   that fails a check gets one correction**, with the full error handed back to the agent; a second
   failure ends the round with a note.
3. It swaps each remaining card in for the original and runs the project's tests. A failing card is
   dropped; a round needs 3 that pass. No parser is involved, so any language whose tests the runner
   can run works; outside TypeScript and JavaScript there is no context and no typecheck. An install
   or test failure before any change blames the sandbox in the note, and when the agent config can
   fix it, [a fix is proposed](#the-sandbox-fix). The check stops itself at 28 minutes.
4. `flow-steps round` stores the verified round on the server with its commit, and posts a note on
   the MR: what was picked, how many cards ask outside the last 3 judged rounds, the round's link and
   that `@<handle> round` deals a fresh one. When the service account is a reviewer yet to review,
   the note is its review, so "re-request review" is the one click for a new round.

**2. Swipe.** The app shows the round one card at a time: the whole function with its change as an
inline diff, unchanged lines far from the change folded away. An info button says what operation the
card applies; a card never names its principle, so the developer judges the code, not a slogan. A
like means "I prefer the after", a dislike "I prefer the original". Hovering a name shows its
definition from the context. Each verdict is saved as the developer swipes, so teammates can swipe
the same round; **Undo** takes back the last. **Done** records an **ask** on the round for the
swipes as they are (the server refuses swipes a learn run has learned or is learning), then replies
to the round's note as the developer, mentioning the service account: `@<handle> learn <round id>`.
Being the developer's own comment, it fires the mention trigger. The page follows the run through
**Learning…**, **Learned ✓** and **Learn again** (no start within 5 minutes, no end within 100, or a
failure); if GitLab never starts the run, the page posts the mention again once by itself, since the
server has no token to post as the developer.

**3. Learn and propose.** The mention starts the flow again.

1. `flow-steps` fetches the round and its swipes and hands the agent the original function once and
   each swiped card as a unified diff against it, with its likes and dislikes, the current
   principles, and the round's **evidence** from the server: every verdict earlier rounds' cards got
   on each principle the round tests, and the newest card that confirmed it and that contradicted it.
   Learn sees what the developer saw, never what generate meant a card to test. It answers with
   **operations on the doc**, never the doc, and code applies them, so a principle no operation
   names stays exactly as it is:
   - `strengthen` and `weaken` move a principle one strength (`tentative`, `moderate`, `strong`); a
     `tentative` one weakened is dropped. `drop`, `merge` and `reword` do what they say; `add` files
     a new `tentative` principle.
   - `narrow` is what learn tries first when a card contradicts a principle: it names what the
     contradicting cards share that the confirming ones lack and adds an **exception**: where the
     principle doesn't hold and what to do there. Code applies it only when every cited card was
     shown and the cards against the principle hold at least 2 net swipes, so one stray swipe never
     makes an exception. An exception is its own `tentative` principle under its parent.
   - A round makes at most 4 operations, at most one per principle, and the doc holds at most 20
     principles, exceptions included. An operation that breaks a rule is skipped, never the whole
     answer, and the note names each skipped one.

   A doc edited out of CodeTinder's format is converted back by the agent, keeping every rule. The
   agent also reads the team's written rules (agent instruction files, `CONTRIBUTING.md`). They stay
   the team's, never copied into the principles; but the swipes win: a rule that a principle
   contradicts comes back as an edit, quoted exactly with its replacement, for a person to review.
2. `flow-steps render` applies the operations to the doc as checked out and writes it.
3. The agent rewrites the MR's changed code to the principles with Duo's file tools (no shell),
   changing only what the principles call for, keeping the project compiling with behaviour
   unchanged.
4. `flow-steps verify rewrite` first reverts every change the rewrite may not make: a file the MR
   doesn't change, or one that decides whether the tests pass (config, CI, manifests, lockfiles, the
   tests themselves), so a rewrite can't loosen the tests that judge it. It then runs the tests. On
   failure the agent gets the end of the output and one retry; failing again, the rewrite is dropped
   and only the principles are proposed. Tests failing after the retry run once more on the MR's
   code: if they fail there too, the note blames the sandbox.
5. `flow-steps propose` delivers the principles and the rewrite as the project's config says,
   through GitLab's commits API, naming each file it commits: `merge-request` (the default; a commit
   on a new branch `codetinder/learn-<round id>-<time>` and an MR into the MR's branch) or `push` (a
   separate commit on the MR's branch, guarded by each file's `last_commit_id`, falling back to the
   MR if someone changed a file since). It replies in the Done thread with what it learned and
   changed. The MR itself is still reviewed and merged by a human.

### Inside a run

- **Routing.** The flow's first step downloads `flow-steps` and runs `flow-steps route`, which prints
  one word; a conditional router matches it exactly (`generate`, `learn`, `sweep`), and any other
  word ends the run. The route comes from the event: a mention's last command (`learn <round id>` or
  `round`), or the trigger context (`merge_request`, `merge_request_ready`, `assign_reviewer`,
  `pipeline_hooks`). A closed MR, one from a `codetinder/` branch and a draft on a plain open event
  are skipped silently.
- **One round per commit, enforced by a claim.** `POST /api/claims` answers `Claimed` to one run;
  `Busy`, `Tried` and `HasRound` end the run silently. Duplicates are common: GitLab sometimes starts
  two sessions for one pipeline. A developer's ask carries the note id of the ask, and GitLab's note
  ids only grow, so a newer ask retakes a commit that has its round while a delayed run of an older
  ask is answered as the claim stands. A claim with no round and no ending older than the run's
  timeout (the sum of its steps' limits, 81 minutes for a round) can be taken by a new run. The
  cost of a slower live run losing its claim is a second billed run, never two rounds for one claim.
  Each claim has an owner: the run writes its id to `/tmp/codetinder/claim.json`, every later
  request names it, so a retried request after a lost answer is answered as the first was.
- **Agent steps move data through files.** Each starts from `flow-steps task <step>`, which writes
  the task and its output schema to `.codetinder/task.md`; the agent reads it with `read_file`, saves
  its answer with `create_file_with_contents`, and the next `flow-steps` step decodes it against the
  schema. Files, because Duo's file tools reach only untracked paths in the repo and `run_command`
  output is cut above about 50 KB. Each `flow-steps` step prints a last stdout line as its verdict
  (`verified`, `skipped: <reason>`, `failed: <reason>`), since the flow cannot see an exit code.
- **Project commands run in a sandbox.** The config, `.codetinder/config.json`, holds `install`,
  `test`, `proposal` and `tone`, every field filled in so no default hides in the code. `test` is the
  only gate on a rewrite; a project that wants a typecheck puts it in `test`. The commands run on the
  Node and package manager the repo's root pins. The sandbox writes only to the checkout and `/tmp`,
  so each command gets a home and git hooks path under `/tmp`; their environment leaves out the
  flow's tokens. It reaches only gitlab.com, so the setup adds the project's package registry and
  the server to `network_policy.allowed_domains`.
- **Reaching the server.** The setup declares an ID token, `CODETINDER_ID_TOKEN`, with the server's
  audience: a JWT GitLab signs for each run, naming the project, sent as the bearer token on every
  call. Calls to the server and to GitLab's API retry a transient failure up to three times.
- **Notes** are posted by `flow-steps` with the run's token, so the service account authors them,
  rendered from tested code in the project's `tone` (`mischievous` or `plain`).

### The server

One Cloud Run service, `apps/server`, serving two static builds (the marketing site, `apps/site`,
and the app, `apps/web`, a React SPA), the API and the `flow-steps` bundle. A path the marketing
build has a file for is served from it, `/assets/*` is the app's bundle, and anything else gets the
app's `index.html`, which shows its own "No page here". One origin keeps the sign-in redirect, the
browser's token and every note's `/rounds/<id>` link where they were.

- **The app's pages.** `/rounds/<id>` is a round to swipe; `/projects` the developer's matches;
  `/projects/<id>` one match: its state and next step, **When to start a round**, **Sweep**, the
  principles doc on its default branch and Remove. Each reads GitLab in the browser as the developer,
  through `packages/gitlab`, whose calls retry only what is safe to repeat.
- **How rounds start is a setting on GitLab's trigger**, with no storage of ours: the page reads the
  trigger's events and filter and writes them back whole. Opened is `merge_request` filtered to
  `action eq created` plus `merge_request_ready`; reviewer is `assign_reviewer`; push is
  `pipeline_hooks` filtered to a running push pipeline off the default branch. The mention is
  always on. Only a developer who may manage the flow can change them.
- **Two kinds of caller.** A **flow** sends its GitLab ID token, checked against GitLab's published
  keys (issuer, audience, `pipeline_source` `duo_workflow`), and acts for the token's `project_id`
  only. A **developer** signs in with GitLab OAuth (PKCE, in the browser, scope `api`: posting a note
  needs it); the API asks GitLab who they are and whether they can read the round's project's code,
  every request, cached briefly, and never stores the token.
- **Routes**, defined once with Effect's `HttpApi` in `packages/api`; the server implements them and
  `flow-steps` and the app call the client derived from them:
  - `POST /api/rounds` (flow): stores a round, only for the run holding its commit's claim (else
    409); answers a 12-character base62 id, the same id to the owner repeating the call.
  - `GET /api/rounds/<id>` and `GET …/swipes`, `…/evidence`, `…/learn` (the project's flow, or a
    developer who can read its code): the round, every developer's verdicts, what earlier rounds say
    about each principle, and where learning stands (`NotLearned`, `Learning`, `Learned`,
    `Unfinished`), judged against the deadlines by the server's clock.
  - `PUT …/swipes` and `GET …/swipes/mine` (developer): save and resume one's own verdicts.
  - `POST …/done`, `…/done/retry`, `PUT …/done/note` (developer): record an ask for the swipes as
    they are; refused with 409 when a run has learned or is learning them; ask once more by itself
    when the first never started; tie the ask to the reply's note id, once.
  - `POST …/learn` (flow): a learn run's report, `Started`, `Finished` or `Failed`, which applies
    only to the latest ask tied to that note, so a superseded run or a duplicate session can't move it.
  - `POST /api/claims` and `POST /api/claims/end` (flow): claim a commit, give the claim up.
  - `GET /api/sweeps/<project id>`, `PUT …/threshold`, `POST …/claim`, `…/finish`, `…/stop`, `…/end`:
    the project's sweep, and the owner-only writes that run it ([the sweep](#the-sweep)).
  - `GET /api/projects/<project id>/questions` (flow): the project's questions, from its latest 50
    rounds and their swipes.
  - `GET /flow-steps/v1.js`: the bundle of this deploy. `GET /rounds/<id>/qr.png` (anyone): a QR
    code of the round's URL for the MR note, unauthenticated because GitLab fetches note images
    through its proxy.
- **Storage** is Firestore (native mode) behind a `RoundStore` service. The guarantees are the design:
  - `claims/<project>_<MR IID>_<head sha>`: the run holding the commit's claim, when it was claimed,
    and when it ended without a round or the round it got. **Created only if absent**, so of runs
    racing on one commit exactly one gets it; **every later write is made only at the version it was
    read at**, so a stale or repeated one can't land on a claim that changed since.
  - `rounds/<round id>`: the project, MR IID, commit, the round, when it was stored, and its latest
    ask as JSON (its id, the swipes it covers, when asked, whether a retry, the reply's note id, how
    its run started and ended). **Storing a round and putting its id on its claim is one atomic write
    preconditioned on the claim's version.** Every write to the ask is made only at the round's
    version, so a second Done racing the first is refused rather than overwriting it.
  - `swipes/<round id>_<user id>`: the developer and their verdicts, when they last swiped.
  - `sweeps/<project id>`: the threshold, and the last sweep, the latest stop, the carry-over and the
    claim as JSON. Created only if absent, then written at the version read.

  The questions query needs a composite index on `rounds` (project, creation time descending). The
  layer speaks Firestore's REST API with `fetch`, authenticated by the service account's token from
  Cloud Run's metadata server, so the handler stays web-standard. Only the server reaches the
  database. A document is at most 1 MiB, so the API refuses a round above 900 KB, and a request body
  above 1 MiB is answered 413 before a route parses it. Outbound calls give up after 10 seconds.
- **Region `us-east1`**, where GitLab.com and its hosted runners run, since every request comes from a
  runner or calls GitLab. Node and Cloud Run appear only in the entry point, Firestore only in the
  `RoundStore` layer.

### The sweep

A round reaches one MR's code; the sweep brings the rest of the default branch back in line with the
principles. It runs on a `pipeline_hooks` run for a successful pipeline on the default branch, from
a second trigger the app sets up, and **Sweep now** starts one by hand.

- **Is one due?** `route` claims the sweep, then counts the lines of code added since the last
  sweep's commit (`git diff --numstat`; the first sweep walks back along first parents until the
  count reaches the threshold, at least 100 lines). Under the threshold, or with an open sweep MR,
  it gives up the claim and ends.
- **What breaks the principles.** The agent answers every function that breaks a principle in the
  changed files and the carry-over, worst first, with the principles' ids and why. `sweep pick` keeps
  those that exist, once each, rewrites the first 20 and carries the rest over (at most 200). An
  answer it rejects gets one correction, as a round's does.
- **The rewrite** is learn's: the agent rewrites exactly the kept functions, and `verify sweep`
  reverts everything outside their files and runs the tests, with one retry.
- **The proposal.** `sweep propose` asks for the claim again (a check that outlasted the claim's 101
  minutes publishes nothing), commits the changed files on `codetinder/sweep-<date>-<time>` and
  opens an MR into the default branch listing each function and the principle it now follows. A
  stopped sweep (`Answer`, `Tests`, `Sandbox`, `GitLab`, `Error`) leaves the last sweep's commit
  alone, so the next counts from where the last finished one did and no code goes unswept.

### The sandbox fix

When a round or learn run fails before any change and the agent config can fix it, `flow-steps`
proposes the fix as an MR into the default branch, never committing to it: a blocked host goes into
`network_policy.allowed_domains`, and a missing system library is installed with `microdnf` in
`setup_script` (each library mapped to its package by a table checked against UBI 9's metadata),
merged into the team's `.gitlab/duo/agent-config.yml` without touching its keys or comments. One fix
MR is open at a time, new fixes are committed onto it, and a fix the team closed is never proposed
again.

### The principles doc

The product. A markdown file in the developer's repo, always `.codetinder/principles.md`, versioned
and reviewed like code:

- Each principle is a heading with a stable id, unique across the doc, a strength (`tentative`,
  `moderate`, `strong`) and one statement on one line. A principle may hold one **exception**, a
  `#### Exception · <id> · <strength>` heading under it.
- **At most 20 principles**, exceptions included, so an agent reads the whole doc.
- **Sections by language, always**: `## General`, then `## <language>` sections in the order of the
  fixed list in `packages/core/src/languages.ts`. A step reads only the sections that apply.

  ```markdown
  <!-- codetinder principles · format 3 · edit freely, keep the ids -->
  # Coding principles

  ## General

  ### early-returns · strong
  Return early on a failed check instead of nesting the happy path in `if` blocks.

  #### Exception · inline-single-use-values · tentative
  A value used once that is a single call or property access stays inline where it is used.
  ```

- **The evidence stays on the server**: which swipes taught each principle is in the record, not the
  doc, which holds only what was learned.
- **People edit it like code.** Learn starts from the doc as it is in the repo, so a reworded, added
  or deleted principle is kept unless new swipes contradict it. Every learn run writes the doc back
  exactly as core renders it; a doc that parses but isn't normalised, or one from an older format,
  is rewritten in a proposal that says so.
- **Agents find it through a pointer** setup adds to the repo's agent instruction files: the
  principles take precedence over the repo's other style guides.

### Installing in a project

**Add a project** in the app, as the developer, through GitLab's API:

1. **Enable the flow.** Enables the public `codetinder` flow from the AI Catalog, pinned to its
   latest version, which creates its service account and trigger.
2. **Open the setup MR**, "Add CodeTinder 💘" from `codetinder/setup`, which adds to
   `.gitlab/duo/agent-config.yml` the network hosts, the ID token and a `setup_script` installing
   `libatomic` (Node 25 and later link it and the default image lacks it), merged into the team's own
   file; `.codetinder/config.json` with the install and test commands guessed from the lockfile; an
   empty principles doc; and the pointer section in each agent instruction file.

Merging that MR is the whole install; a half-done add shows **Finish setup**. The project needs the
Duo Agent Platform with triggers (Premium or Ultimate), and its runs use its own namespace's GitLab
Credits. **Remove** deletes the flow's consumer (which removes its trigger and service account),
closes an open setup MR and opens "Remove CodeTinder 💔" deleting only `.codetinder/config.json`.

### Versions and upgrades

One version number covers the flow shell, `flow-steps`, the API, the round format and the doc format,
released together by CI.

- **The flow is a thin, stable shell**: its YAML holds the steps and generic agent instructions only.
  Each LLM step's task and output schema live in `packages/core`, and `flow-steps` decodes the
  agent's answer against the same schema before acting on it.
- **Within a major, upgrades are automatic.** The flow's first step downloads
  `flow-steps/v<major>.js` from the server, which carries the bundle in its own image, so each
  deploy ships the steps and the API they call together. The bundle is one file with no
  dependencies, built to run on the flow's default image's Node 20, which CI checks.
- **A new major is a new shell**: a project stays on the catalog version it enabled until a
  Maintainer moves it with **Update**. Releases come only from CI, never by hand, since every run
  executes the latest release on the project's runner.

### Packages

```
packages/core        the domain: functions, context, cards and their diff, rounds, swipes,
                     principles, the doc format, each LLM step's task and output schema. Pure
                     TypeScript, no I/O, and never touches GitLab.
packages/api         the API contract (`HttpApi`): the waitlist, and the round API's routes,
                     payloads, errors and security.
packages/gitlab      the GitLab adapter: ID-token checks, who a developer is, reading an MR,
                     posting notes, committing a proposal, OAuth, the setup MR, the triggers.
packages/flow-steps  the flow's CLI: route, task, round, render, verify, propose, sweep.
packages/flows       the Duo flow `codetinder.yml` and its release script.
packages/ui          the design both front ends share: Tailwind theme, `cn`, the brand marks,
                     the round's card and deck.
packages/learn-bench replays judged rounds through learn, to score how well its doc
                     predicts the next swipes.
apps/site            the marketing site (Astro). Live.
apps/worker-web      the Cloudflare Worker serving the site and the waitlist. Live.
apps/web             the swiping app (React SPA).
apps/server          the round API and static hosting on Cloud Run.
```
