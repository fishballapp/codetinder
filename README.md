# CodeTinder

**Review a sample of your agent's code, not every line.** [codetinder.dev](https://codetinder.dev)

Agents write thousands of lines of code easily; reviewing them is the bottleneck, and has been
since AI arrived. CodeTinder closes that gap by sampling. On each merge request it picks one
function and shows you a handful of cards, each that function with one small change; you swipe
like or dislike. Your swipes become a versioned **coding-principles doc** in the repo that agents
read, and an agent rewrites the MR in that style as a commit you review. You judge a sample
instead of reading every line, and each round adds to the evidence that the agent writes code the
way you would.

CodeTinder won **Best Supervised Agent** and **Most Creative** at the
[GitLab Transcend hackathon](https://gitlab-transcend.devpost.com/), "Life After Code", where it
ran on the GitLab Duo Agent Platform.

## Not open yet

The hackathon version runs on GitLab Duo Agent Platform, which needs a paid GitLab subscription with
Duo. It ran inside the hackathon's own group, which is now archived, and we can't run or support that
version ourselves. So CodeTinder is closed for now. What is live is a **waitlist** at
[codetinder.dev](https://codetinder.dev): leave an email address, and say whether you keep your
code on GitHub, GitLab or both, to hear when it comes back. We store the address, your platform
choice, the wording you agreed to and when you joined, nothing else, and we send no confirmation
email.

The next version runs as an ordinary CI job on **GitHub and GitLab**, on any plan, built from the
code in this repository. Coming soon.

## How it works

On each merge request:

1. **Pick.** An agent picks one changed function worth judging and writes 4 to 8 cards: the
   function with one change each (extract a function, swap a loop for a pipeline, a guard clause
   for a nested `if`), each testing one principle. Every card must pass the project's own test
   command (and, in TypeScript, its typecheck) before it is shown; a card that fails is dropped.
2. **Invite.** A note on the MR links the round.
3. **Swipe** each card, shown as a diff: like or dislike. Teammates swipe the same round.
4. **Learn.** **Done** replies on the MR, which starts the learn run: it infers the preferences
   behind the swipes and updates the principles doc, adding, strengthening, weakening or dropping
   principles.
5. **Rewrite.** An agent rewrites the MR's changed code to the principles. The rewrite must pass
   the project's test command too, then lands as a commit on the MR's branch or as a proposal MR.

**The sweep** brings the rest of the default branch in line. With sweeping on, a successful
default-branch pipeline starts one once enough lines of code have landed since the last, and it
opens an MR rewriting the functions that break the principles.

Tests are the gate, not a proof: a card or rewrite is only as safe as the project's test command
is thorough. Taste is function-level only, no architecture or folder structure yet.

## The hackathon submission

The hackathon version ran on a GitLab Duo flow: deterministic steps ran our `flow-steps` CLI, and the
flow's agents did the LLM work on GitLab's model. A small server kept each round and its swipes, and
a React app showed the cards. One full loop, and the pipeline history behind it, is in the
[submission project on GitLab](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/1855115/codetinder),
which stays public as it was submitted. [`.codetinder/principles.md`](.codetinder/principles.md) is
the principles doc its own rounds learned.

## What is in this repository

| Path | What | State |
| --- | --- | --- |
| [`apps/site`](apps/site/) | the marketing site and the waitlist form | live |
| [`apps/worker-web`](apps/worker-web/) | the Cloudflare Worker that serves the site and `POST /api/waitlist` | live |
| [`packages/api`](packages/api/) | the API definitions: the waitlist (live) and the round API (parked) | live and parked |
| [`packages/core`](packages/core/), [`packages/ui`](packages/ui/) | the domain and the design world; the site uses both | live and parked |
| [`apps/web`](apps/web/), [`apps/server`](apps/server/) | the swiping app and the round API | parked |
| [`packages/gitlab`](packages/gitlab/), [`packages/flow-steps`](packages/flow-steps/), [`packages/flows`](packages/flows/) | the GitLab adapter, the flow's CLI and the Duo flow | parked |
| [`packages/learn-bench`](packages/learn-bench/) | scores how well a learned principles doc predicts the next swipes | parked |

**Parked** code is kept, built and tested by CI, but not deployed. It is the starting point of the
next version. [ARCHITECTURE.md](ARCHITECTURE.md) describes what runs today and, in full, how the
hackathon version was designed.

## Run it

Needs Node 26 and pnpm.

```sh
pnpm install
pnpm -F @codetinder/site build            # the site, which the Worker serves
pnpm -F @codetinder/worker-web dev        # the site and the waitlist on :8791, with a local D1
pnpm check && pnpm typecheck && pnpm test
```

`CODETINDER_WORKER_PORT` changes the Worker's port. Try the endpoint:

```sh
curl -s -X POST localhost:8791/api/waitlist -H 'content-type: application/json' \
  -d '{"email":"you@example.com","consent":"v1"}'    # {"status":"joined"}
```

The site alone, with hot reload: `pnpm -F @codetinder/site dev` (port 5174).

This repository is cut from a private monorepo, and every commit on `main` is deployed to
codetinder.dev by [`cd.yml`](.github/workflows/cd.yml). Issues are welcome. Please open one before
a pull request, since a change has to be applied upstream.

## License

[MIT](LICENSE)
