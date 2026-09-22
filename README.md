# Karnak

**Adaptive reasoning effort for Claude Code. Jev picks how hard Claude thinks before every step of a turn.**

Karnak is a Claude Code plugin for Fable. Before each model request inside a turn, it shows [Jev](https://typesafe.ai) the task and the recent history, asks how much reasoning the *next* step needs, and sets the request's effort to match. Routine steps (read a file, list a folder, run a predictable command) go out at low. Steps that recover from a failure or make a design call go out at high or xhigh. Your session's effort setting is the ceiling.

The name: Karnak is the Inhuman who sees the fault line in anything and strikes with the least force that works. The router follows the same rule. It picks the lowest rung that still produces the right action.

> [!NOTE]
> Claude Code's function hook API is early access and changes between releases. Karnak was built and tested against Claude Code 2.1.x. If a release breaks it, run `/plugin-types` and open an issue with the error.

## Get started

You need Claude Code with function hooks enabled, a [TypeSafe](https://typesafe.ai) API key for Jev, and `git`.

### 1. Install

Inside Claude Code, add the repo as a plugin marketplace and install from it:

```
/plugin marketplace add kjmagnan1s/karnak
/plugin install karnak@karnak
```

The same two commands work from your shell with `claude plugin marketplace add kjmagnan1s/karnak` and `claude plugin install karnak@karnak`. Claude Code checks the marketplace for updates, and `/plugin` manages enable, disable, and uninstall.

Other ways to load it:

- **From a clone.** `git clone https://github.com/kjmagnan1s/karnak ~/.claude/skills/karnak`. Claude Code auto-loads plugins from that folder.
- **For one session.** `claude --plugin-dir /path/to/karnak`.

To store the key in the plugin's own config at install time, pass it as a config value: `claude plugin install karnak@karnak --config apiKey=<your-key>`. Otherwise the next step finds it for you.

### 2. Run the first-run check

Start Claude Code and run:

```
/karnak init
```

It looks for your key in the plugin config, then `TYPESAFE_API_KEY` in the environment, then your settings' `env` block, then the macOS Keychain. If it finds none, it says how to add one. To store the key in the plugin's own config instead:

```
/karnak init <your-key>
```

Then it makes one small Jev call and reports the latency and the token count. After that it asks three questions, each a picker: how high Jev may take a step (the session effort, or a fixed cap), the minimum effort for the first step of a turn, and whether to show the chosen effort under the prompt. Your answers are saved to the plugin's config. Run `/karnak init` again at any time to change them. Example:

```
karnak: Key: found in macOS Keychain.
Jev: answered in 355 ms, 613 input tokens. Probe step "list the files" → low (rung 0.0).
Saved: ceiling session, first step medium, status line on.
Mode: auto. Ceiling: the session effort (high, capped at xhigh). Floor: low. First step of a turn: at least medium.
Ready. The status line under the prompt shows each step's effort. /karnak shows the tally; run /karnak init again or use /config to change settings.
```

### 3. Work

Give Claude Code a task. The status line under the prompt reads, for example, `Fable/Jev: effort low (ceiling xhigh)` and changes as each step is routed. Nothing else about the session changes: tools, permissions, and the transcript are Claude Code's own.

## Everyday use

| Command | What it does |
| --- | --- |
| `/karnak` | The session tally: steps routed, levels chosen, how many ran below the session effort, cache hit rate, Jev cost |
| `/karnak off` / `/karnak auto` | Pause or resume routing. Persists across sessions |
| `/karnak reset` | Clear the tally |
| `/effort jev` | Same as `/karnak auto` |
| `/effort xhigh` (or any level) | Sets the session effort as usual. With routing on, that level is the ceiling |
| `/config` | Ceiling, floor, first-step minimum, history size, timeout, confidence floor, subagent routing, status line, logging |

## How it works

```text
Task + recent history + tool results
              │
              ▼
   Jev scores the next step on a
   four-rung ladder and answers
   "is the agent recovering from
   a failure?"
              │
              ▼
   Karnak applies the rules and
   rewrites `effort` on the request
              │
              ▼
   Claude generates → tools run
              │
         repeat each step
```

A step is one model request. The hook runs after tool results enter the conversation and before the next request goes out, so the decision reflects what just happened.

### The ladder

Jev places the next step on one of four rungs. Each maps to an effort level:

| Rung | Effort | What it looks like |
| --- | --- | --- |
| Routine | low | Read a file, list a folder, run a command with a predictable outcome, report a result already established |
| Light | medium | A small local change or a simple follow-up where the approach is settled and nothing has gone wrong |
| Substantial | high | Design, debugging, tracing behaviour across files, weighing several options |
| Hard | xhigh | Stuck, failed repeatedly, recovering from a wrong path, or facing an ambiguous or architecture-level decision |

### The rules on top

- **Fable only, by default.** Karnak routes on Fable and leaves every other model at the session effort. To include another family, set `models` in `/config` to `fable,opus`, or `*` for all. Sessions on an unlisted model show `idle` in the tally, and `/karnak init` says so.
- **Karnak lifts the level after a failure.** Jev also answers a yes/no question: do the latest tool results show a failure that forces a change of course? Above 0.6, Karnak sets the step to at least high. The Ares paper found this the clearest single signal. Steps that recover from a wrong path need the most thinking.
- **The first step of a turn has a minimum.** It reads the new prompt and plans, so it never drops below medium by default.
- **Karnak keeps your setting when Jev is unsure.** If Jev's confidence is under the floor (0.45 by default), the step runs at whatever you set.
- **Karnak uses your session effort as the ceiling and never picks max.** When the session is at max, Karnak routes under xhigh. Set a fixed ceiling in `/config` to change that.
- **Failures are silent.** If Jev times out (2 seconds by default) or errors, the step goes out at the session effort and the tally counts a failure. Karnak never blocks a request.

### What Jev sees

| Context | Limit |
| --- | --- |
| The original request and the latest one, when they differ | 600 and 1,200 characters |
| Recent transcript messages | Last 12 by default |
| Each message's text | 500 characters |
| Each tool call | Tool name and inputs as one line, its status, and the first 200 characters of an error |

This is Jev's view only. Claude keeps its full conversation. About 700 input tokens go to Jev per step, which at Jev's pricing is a few thousandths of a cent, and in the headless tests described below a call took 130 to 400 ms.

### Why this keeps the prompt cache

Claude's effort is set per request, outside the prompt. Karnak rewrites only that field and leaves the system prompt, messages, and tools untouched, so the cache prefix is the same request to request. In a headless test under `--effort xhigh`, a logging proxy showed `output_config.effort: "low"` on routine steps with the cache hit rate unchanged.

### Subagents

Off by default. The hook can read the main transcript but not a subagent's, so a subagent step would be routed on the parent's history. Turn it on in `/config` if you want it anyway.

## What is not measured

The tally shows the level distribution, the cache hit rate, and what Jev cost. Savings are not in it. A live session has no counterfactual, so there is no way to know what the same work costs at a fixed effort. Run a week with Karnak on and a week with it off before you quote a number.

## If something fails

- **The status line never appears.** Routing is off, or the session has no effort setting to use as a ceiling. Run `/karnak` to see the mode, and `/karnak init` to check the key.
- **"no TypeSafe key found" toast.** Run `/karnak init`. It lists where it looked.
- **Every step reads "kept"** with `log` on in `/config`. Jev is failing or timing out, and `/karnak init` shows you why by making one call and printing the error.
- **The configure screen in `/plugin` won't change a value.** In some Claude Code builds the arrow keys move between the tabs instead. Set values from the shell instead, and rerun the install command with the options you want, for example `claude plugin install karnak@karnak --config ceiling=high --config log=true`. Every option has a default, so nothing has to be set for routing to work.
- **The plugin does not load after a Claude Code update.** Run `/plugin-types` to regenerate `types/claude-code.d.ts`, then `claude plugin validate .` to see what changed.

## Development

```sh
claude plugin validate .      # what the engine sees: hooks, engine calls, env reads
claude plugin test .          # unit tests against the engine's own test kit
```

Type checking needs the declarations for your Claude Code build, which are generated rather than committed. Run `/plugin-types types` inside a session in this folder. Then run `npx -p typescript tsc -p tsconfig.json`.

The decision logic (`resolveConfig`, `buildState`, `decide`, `formatTally`) is exported and tested without a network. `askJev` takes a fetch function, so a test can hand it a canned response.

## Credits

- The per-step idea is from [Ares: Adaptive Reasoning Effort Selection](https://arxiv.org/abs/2603.07915), which fine-tuned a small model to pick effort before each agent step. Karnak uses Jev instead, so the router needs no training and answers in under half a second.
- [Astra-Ares](https://github.com/miuuyy/Astra-Ares) by vechen did the same for GPT-6 Astra in Codex CLI. Reading it is what led to this build.
- Jev is [TypeSafe](https://typesafe.ai)'s System One decision model. It returns typed answers with probabilities, which is what makes a rule-based router cheap to write on top of it.

MIT license.
