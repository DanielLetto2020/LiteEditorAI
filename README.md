<div align="center">

# ▍ LiteEditorAI

### Your agents write the code. This is where you watch them.

A terminal-first desktop workspace for developers who **supervise AI coding agents**
(Claude Code, Codex, Gemini CLI, Qwen…) instead of typing every line themselves.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/DanielLetto2020/LiteEditorAI?include_prereleases&sort=semver)](https://github.com/DanielLetto2020/LiteEditorAI/releases)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-blue.svg)](#install)
[![Built with Electron](https://img.shields.io/badge/Electron-42-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

**English** · [Русский](README.ru.md) · [简体中文](README.zh.md) · [lite-editor-ai.ru](https://lite-editor-ai.ru)

</div>

![LiteEditorAI](assets/screenshots/hero.png)

*Three agents running in three projects. The tab renamed itself after the task the agent is on; the amber dots
mark the two agents waiting for an answer, and the badge in the title bar counts them.*

> [!NOTE]
> **Interface language: English, Russian or 简体中文** — switch it in *Settings → Interface language*, applied
> live without a restart. Languages are **pluggable files** (`locales/<code>.json`), so adding your own is one
> file and no build — see [Languages](#languages).

## Why

Your editor was built around a person typing code. That person now spends most of the day
**reading, steering and reviewing an agent** instead. The shape no longer fits:

- The center of the work is not a file — it's a **conversation in a terminal**.
- A full IDE is overkill for that. A bare terminal is blind: which agent finished? which one is stuck
  waiting for your answer? what did it just change in your files?
- Run agents in three projects at once and you lose track by lunchtime.

LiteEditorAI puts the terminal first and keeps everything else exactly one keystroke away.
Open a folder and you're working — no project wizard, no language servers to configure.

## What makes it different

### 1. Every agent, at a glance

![Switching projects with live agents](assets/screenshots/demo.gif)

Each project keeps its own **live shell tabs** — an agent in one, a dev server in another, a throwaway
command in a third. A tab **names itself after the terminal title**, which for an agent means "the task it is
working on right now".

A traffic light shows the state without switching anywhere: **working** (spinner) · **waiting for your
answer** (amber) · **done** (green). The project card aggregates all its tabs, and the title bar carries a
counter — *how many agents are blocked on you*. Notifications included.

The clip above also shows the command palette (`Ctrl+K`) and the module catalog.
[Full-size video](assets/screenshots/demo.mp4).

### 2. Supervise from your phone

The **Android remote** mirrors the live terminal of your PC session to a tablet or phone through a relay —
in **full colour**, so the agent's diffs stay green and red. It brings its own on-screen keyboard,
**pastes from the phone's clipboard straight into the PC terminal**, switches projects, shows project tasks
and browses or downloads files from the PC.

It streams the current screen and only what changed (mosh-style) instead of the whole scrollback, so
reconnecting is near-instant and it stays comfortable on mobile data. Walk away from the desk, keep answering
the agent from the couch, come back to the same session.

### 3. See what the agent touched

![Code and git in one window](assets/screenshots/workspace.png)

The **Project** window keeps the code viewer and git side by side, PhpStorm-style: a file tree that refreshes
itself while the agent edits, syntax highlighting for every language, minimap, autocomplete, **blame**
annotations, **side-by-side diff vs HEAD**, project-wide replace, an **agent-review mode** (authorship layer
over the code, "ask the agent" from the context menu) and — the safety net — **local file history with
rollback** for everything the agent changed before you committed.

Git lives in the same window: selective staging by checkbox, amend, commit / push / pull / fetch, stash,
per-file history, cherry-pick / revert, three-pane conflict resolution, branch management.

### 4. Compose the agent's context as a graph

The **Context** module builds `CLAUDE.md` / `AGENTS.md` **as a node graph** (n8n-style): text blocks, profile
groups you toggle on and off, token counters, restore points. Claude and Codex are configured independently.
It can chop an existing `CLAUDE.md` into blocks for you, and mine rules out of your past Claude Code
conversations.

## Install

Prebuilt binaries live on the [**Releases**](https://github.com/DanielLetto2020/LiteEditorAI/releases) page.

| OS | How |
|---|---|
| **Ubuntu / Debian** (x64) | `sudo apt install ./LiteEditorAI_*.deb` |
| **Windows** (x64) | Download `LiteEditorAI_*-win.zip`, unpack anywhere, run `LiteEditorAI.exe`. No installer. Unsigned, so SmartScreen may warn: *More info → Run anyway*. |
| **macOS** (arm64 / x64) | Download the matching `.dmg` (`-arm64` for M1–M4, `-x64` for Intel) and drag the app to Applications. Ad-hoc build without an Apple signature, so on first launch: *System Settings → Privacy & Security → Open anyway* (or `xattr -dr com.apple.quarantine /Applications/LiteEditorAI.app`). |
| **From source** | `npm install && npm start` (Node.js 22+) |

## And 20+ tool modules, so you don't leave the workspace

![Module catalog](assets/screenshots/modules.png)

A **module** is a separate window next to the editor. Open several at once — each remembers its size and
position, and the set reopens on next launch. Project-bound modules follow the active project.

<details>
<summary><b>Full list of built-in modules</b> (click to expand)</summary>

| Module | What it does |
|---|---|
| 👁 **Project** (viewer + Git) | Code and git in one window — see [above](#3-see-what-the-agent-touched). Plus Markdown / image / HTML preview, project-wide replace (`Ctrl+Shift+R`, regex and `$1` groups), history search, favourite branches, git status inside the file tree. |
| 🧠 **Context** | `CLAUDE.md` / `AGENTS.md` as a graph — see [above](#4-compose-the-agents-context-as-a-graph). |
| ✅ **Tasks** | TODO with statuses and priority, list **and kanban** (drag to change status), search, subtask checklists with progress, Markdown preview, project/global tabs, send a task straight into the terminal, JSON export/import. Plus a **Calendar** tab with due dates, **native reminders** and a month view — and a built-in **MCP server** (`lite-tasks`) so the agent in your terminal can read and set reminders itself. |
| 🔍 **Audit** | Quick X-ray of a project: file types, largest files by lines/size with anomaly flags, media by weight, hygiene (junk in git, duplicates, minified, orphans), tech debt (TODO/FIXME and possible secrets — click jumps to the line), history (hot files by git churn, stale ones). Source: git-tracked or the whole directory; summary to clipboard, report export. |
| 🤖 **AI company** | A team of agents on one project: a **director** agent decomposes the goal, "hires" specialists (coder, reviewer, tester…) and keeps a shared task board with progress; live log, role library, dry-run **plan mode**, budget cap, goal queue, run history with cost. |
| 🌐 **Web/SEO audit** | Standalone site analyzer (local dev server **or** a public domain): security headers with a score, TLS certificate, exposed `.git`/`.env`, SEO meta from the **rendered** page (headless Chromium), Core Web Vitals and page weight, screenshots, tech stack, broken links, robots/sitemap, DNS · SPF/DMARC · WHOIS · geo. Own site list and audit history with deltas. |
| 🐳 **Containers** | Docker **and** Podman in one panel: containers grouped by compose project (a collapsed group shows each container's state as a dot in its coloured header), pods, images, volumes, disk usage; start / stop / restart / remove one at a time or a whole group; live status refresh, **live logs**, **exec terminal**, container file browser (files open in the viewer). Recognizes **databases, RabbitMQ, Kafka, MinIO and web services** — **one click** opens them in the matching module with the connection pre-filled; containers with a web UI get an "open in browser" button. Works against a **remote host** too: docker/podman over an SSH tunnel to the socket, with a "fix over SSH" button when permissions are missing. |
| 🗄 **Databases** | Postgres / MySQL · MariaDB / SQLite client: direct or **over an SSH tunnel**, connection tabs (several databases at once), schema tree, paginated table data with cell-level selection, **SQL console** (`Ctrl+Enter`), CSV / JSON / SQL export, read-only mode. Passwords in the system keychain, drivers bundled. |
| 🐰 **RabbitMQ** | Broker client over the management API: server profiles with a **PRODUCTION** guard, tabs for several brokers, overview with **live charts** (queued messages, publish / deliver rates), queues with depth sparklines and a "no consumers" badge, **peek messages without consuming**, publish with a routing check, **live tail of an exchange** (keeps working in a background tab); purge / delete behind a confirmation. |
| 📨 **Kafka** | Cluster client on kafkajs: profiles with a PRODUCTION guard (SASL / TLS), tabs for several clusters, live throughput and **total consumer-group lag** charts, topics with **ISR health** (create / delete / DeleteRecords / partitions / retention / configs), **peek without traces** (ephemeral group), produce with key and headers, **consumer groups with lag and trend**, offset reset, **live tail**. |
| 🔌 **Remote hosts** | **SSH / SFTP / FTP** profiles by category, one-click login and several live sessions as tabs (password or a key from the system, keepalive), SFTP/FTP file browsing and **editing a remote file in the viewer** — every save uploads it back. **"Services"** scans the host's ports and opens Postgres / MySQL / RabbitMQ / Kafka in their modules **through an SSH tunnel**, even when the service only listens on the server's localhost; web ports go to the site monitor, a docker/podman socket to Containers. Passwords never leave the backend. |
| ☁️ **Object storage** | S3 browser with **presets for 11 providers** (AWS, MinIO, Cloudflare R2, Yandex, Backblaze B2, DO Spaces, Wasabi, GCS, Selectel, VK, Timeweb): project and global connections, bucket and folder tree, object table with sorting, filtering and multi-select (batch download / delete), **preview a file straight from the bucket**, "open in the editor's viewer", drag-and-drop upload, downloads of files **and whole folders** with progress and cancel (multipart for big ones), folders / rename / copy / move / delete. **Privacy under control**: anonymous mode for other people's public buckets, per-object public/private toggle and **pre-signed links** with a chosen lifetime. Keys in the system keychain; read-only mode enforced in the backend. |
| 🔑 **Password vault** | A KeePass `.kdbx` database unlocked by master password: search, copy a password / token / any field, **clipboard auto-clear after 20 s**. Connection forms in Databases / RabbitMQ / Kafka / Remote hosts / Object storage get **"from vault" / "to vault"** buttons. Decryption is entirely local — the master password never leaves the machine. |
| 📡 **Site monitor** | Any number of checks per URL: availability, a **JSON field** by path, text on the page, a number against a threshold, "it changed" — or a **custom check an agent writes for that URL from your plain-language description** (it sees the live response, is refined in dialogue, runs sandboxed). Four colour statuses with notifications, history blocks or **month charts** (uptime %, average latency, days with alerts). Checks keep running **with the window closed**. |
| 📋 **IterFlow** | The [IterFlow](https://iter-flow.ru) tracker inside the editor: create and edit iterations and tasks, deadlines, kanban status changes, iteration stage transitions (submit / approve / accept), project notes. Handy for freelancers and studios who agree scope with a client. |
| ✍️ **Text processing** | An Obsidian-style AI document editor: sidebar with the project's document tree, tabs, **rich-text ⇄ Markdown** modes, **KaTeX formulas**, formatting bar. Select a fragment and ask for a rewrite — handled by a **local agent with no API keys** (Claude Code / Codex / Gemini), streamed live; agent roles come from the project's `Roles/*.md`, autosave included. |
| 💬 **OpenRouter chat** | Bring your own key: any model with its price and context size, **streamed** answers with Markdown and code highlighting, several sessions per key, images, key balance. Keys stay local. |
| 🍅 **Pomodoro** | A work/rest timer for a workspace where agents keep working on their own: during a break a translucent overlay covers the terminals — input is blocked, **agents keep running**, output stays visible. Classic 25/5, 52/17, ultradian 90/20 or your own technique, habit stats with a day streak, mini-timer in the title bar. The countdown lives in the background. |
| 📈 **Resource monitor** | How much RAM and CPU the editor eats — per process (windows, GPU, core) **and per agent in the terminals** (PTY process trees), memory sparkline, summary snapshot to clipboard. |
| 🖳 **System terminal** | Standalone shells outside projects (home directory), several tabs, for one-off system commands next to your working terminal. |
| 🔧 **Dev tools** | An offline swiss knife: **Base64 ↔ image** (drop a file in, get a data-URI with preview and dimensions, and back), **JSON viewer**, Base64 / URL / Hex / HTML entities, **JSON ↔ YAML**, query ↔ JSON, CSV ↔ JSON, JSONPath, hashes (MD5 / SHA-1/256/512), **JWT decoder**, Unix **timestamp** and **cron** (explained, with next runs), **line rejoin** (text mangled by terminal wrapping stitched back into paragraphs, keeping lists, tables and code), case / translit, string ops, regex tester, text diff, Lorem and fake-data generator, colour converter. |

</details>

**🧩 Write your own.** *Modules → Create module…* scaffolds a plugin and **opens a terminal inside its folder**,
where **your own AI agent** writes the code against the bundled spec (`GUIDE.md` and prompts are dropped next
to it). The result appears under "My modules" and can be hot-reloaded. A simple example (a calculator) ships
with the app; the spec for authors is in [`module-kit/`](module-kit/).

## Languages

The interface ships in **English, Russian and Simplified Chinese**; pick one in *Settings → Interface language*
and it applies immediately — no restart, no reopening of module windows.

Every language is a plain JSON file where the key is the original string:

```
locales/en.json              # bundled with the app
~/.LiteEditorAI/locales/     # your own files; they override the bundled ones
```

To add a language, copy `locales/en.json`, translate the values, drop it in as `<code>.json` and pick it in the
settings — no rebuild required. The same folder also lets you fix a wording you dislike in an existing language:
put just that one key in your own file. `node scripts/i18n-extract.js` refreshes the source dictionary and
reports how complete each locale is; strings a locale is missing fall back to English rather than Russian.

## Themes

Six themes — Neumorphism (default), Glass, Material, Catppuccin, Gruvbox, Aurora. The terminal is recoloured
along with the interface.

![Themes](assets/screenshots/themes.png)

## Android remote

1. Grab `liteeditor-pult-*.apk` from [Releases](https://github.com/DanielLetto2020/LiteEditorAI/releases) and
   install it on Android (allow unknown sources).
2. On the PC: menu **"Пульт"** → register an account (login / password).
3. Sign in with the same account on the device.
4. Menu → **"Connect this device"** → approve it on the PC (match the code). Done.

Next to the version number in the editor there's a badge with the number of connected devices; a click opens
the list, where each device can be queried for its info and location, or **cut off** (without deleting — access
comes back with one button).

Knowing the password alone grants nothing: the device must be **approved on the PC**. Brute-force protection,
revocable sessions and a "sign out on all devices" button are built in.

> The relay **can see the traffic** (it is not end-to-end encrypted) — keep that in mind for private code.
> The remote is **alpha**.

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl+Shift+T` / `Ctrl+Shift+W` | new / close terminal tab |
| `Ctrl+PageUp` / `Ctrl+PageDown` | switch terminal tabs |
| `Ctrl+Enter` | newline in the terminal (continue input, don't run) |
| `Ctrl+C` / `Ctrl+V` | copy selection / paste (any keyboard layout) |
| `Ctrl+\` | single-terminal mode |
| `Ctrl+K` | command palette |
| `Ctrl+F` / `Ctrl+Shift+F` | search in the terminal or file / across all open terminals |
| `Ctrl+S` | save file |
| `Ctrl+Shift+R` | project-wide replace (Project window) |
| `Ctrl+1..9` / `Ctrl+Tab` | switch projects |
| `Ctrl + +/−` · `F11` | font size · fullscreen |

## Status

**Alpha**, actively developed. A project can keep as many terminal tabs as you need and their **names** survive
a restart (the processes do not). The viewer opens one file at a time and skips files over 2 MB. It is a viewer
with editing, not a replacement for your IDE's refactoring engine — that's on purpose.

Bugs and ideas → [Issues](https://github.com/DanielLetto2020/LiteEditorAI/issues).

## Build from source

```bash
npm install        # dependencies + node-pty rebuilt for Electron
npm start          # bundle the frontend and launch
```

Node.js 22+ (Linux / Windows x64; macOS builds are made on macOS only).
More for developers: [CONTRIBUTING.md](CONTRIBUTING.md).

### Pull requests

You don't need write access — contribution goes through a fork. Fork the repo, branch off **`contrib`** and
open the PR **into `contrib`** (not `main`). Accepted changes are ported into development and ship in one of
the next releases; review is manual, at the maintainer's discretion. Details in
[CONTRIBUTING.md](CONTRIBUTING.md).

**Translations are very welcome**: a language is one file in [`locales/`](locales/), so translating the whole
interface into your language means editing a single JSON — no build, no code.

## Acknowledgements

The project grows in no small part thanks to the community — thank you to everyone who helps.

**For pull requests**
- [@Ainour108](https://github.com/Ainour108) — redesign of the "Text processing" module: document-tree sidebar, tabs, live streaming of the agent's answer, native file dialogs ([#6](https://github.com/DanielLetto2020/LiteEditorAI/pull/6))
- [@anupamme](https://github.com/anupamme) — the relay's `/reports` endpoint moved from a query-string secret to an `Authorization` header ([#9](https://github.com/DanielLetto2020/LiteEditorAI/pull/9))

**For bug reports**
- [@Eurgen](https://github.com/Eurgen) — emoji in the status line ([#1](https://github.com/DanielLetto2020/LiteEditorAI/issues/1)), a crash caused by a file missing from the distribution ([#5](https://github.com/DanielLetto2020/LiteEditorAI/issues/5))

**For ideas and suggestions**
- [@Eurgen](https://github.com/Eurgen) — terminal shell selection ([#2](https://github.com/DanielLetto2020/LiteEditorAI/issues/2)), `Ctrl+Enter` newline ([#4](https://github.com/DanielLetto2020/LiteEditorAI/issues/4)) and other proposals ([#3](https://github.com/DanielLetto2020/LiteEditorAI/issues/3))

## License

[Apache License 2.0](LICENSE) © 2026 Maksim Kuzminskiy. Keep the attribution in use and in derivative works
(see [NOTICE](NOTICE)).

Built on [Electron](https://www.electronjs.org/), [xterm.js](https://xtermjs.org/),
[node-pty](https://github.com/microsoft/node-pty) and [CodeMirror 6](https://codemirror.net/).
