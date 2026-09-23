# LiteEditor sync: your computer ↔ your server

Keeps a project folder identical on your computer and on your own server, so an agent on the
server can pick up where the agent on your computer stopped, and the other way round.

- **Two-way, no master copy.** The side where you worked last wins. The direction is worked out
  by comparing three file lists: this computer, the server, and the state after the last sync.
- **Everything in the folder is synced**, including `node_modules` and `.git`. Git is not needed.
- **Nothing disappears silently.** Replaced and deleted files go to a trash folder on the
  receiving side (`~/.lite-sync/trash/…`, kept for 3 days).
- **A file changed on both sides is left alone** and reported as a conflict until you pick a side.
- **Only your server, only over your ssh.** The editor does not contact any server until you
  set one up, and the address never leaves your machine.

## Requirements

- A server you can reach with **`ssh` using a key** (password login will not work).
- **`rsync`** on both machines; `find`, `md5sum` and `du` on the server (standard on Linux).
- **The same absolute path** to the project on both machines, e.g. `/home/me/code/app` on
  both. The folder on the server is created for you.
- Clocks within 5 seconds of each other (turn on NTP). "Which edit is newer" means nothing
  when the clocks disagree.
- Linux or macOS. Windows is not supported: it has no `rsync`.

## Set up from the editor

Click the cloud icon next to a project:

1. Enter the server address the way you would type it for `ssh`: `user@server`, or a host
   name from `~/.ssh/config` (that is also how you use a non-standard port).
2. **Check** tests this computer (`ssh`, `rsync`), key login, the programs on the server and
   the clock difference. If something is missing, it tells you the command that fixes it
   (for example `ssh-copy-id user@server`).
3. **Save and continue** writes the address to `~/.lite-sync/config.json` and starts the sync
   daemon. The editor then shows what is on both sides and connects the project.

The daemon runs while the editor is open. The next project needs just one click on its cloud.

## Command line

```bash
node lite-sync.js status /abs/path/to/project        # what differs (nothing changes)
node lite-sync.js auto   /abs/path/to/project --go   # sync, direction chosen automatically
node lite-sync.js push   /abs/path/to/project --go   # this computer → server only
node lite-sync.js pull   /abs/path/to/project --go   # server → this computer only
node lite-sync.js auto   /abs/path/to/project --go --prefer local    # resolve conflicts: take this computer's version
node lite-sync.js adopt  /abs/path/to/project --go   # accept the current matching state as synced
```

Without `--go` it is a dry run: it prints the plan and changes nothing.

## Settings — `~/.lite-sync/config.json`

```json
{
  "server": "user@server",
  "runner": "editor",
  "projects": [{ "path": "/home/me/code/app" }],
  "debounceMs": 5000,
  "pollMs": 20000,
  "fullSweepMs": 600000,
  "enabled": true
}
```

- `server` — the address; `LITE_SERVER=user@server` in the environment overrides it.
- `runner: "editor"` — the editor starts the daemon and stops it on exit. Remove it if you
  run the daemon with systemd (below).
- `projects` — the folders to keep in step. The editor adds them for you.
- `debounceMs` — how long a folder must stay quiet before changes are sent (so a half-done
  build or git operation is not synced). `pollMs` — how often the server is asked for changes.
  `fullSweepMs` — a full comparison, in case something was missed.
- `enabled: false` stops syncing altogether.

State lives next to it: `state/` (what was agreed last time), `trash/`, `log.jsonl` (the
daemon's log) and `history.json` (recent exchanges per project).

## Run the daemon without the editor (Linux, optional)

To keep syncing while the editor is closed, run the daemon as a systemd user service and
remove `"runner": "editor"` from the settings. Only one daemon runs at a time
(`~/.lite-sync/daemon.pid`).

```bash
cd /path/to/LiteEditor/scripts/server-sync
NODE="$(command -v node)"
sed -e "s|__NODE__|$NODE|" -e "s|__NODEDIR__|$(dirname "$NODE")|" -e "s|__HERE__|$PWD|" \
  lite-sync.service > ~/.config/systemd/user/lite-sync.service
systemctl --user daemon-reload && systemctl --user enable --now lite-sync
```

## What the daemon leaves on the server

Besides the project folders: `~/.lite-sync/trash/` (replaced files, pruned after 3 days),
`~/.lite-sync/pc-status.json` (when this computer was last online and recent exchanges) and
`~/.lite-sync/requests/` (sync requests left by a web editor on the server, if you run one).

## Limits

- Files are compared by size and modification time (2 s tolerance), not by content.
- A deep project means a full `find` on both sides every poll; it is cheap, but not free.
- There is no "disconnect" button yet: remove the project from `projects` in the settings.
