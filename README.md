# claude-lookout

See what your local Claude Code sessions are doing from any device: read-only, end-to-end encrypted, and with no Claude login on the viewer.

Open one link on your phone and you know at a glance whether each session is working, waiting for a permission, asking you a question, or finished and waiting for your next prompt.

## Why not Remote Control?

Claude Code's [Remote Control](https://code.claude.com/docs/en/remote-control) lets you drive a local session from claude.ai/code or the Claude app. It is built for continuing the work, and that comes with requirements that don't suit a quick look:

|                              | Remote Control                                                            | claude-lookout                                        |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Viewer signs in              | With the same Claude account and organization                             | Never, the view link is the credential                |
| Plans                        | Pro, Max, Team or Enterprise; API keys and LLM gateways are not supported | Any way you run Claude Code                           |
| Where the conversation goes  | Stored on Anthropic's servers while connected                             | Stays on your machine; only encrypted state leaves it |
| Who else can see the session | Anyone using that Claude account                                          | Only people holding your view link                    |
| Can drive the session        | Yes                                                                       | No, it is view-only                                   |

If you share a Claude account, or you just want to know when Claude needs you without handing the session to a web client, claude-lookout is the lighter tool.

## What you see

Every open Claude Code session shows one of these states, with how long it has been in it:

| State            | Meaning                                             |
| ---------------- | --------------------------------------------------- |
| Ready            | Open, nothing asked yet                             |
| Working          | Claude is running                                   |
| Needs permission | Claude is waiting for you to allow a tool           |
| Asking you       | Claude asked a question and waits for your answer   |
| Plan to approve  | Claude finished a plan and waits for your approval  |
| Finished         | The run ended and Claude waits for your next prompt |
| Interrupted      | The run was stopped before it finished              |
| Closed           | The session ended (kept on screen for 30 minutes)   |

Alongside the state, each session carries fields grouped into levels. You choose the highest level that leaves your machine; the default is 2.

| Level       | Fields                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Context | Project, folder, git branch, model, permission mode, effort, how the session started, what Claude is doing now, running subagents, task progress, errors |
| 2 · Content | Your last prompt, the permission being requested, Claude's questions and options, the plan to approve, Claude's last message                             |

Content fields pass through a secret filter first: API keys, tokens, passwords, private keys and credentials in URLs are masked as `••••`.

## Setup

Run this once on each machine that runs Claude Code (Node.js 22.18 or newer):

```sh
npx claude-lookout setup
```

Setup shows the exact change it will make to `~/.claude/settings.json`, backs the file up, and adds claude-lookout's hooks. That is the whole installation: nothing runs in the background and nothing starts at login. The next time Claude Code starts a session, its hooks wake claude-lookout, and it goes back to sleep a few minutes after your last session closes.

Setup finishes by printing your **view link** and a QR code. Open the link (or scan the code) on your phone once; the dashboard remembers it from then on. Add it to your home screen to use it like an app. To show the link again for another device:

```sh
npx claude-lookout link
```

Check what is happening on the machine from its own terminal at any time:

```sh
npx claude-lookout status
```

## Privacy

- **The view link is the credential.** Its secret sits after the `#` in the URL, which browsers never send to a server. Anyone holding the link can see your sessions; nobody else can.
- **Everything is end-to-end encrypted.** Each snapshot is sealed with AES-256-GCM using a key derived from the view secret before it leaves your machine. The server that passes it on stores only ciphertext, the space's random id, and hashes of the access tokens.
- **Viewers can't write.** Machines publish with a separate secret that never appears in the view link, so a viewer can't fake a session.
- **You choose how much leaves.** Set `"level"` in `~/.claude-lookout/config.json` to `1` to share context only (no prompts, questions or messages).
- **Secrets are masked first.** See [What you see](#what-you-see).

## Hosting

By default the dashboard is served by claude-lookout itself, on `http://localhost:4777`, while Claude Code runs. That works as-is on the same computer. To open it from your phone, make that address reachable:

- **Tailscale** (private to your devices): run `tailscale serve --bg 4777`, then `npx claude-lookout setup --url https://<your-machine>.<your-tailnet>.ts.net`. Tailscale provides HTTPS, which phones need to install the dashboard as an app.
- **Your local network**: `npx claude-lookout setup --host 0.0.0.0 --url http://<your-machine>.local:4777`. Only use this on networks you trust.

When Claude Code isn't running, claude-lookout isn't either, so this dashboard is offline too.

## Uninstall

```sh
npx claude-lookout uninstall
```

This removes claude-lookout's hooks from Claude Code's settings (again showing the change and keeping a backup). Delete `~/.claude-lookout` to remove its config and view link as well.

## Disclaimer

claude-lookout is an independent open-source project. It is not affiliated with, endorsed by or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
