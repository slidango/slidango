<div align="center">

<img src="docs/assets/logo-light.png#gh-light-mode-only" alt="slidango" width="220">
<img src="docs/assets/logo-dark.png#gh-dark-mode-only" alt="slidango" width="220">

# Slides, made *together.*

**Your team writes one Markdown file, live. AI writes along in it.**

[![License: MIT](https://img.shields.io/badge/license-MIT-c93a22?style=flat-square)](LICENSE)
[![Built on Slidev](https://img.shields.io/badge/built_on-Slidev-16181d?style=flat-square)](https://sli.dev)
[![MCP ready](https://img.shields.io/badge/MCP-ready-237570?style=flat-square)](#bring-your-own-agent)
[![Self-hosted](https://img.shields.io/badge/self--hosted-docker_compose-5b606b?style=flat-square)](docs/self-hosting.md)

[**Website**](https://slidango.github.io) · [**Self-host**](docs/self-hosting.md) · [**Connect an agent**](#bring-your-own-agent) · [**Develop**](docs/development.md)

<br>

<img src="docs/assets/editor-light.png#gh-light-mode-only" alt="The Slidango editor: Markdown on the left with Melanie's and Harry's cursors, the rendered slide on the right, and an AI suggestion waiting for review." width="100%">
<img src="docs/assets/editor-dark.png#gh-dark-mode-only" alt="The Slidango editor: Markdown on the left with Melanie's and Harry's cursors, the rendered slide on the right, and an AI suggestion waiting for review." width="100%">

</div>

<br>

## Collaboration, code *or AI?*

Most slide tools make you choose. Collaborative slide apps let a team work together, but the deck is a black box. Slidev gives you code, but only one person types. AI tools write a deck for you, and then it is theirs.

**Slidango does all three.** Your team writes one Markdown file, live. Slidev renders every keystroke next to it. And because it is plain text, AI writes along in the same file: the built-in Slidango AI, or your own agent via MCP. Every change it makes is a diff you can check.

## Get started in one command

```bash
git clone git@github.com:slidango/slidango.git && cd slidango
docker compose -f docker-compose.local.yml up --build
```

Open <http://slides.localhost:3000>, create a deck, open it in a second window, and type in both.

Ready for your team? Set up sign-in, a domain and HTTPS in the **[self-hosting guide](docs/self-hosting.md)**.

<br>

## How it works

### Markdown on the left. *Slides on the right.*

Everyone types in the same `slides.md`, at the same time. Slidev renders it as you type. Diff it, review it, keep it in Git: every deck is a Git repository, and *Save version* commits it.

```markdown
---
layout: default
---

# Where we are

- Migration finished in October       ← gabriel
- Three of five teams onboarded       ← melanie
- Support tickets down by a third     ← harry

<!-- Lead with the migration win. -->    ← AI
```

<table>
<tr>
<td width="33%" valign="top">

#### Write in Markdown

Plain text in, Slidev slides out. Layouts, speaker notes, code blocks, everything Slidev can do. Your company template keeps every deck on brand.

</td>
<td width="33%" valign="top">

#### Edit together, live

Four cursors, one `slides.md`. No locked files, no copies by email. Yjs keeps everyone in step; the slide list shows who is where.

</td>
<td width="33%" valign="top">

#### An AI that takes turns

It proposes, you decide. Every change is a visible diff you apply, discard or undo. It runs on the model you choose, OpenAI-compatible or local.

</td>
</tr>
</table>

### From a briefing to a first draft

Start a deck with *Slidango AI*, describe the talk and drop in your notes, PDFs and images. It suggests an outline you can edit, then writes the deck slide by slide while everyone watches. After that it is one voice among several: ask it to tighten a slide, and the suggestion lands next to your team's edits.

### Share what you want

*Everyone can edit*, *Everyone can view* or *Members only*, with owners, editors and viewers per deck. Sign in through your SSO, or with accounts your admins invite by link.

<br>

## Bring your own agent

Plain text is the one format an AI can really read and write. So Slidango speaks [MCP](https://modelcontextprotocol.io): **Claude Code, Claude Desktop, Cursor or your own scripts** work in the same deck as your team, under your name and your permissions.

```bash
claude mcp add --transport http slidango https://slides.example.com/mcp \
  --header "Authorization: Bearer sld_…"
```

> *“Read the Q4 deck and tighten slide 3 to three bullets.”*

The change shows up in the editor as a suggestion, marked with the client's name, and someone on the team applies it. Create the token in **Account → API tokens**; the dialog hands you this snippet ready to paste. Tools, scopes and limits are in the [self-hosting guide](docs/self-hosting.md#api-tokens-and-mcp).

<br>

## Your server. *Your decks.*

|   |   |
| --- | --- |
| **One compose file** | Caddy, the app and Postgres, plus oauth2-proxy for SSO. HTTPS included. |
| **Plain files** | Decks are `slides.md` files with their own Git history, on your disk. |
| **Your model** | Any OpenAI-compatible endpoint, or none at all. |
| **Your template** | Upload a Slidev theme once; every deck follows it. |
| **Backups** | One script for the database and the deck files, one to restore. |

Images for every green build are published to `ghcr.io/slidango/slidango`. Start with the **[self-hosting guide](docs/self-hosting.md)**.

<br>

## Why Slidango

> I built Slidango because I wanted slides that live in Markdown and that several people can write at once, without a SaaS in between. And because only code speaks AI.
>
> — Gabriel Lipnik, [gabriellipnik.at](https://gabriellipnik.at)

Slidango is a private open-source project. Questions, ideas and bug reports are welcome in the [issues](https://github.com/slidango/slidango/issues). If you want to contribute, the **[development guide](docs/development.md)** gets you running in a few minutes.

## License

[MIT](LICENSE). Built on [Slidev](https://sli.dev), not affiliated with the Slidev project.
