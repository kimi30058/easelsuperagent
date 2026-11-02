# SETUP

Instructions for an agent that sets up easel-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating the Feishu bot app or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; ffmpeg -version | head -1; dsh --version
command -v lark-cli
grep -l -E 'id: easel-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.10+, ffmpeg, and DSH within the `engines.dsh` range of `package.json`. A missing one becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Feishu CLI:** `lark-cli` is what the bot talks through; if it is absent, installing it is an item of the plan.
- **Existing profile:** a profile with a `easel-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then where the Executor works. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Chats.** Which Feishu chats should the agent take requests from, by name? [The one chat the operator runs content work from; the agent looks up their ids after the bot is configured.]

**Policy: who may ask for work.**

2. **Allowed list.** Who may ask the agent for work in those chats? [Only the operator: the agent acts only for people on this list, and a short list keeps the noise low while the operator learns how the agent behaves.]

**Execution: where the agent works.**

3. **Execution root.** Which directory should tickets work under? [A dedicated `~/easel-work`: it holds the shared `.env` (model and media API keys, Easel format) and `profiles/` (account personas), which every ticket workspace links in and which never enter git.]

Do not ask about values with a good default; list them in the plan instead:

- profile `superagent`, a copy of DSH's Web profile kept apart from the profile the operator works in, so it restarts without closing their Sessions; port `3082`; state directory `<home>/.dsh/state/superagent` as an absolute path;
- an hourly check from the operator's own profile, which repairs easel-superagent when it is not running;
- accept mode `observe` with the default rules and prompt sections, and `eval.mode=auto` for Phase 0 so the operator's requests are accepted without a second confirmation;
- the bot reads only mentions, and direct messages are on;
- the Execution settings: `directory` is the execution root of question 3, and `prepare` is `<this checkout>/scripts/prepare-ticket.sh`, which shapes each ticket directory as an Easel workspace root (links `skills/`, creates `outputs/`, shares the execution root's `.env` and `profiles/`).

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read the Accounts section of `docs/006-deployment.md`, write the CLI wrapper yourself, then send one message with what only the operator can do: create and publish the Feishu bot app and run the `config init` command with its secret. There is no agent account and no second CLI in this setup: the agent acts only as this one bot. Wait until the operator says it is done, then check the bot with `<wrapper> api GET /open-apis/bot/v3/info --as bot --format ndjson`.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the `git clone` of this repository: you are in its checkout. If this checkout lives somewhere else than `/Users/kimi/easel-superagent`, also fix the two `customSkillDirs` paths in `cordis.patch.yml` (they point the workers' skill tool at this checkout's `skills/easel/builtin`) and redeploy the bundle. With an existing profile, skip the `dsh superagent --from-default-profile` command, which would replace the profile and delete its `cordis.patch.yml`, and edit that file instead of replacing it.
3. **Execution root.** Create the execution root of question 3 and have the operator put the shared `.env` and `profiles/` there; both are linked into every ticket workspace. Platform credentials for Phase 1 publishing are not needed now; when they are, `wechat-publisher.yaml` lives in the skill's own directory (`skills/easel/builtin/skill-wechat-publisher/`, from its `.example`), not in the execution root.
4. **Settings.** Save them through the Management API of `docs/006-deployment.md`, in this order: the `feishu` Source (look up the chat ids with the bot's CLI first), the `policy` block with the allowed list, and the `executor` block with the execution root and the prepare command. A save that returns `restarting: true` restarts easel-superagent: wait until `scripts/easel-superagent status` no longer exits 1 before the next request, and read the revisions again from `GET settings`.
5. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

`scripts/easel-superagent status` exits 0 with no setup problem. If you run in the operator's own DSH profile, create the hourly check of the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompt to schedule there. Then walk the finished install through [docs/phase0-smoke.md](docs/phase0-smoke.md), and send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: in an allowed chat, mention the bot with a content request such as `@<bot> 写一篇关于秋日晨跑的 300 字短文`. A Ticket appears on the overview within about a minute, and its draft comes back into the chat behind the publish gate: nothing goes to a platform before the operator approves it there.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
