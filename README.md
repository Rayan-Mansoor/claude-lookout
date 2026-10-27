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

## Disclaimer

claude-lookout is an independent open-source project. It is not affiliated with, endorsed by or supported by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
