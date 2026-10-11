# Obsync

End-to-end encrypted sync for [Obsidian](https://obsidian.md) vaults, through a server you run yourself.

- **Your notes are encrypted on your devices.** The server stores only ciphertext. It cannot read note contents, file names or folder names.
- **Self-hosted and free.** One small Go binary (or container) and one data volume. No CouchDB, no cloud account.
- **Desktop and mobile.** The plugin runs on Windows, macOS, Linux, iOS and Android.
- **No silent data loss.** Concurrent edits are merged line by line, or both versions are kept (the other one as a conflict copy). Earlier versions and deleted files can be restored.

Obsync has two parts: the server `obsync` (this repository's `server/`) and the Obsidian plugin (`plugin/`). This is the first release (0.1): core sync for one account across several devices. Sharing a vault between accounts, single sign-on and a web admin interface are planned for later releases.

## How it works

Each device keeps a vault folder, as Obsidian does. The plugin watches it and talks to the server over HTTPS:

1. A changed file is split into chunks, each chunk is encrypted on the device, and the server stores the ciphertext under an opaque id. The file's path is encrypted as well.
2. The server keeps an ordered log of changes per vault and tells the other connected devices (over a WebSocket) that there is something new.
3. Those devices download the chunks, decrypt them, and write the files. If you edited the same file meanwhile, the two versions are merged with a three-way merge. If they overlap, your version stays and the other one is saved next to it as `name (conflict <device> <date time>).md`.

Every 15 minutes (and when the app starts or reconnects) the plugin also compares its whole vault with the server, so changes made while Obsidian was closed are picked up.

### What the server can see

| The server sees | The server cannot see |
|---|---|
| Account names, device names and platforms, IP addresses | Note contents |
| Sizes and times of changes, number of files and versions | File and folder names |
| Which chunks are identical within a vault | The vault's name |

A server operator who is also an attacker can withhold data, roll it back to an older state, or refuse service. Obsync detects a server restored from a backup and keeps your newer local edits, but it cannot force a dishonest server to behave.

### Keys

- Your **encryption passphrase** is separate from your account password. It protects the keys that encrypt your vault. Nobody can reset it for you.
- When you set it up, you also get **24 recovery words**. They unlock the account on a new device if you forget the passphrase. Write them down and keep them somewhere safe: they are shown once.
- A device keeps the unlocked keys in the app's local database, so you only enter the passphrase when you add a device. **Other plugins you install can read that database**, so install only plugins you trust. (The notes on that device are readable by them anyway.)

## Run the server

You need a machine with a public name, ports 80 and 443 open, and Docker with the compose plugin. The example stack runs the server behind [Caddy](https://caddyserver.com), which gets and renews a certificate by itself. The plugin requires HTTPS (plain `http://` works only for `localhost`).

```bash
git clone https://github.com/jfms7s/obsidian-sync
cd obsidian-sync/deploy/compose/single-node
cp .env.example .env
$EDITOR .env            # set OBSYNC_DOMAIN to your host name
docker compose up -d
```

Create an account. The password is read from the terminal (or from standard input):

```bash
docker compose run --rm obsync admin user create --username alice
```

Everything the server stores (the database and the encrypted chunks) is in the `obsync-data` volume (Docker names it `obsync_obsync-data`), which is also all you need to back up. Either take a backup while the server runs with `obsync admin export` (see [Backups](#backups)), or stop the server while you copy the volume (`docker compose stop obsync`, copy the volume, `docker compose start obsync`): a plain copy taken while the server writes can catch the database half-way through a write. The convergence suite restores both copies of a stopped server and copies of a running one taken between two requests. `docker compose logs -f obsync` shows what it does. The server never logs tokens, keys, passphrases or encrypted payloads.

The image is published as `ghcr.io/jfms7s/obsync` with a tag for every release. Pin a release in `.env` (`OBSYNC_VERSION=0.1.0`) rather than following `latest`.

### Without Docker

Each release has a static `obsync` binary for Linux (amd64, arm64), macOS (amd64, arm64) and Windows (amd64): `obsync_X.Y.Z_<os>_<arch>.tar.gz`, or `.zip` for Windows. The Linux archives also contain the example systemd unit. On Linux, run the steps below from inside the extracted archive:

```bash
tar -xzf obsync_X.Y.Z_linux_amd64.tar.gz      # or _arm64
cd obsync_X.Y.Z_linux_amd64
sudo install -m 0755 obsync /usr/local/bin/obsync
sudo install -m 0644 deploy/systemd/obsync.sysusers /usr/lib/sysusers.d/obsync.conf && sudo systemd-sysusers
sudo install -d /etc/obsync
sudo cp deploy/systemd/obsync.env.example /etc/obsync/obsync.env      # edit it
sudo cp deploy/systemd/obsync.service /etc/systemd/system/
sudo systemctl enable --now obsync
# Accounts are created as the service's user, with the service's settings: the
# unit's data directory, then the env file (readable only by root, so root reads
# it and then drops to the obsync user):
sudo sh -c 'set -a; OBSYNC_DATA_DIR=/var/lib/obsync; . /etc/obsync/obsync.env; exec setpriv --reuid=obsync --regid=obsync --init-groups obsync admin user create --username alice'
```

Put a reverse proxy with TLS in front of it (the compose example's `Caddyfile` is a few lines). The server itself speaks plain HTTP on `OBSYNC_LISTEN` (default `:8080`; the systemd unit binds `127.0.0.1:8080`). With the proxy on the same machine, set `OBSYNC_TRUSTED_PROXIES=127.0.0.1,::1` in `/etc/obsync/obsync.env`, so that rate limits see each client's own address instead of the proxy's.

- On macOS and Windows, run `obsync serve` under the service manager you use (launchd, a Windows service wrapper); only the systemd unit ships. Set `OBSYNC_DATA_DIR` (or `data_dir`) and `OBSYNC_LISTEN` as on Linux. obsync makes its data folder private on Unix systems (macOS included). On Windows, new files inherit the folder's ACL, so give the data folder an ACL that only the service's account can read.

### Managing accounts and devices

`obsync admin` runs against the same data as the server (prefix it with `docker compose run --rm obsync` or `sudo -u obsync env OBSYNC_DATA_DIR=/var/lib/obsync` as above):

| Command | What it does |
|---|---|
| `admin user create --username NAME [--quota-bytes N]` | Creates an account; the password is read from the terminal or standard input |
| `admin user list` | Lists accounts |
| `admin user set-password --username NAME [--revoke-devices]` | Sets a new password. Signed-in devices stay signed in unless `--revoke-devices` signs them all out (do that after a suspected compromise) |
| `admin device list --username NAME` | Lists the account's devices, when they were last seen and whether they are revoked |
| `admin device revoke --username NAME (--id DEVICE_ID \| --all)` | Signs one device, or all of them, out for good |
| `admin maintenance run [--as-of TIME]` | Runs one pass of history pruning, trash purge and chunk cleanup now, or as if the time were `TIME` (RFC 3339, e.g. `2027-01-31T00:00:00Z`). The server runs the same pass every `OBSYNC_JOBS_INTERVAL_MINUTES` under a lease; while its pass (or an export) runs, this one is refused, so try again a minute later |
| `admin user delete --username NAME --yes` | Deletes the account with all its vaults and their history. Without `--yes` it only says what it would delete. It cannot be undone |
| `admin export --out DIR [--copy] [--wait 2m]` | Writes a backup the server can start from, while the server runs (see [Backups](#backups)) |
| `admin export --prune DIR --keep N` | Removes all but the newest `N` exports in `DIR` (only folders with a `MANIFEST.json`) |

#### Backups

`obsync admin export --out DIR` writes a consistent copy of the database to `DIR/meta.db` and places every chunk it lists in `DIR/blobs/`, then writes `DIR/MANIFEST.json` (server version, time, counts and bytes). It runs next to a running server: it holds the maintenance lease, so no pruning or chunk cleanup deletes anything until it is done (it waits up to `--wait` for a pass already running). `DIR` must be new or empty.

- Chunk files are never changed once written, so they are **hard-linked** into the export: it is instant and takes no space until the live chunk is deleted. Deleting an export never touches the live data. On another filesystem, or with `--copy`, they are copied.
- Exit status 0 is success, 1 a failure (nothing is left behind), and **3** means the export is complete but some chunks were already missing from the live store; `MANIFEST.json` lists them.
- Only a local database (`file:`) can be exported; back up a `libsql://` database on its own server. Do not run `admin user delete` during an export (its chunks would show as missing).
- An export holds the account data (password and token hashes, encrypted notes): copy it off the machine (`tar`, `rsync`, restic) to somewhere as private as the server.
- To restore, stop the server, point `OBSYNC_DATA_DIR` (or the volume) at the export (and `OBSYNC_BLOB_FS_DIR` at its `blobs` folder if you set that variable), and start it. Devices notice the server went back in time and upload what they have that is newer.

```bash
obsync admin export --out /var/lib/obsync/export/$(date +%F)
obsync admin export --prune /var/lib/obsync/export --keep 3
```

### Configuration

Settings come from environment variables (or a YAML file named by `OBSYNC_CONFIG` or `--config`; variables win). Nothing needs to be set for a single-node setup besides how it is reached.

| Variable | Default | Meaning |
|---|---|---|
| `OBSYNC_LISTEN` | `:8080` | Address the HTTP server listens on |
| `OBSYNC_DATA_DIR` | `/data` | Folder for the database and the encrypted chunks. obsync keeps it private (mode 0700, files 0600) |
| `OBSYNC_DATABASE_URL`, `OBSYNC_DATABASE_AUTH_TOKEN` | `file:` in the data folder, none | The metadata database, a local SQLite file. Remote databases (`libsql://`, `http://`, `https://`) are reserved for clustered mode and are not supported yet: the server refuses to start with one |
| `OBSYNC_DATABASE_SYNCHRONOUS` | `full` | How hard the database pushes each write to disk. `full` makes every accepted change survive a power cut. `normal` makes bulk uploads much faster (one disk flush per checkpoint instead of per write) and cannot corrupt the database, but a power cut or kernel crash of the host can lose the last few accepted changes; every device then treats the server as restored from a backup, keeps its own edits and uploads them again. A crash of obsync alone loses nothing. Local database file only |
| `OBSYNC_TRUSTED_PROXIES` | none | Reverse proxies (addresses or CIDRs, comma separated) whose `X-Forwarded-For` is believed. Without it, every client appears to come from the proxy's address |
| `OBSYNC_DEFAULT_QUOTA_BYTES` | 10 GiB | Storage per account (unique chunks plus kept history) |
| `OBSYNC_MAX_FILE_SIZE_BYTES` | 2 GiB | Largest file the server accepts. The plugin itself syncs files up to 256 MiB |
| `OBSYNC_HISTORY_DAYS` | 30 | Days a replaced version is kept (0: no age limit) |
| `OBSYNC_HISTORY_MAX_VERSIONS` | 0 | Versions kept per file (0: no limit) |
| `OBSYNC_TRASH_DAYS` | 30 | Days a deleted file can be restored |
| `OBSYNC_GC_GRACE_HOURS` | 24 | How old an unused chunk must be before it is removed |
| `OBSYNC_JOBS_INTERVAL_MINUTES` | 60 | How often history pruning and chunk cleanup run |
| `OBSYNC_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `OBSYNC_RATE_LIMIT_DEVICE_RPS`, `_BURST`, `OBSYNC_RATE_LIMIT_IP_RPS`, `_BURST` | 100 / 1000, 1 / 10 | Request limits per device and per address (0 turns one off) |

`deploy/systemd/obsync.env.example` lists the rest, with comments. `obsync health` checks the server's own `/readyz` (it is what the container's health check runs). `obsync migrate` applies database migrations and exits; `obsync serve` does it by itself on start.

## Install the plugin

The plugin needs Obsidian 1.8.7 or newer. It is not in Obsidian's community list yet. Until it is, install a release by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/jfms7s/obsidian-sync/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/obsync/` (the folder is hidden; create it if needed). On a phone, use your file manager or a sync tool to put the folder in the vault's `.obsidian/plugins/`.
3. In Obsidian, open **Settings → Community plugins**, turn on community plugins, and enable **Obsync**.

Releases after 0.1.0 carry signed build provenance for every file and for the image, so you can check that a file was built by this repository's release workflow from the tagged commit (needs the [GitHub CLI](https://cli.github.com)):

```bash
gh attestation verify main.js --repo jfms7s/obsidian-sync
```

Or install beta releases with the [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) plugin, pointing it at `jfms7s/obsidian-sync`.

### Set up the first device

Open **Settings → Obsync** and follow the steps:

1. **Sign in** with the server address, the account name and the password the administrator gave you.
2. **Choose an encryption passphrase**: at least 4 words or 16 characters, and not your account password. Four or more random words (diceware) work well. Creating the keys takes a few seconds, longer on a phone.
3. **Write down the 24 recovery words.** They are shown only now.
4. **Create the vault** on the server, or choose one that already exists.
5. **Choose what not to sync** (for example `.venv/` or `node_modules/`), then **Start syncing**. Nothing is uploaded or downloaded before this step. Files that are in this vault and not on the server are then uploaded.

### Add another device

Sign in with the same account, **unlock** with the passphrase (or the recovery words), choose the vault and what not to sync on this device. An existing local copy of the vault on the new device is merged with the server's: files with the same name and different content are merged or kept side by side. For a clean start, begin with an empty vault folder.

### Using it

- The status bar shows *synced*, *syncing*, *offline*, *sync error*, *sync stopped* or, before the setup is finished, *not set up*. On a phone there is no status bar: the settings tab and the notices show the state. The ribbon button only starts a sync (**Sync now**).
- **Show history of the current file** (command palette, or the file's menu) lists the versions, compares one with the file as it is now, and restores it. **Restore a deleted file** lists what was deleted, grouped by the device that deleted it and when; **Restore all** brings back a whole group with one confirmation (the undo for a large deletion that reached every device), skipping and listing any file that exists again or whose name is taken.
- The settings tab shows the account's **storage** against its quota ("Storage: 512 MB of 10 GB used": encrypted chunks of every vault the account owns, history and deleted files included) and, when the account owns more than one vault, this vault's share. It refreshes after a sync, at most once a minute while the tab is open.
- **Ignored files** in the settings are patterns of files and folders this device does not sync, one per line (`Private/`, `*.pdf`, `drafts/**/*.md`). `.trash/`, `.git/`, the vault's configuration folder (except the settings files below) and operating-system junk files are never synced. A new rule stops syncing the files it matches but leaves the copies already on the server and on other devices; when you save rules (either list) that match files this device already synced, the settings tab names them with their size and offers **Remove from server**. Confirmed, it deletes them on the server as if they were deleted here: this device keeps its copies, other devices move theirs to the trash unless they ignore the files too, and the server keeps them in its deleted files for the trash period. Removing the rule later uploads this device's copies again.
- **Ignored on every device** keeps rules for all devices in `.obsyncignore` at the vault root. It is an ordinary file that syncs like a note, so a rule written once applies everywhere; Obsidian hides dot-files, so the settings tab edits it (any text editor works on a desktop). A device ignores the union of the built-in list, the configuration folder, `.obsyncignore` and its own list: it can add rules, never un-ignore one from the file. A new device applies the vault's `.obsyncignore` before anything else arrives; a changed file applies at the next sync, and removing a rule brings the matching files back. The syntax is the same as the device list: one pattern per line, `#` comments, a trailing `/` for folders, `*`, `?` and `**`; negation (`!`) and character classes (`[...]`) are not supported, and lines that use them are skipped (the settings tab lists them) while the rest applies. No rule ever matches `.obsyncignore` itself. `.gitignore` files are not read.
- Files deleted by another device are moved the way Obsidian's **Files and links → Deleted files** setting says (system trash by default). The server keeps the content for the history view either way.

### Good to know

- **Mobile apps sync only while Obsidian is open.** iOS and Android suspend apps in the background. When you come back, the plugin compares everything with the server.
- **Edits made while Obsidian was closed** (with another editor, or by `git`) are picked up when it starts, or within seconds by [obsync-cli](#sync-without-obsidian-obsync-cli) running on that machine.
- **Obsidian settings** (settings tab, off until you turn it on on each device) syncs Obsidian's own settings files between the devices that turn it on: by default every core file (`app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`, `community-plugins.json`), except that a phone or tablet keeps its own appearance; each can be turned off per device, and a file a device does not sync keeps that device's own copy. A community plugin's settings (`plugins/<id>/data.json`) sync only for the plugins you tick: some plugins keep API keys or paths that only fit one device there. Plugin code, themes, CSS snippets, the workspace layout and Obsync's own folder are never synced, so a plugin listed in `community-plugins.json` only loads on a device where it is installed. Settings files arrive on disk and Obsidian uses them after a restart (a notice says so). Changes are found within 30 seconds; two devices changing the same setting at once keep the one that reached the server first, and changes to different settings are merged (no conflict copies in the config folder). Devices only exchange settings when their config folder has the same name (Obsidian's "Override config folder" setting gives it another one).
- A file larger than 256 MiB is skipped, with a notice.
- If the server is restored from an older backup, devices notice it, keep their newer edits, and upload them again. A copy of the older text is saved next to a file that now differs.

## Sync without Obsidian (obsync-cli)

`obsync-cli` is the plugin's sync engine without Obsidian: one more device on your account that syncs a vault folder on a desktop or server. Run it as a service and files that other programs write into the folder (an editor, a script, an AI agent in a terminal) reach your other devices within seconds, even while Obsidian is closed. Edits from your other devices land in the folder the same way.

It needs Node 22.12 or newer. The account's encryption keys must already be set up in Obsidian (the CLI unlocks them; it does not create them).

### Install it

Download `obsync-cli.mjs` from the [latest release](https://github.com/jfms7s/obsidian-sync/releases/latest) (it is one file, with everything it needs inside), check it, and put it somewhere stable:

```bash
gh attestation verify obsync-cli.mjs --repo jfms7s/obsidian-sync
install -D -m 0755 obsync-cli.mjs ~/.local/lib/obsync/obsync-cli.mjs
```

Or build it from a checkout with `make cli-build` (it lands in `plugin/dist/obsync-cli.mjs`). Below, `obsync-cli` stands for `node ~/.local/lib/obsync/obsync-cli.mjs`.

### Set it up

```bash
obsync-cli login --server https://sync.example.com --username alice --device-name "desktop (cli)"
obsync-cli unlock                      # the encryption passphrase; --recovery for the 24 words
obsync-cli vaults                      # lists the vaults with their ids
obsync-cli vaults --choose 3f2a…       # the one this folder is a copy of
obsync-cli sync --vault-dir ~/Documents/Vault --init --once
```

The password and the passphrase are typed with echo off. A script can pass them on a file descriptor instead (`--password-fd 3 3<password-file`, `--passphrase-fd`); they are never accepted as arguments.

The first `sync` of a folder needs `--init`. It ties this login to that folder, and every later run refuses any other folder, so a typo cannot upload the wrong one. As when you add a device in Obsidian, a folder that already holds the vault is merged with the server's copy; for a clean start, use an empty folder.

### Run it as a service

`sync` without `--once` keeps running: it watches the folder and listens to the server, like the plugin. `deploy/systemd/obsync-cli.service` is a systemd user unit for it:

```bash
install -D -m 0644 deploy/systemd/obsync-cli.service ~/.config/systemd/user/obsync-cli.service
# edit ExecStart: the path of node, and --vault-dir
systemctl --user daemon-reload
systemctl --user enable --now obsync-cli
journalctl --user -u obsync-cli -f
loginctl enable-linger "$USER"         # optional: keep it running while you are logged out
```

`obsync-cli status` shows the account, the vault, the folder, whether the daemon runs and what it is doing, and recent warnings. Exit codes: 0 ok, 1 error, 2 when a person must act: log in, unlock, choose a vault, or check the folder (the first sync needs `--init`; the folder is missing, empty although files were synced from it, or not the one this login syncs). The unit does not restart on 2. For a timer or cron job instead of a service, use `sync --once`.

### With Obsidian on the same folder

Obsidian's plugin and the CLI on one folder would each take the other's writes for new edits. So they take turns: while Obsidian syncs the folder, its plugin keeps a heartbeat file in its own folder (`.obsidian/plugins/obsync/active`, rewritten every 30 seconds), and the daemon pauses within 10 seconds, after the sync round it is in. It resumes within about 10 seconds after Obsidian closes, or about 100 seconds if Obsidian was killed (the heartbeat then has to go stale), with a full comparison of the folder and the server. If your vault's configuration folder is not `.obsidian`, pass `--config-dir`.

### Good to know

- **The state directory holds this device's keys.** It is `~/.local/state/obsync-cli/default/` (mode 0700; `$XDG_STATE_HOME` moves it, `--name` keeps several apart, `--state-dir` sets it), with the session token and the unlocked keys: the same secrets the plugin keeps in Obsidian's database on that machine. Keep it out of backups you do not trust. `obsync-cli logout` revokes the device on the server and deletes the state (if the server cannot be reached, it says so and deletes the state anyway: then remove the device from another one).
- **Deleted files go to the folder's `.trash/`** (never synced), like Obsidian's "Move to Obsidian trash" setting; `--no-trash` deletes them for good. The server keeps the content for the history view either way.
- **A large deletion waits for you.** If more than 50 files and a fifth of the vault disappear from the folder at once (an unmounted disk, a wrong `git checkout`), the deletion is held instead of reaching your other devices. `obsync-cli deletions` lists it; `--release` deletes the files everywhere, `--restore` brings them back here.
- **Symbolic links are not synced** (a link to a file is reported as a failed file, never as a deletion), and nothing is read or written through a linked folder.
- The same files are skipped as in Obsidian: `.trash/`, `.git/`, operating-system junk files, and whatever the vault's `.obsyncignore` lists. The configuration folder is left alone entirely: **Obsidian settings** sync only between Obsidian devices that turn it on, never through obsync-cli.
- One process at a time per state: `login`, `unlock`, `vaults --choose`, `deletions --release`/`--restore` and `logout` are refused while the daemon runs; stop it first (`systemctl --user stop obsync-cli`).
- **A folder that is gone or empty is not taken for deleted files.** If the folder's disk is unmounted while the daemon runs, it retries until the folder is back; at start, a missing folder, or an empty one from which files were synced, stops it with exit code 2.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Cannot reach the server" | Check the address and your connection. The address must start with `https://` unless it is `localhost`. |
| "That passphrase does not unlock the account keys" | The passphrase is case-sensitive. Use the 24 recovery words if you forgot it. |
| "This device was removed from your account" | Sign in again (**Settings → Obsync**). The device list on a signed-in device shows and removes devices. |
| A `(conflict …)` file appears | Two devices changed the same lines. Compare the two files, keep what you want, delete the copy. |
| A file keeps its old content on one device | Check **Ignored files** on that device, and the status bar for an error. **Sync now** compares everything with the server. |
| Rate limit errors behind a proxy | Set `OBSYNC_TRUSTED_PROXIES` to the proxy's address, so clients are told apart. |

## Development

```
proto/     Protobuf schema; Go and TypeScript code are generated from it (buf)
server/    The Go server (module github.com/jfms7s/obsidian-sync/server)
plugin/    The TypeScript plugin: src/ (engine and shell), cli/ (obsync-cli, Node only), test/, lint/ (Obsidian's lint rules)
deploy/    Compose stack with Caddy, systemd units (the server, and obsync-cli as a user unit)
scripts/   Release checks
```

You need Go (the `go.mod` pins the toolchain), Node 22.12 or newer (`.nvmrc`; on an older Node the plugin tests fail with "Cannot find native binding"), and, for `make test` only, a C compiler: the server is pure Go and builds without one, but Go's race detector needs cgo.

```bash
make tools            # buf, protoc-gen-go, golangci-lint into ./bin, and npm ci
make check            # Go tests (-race) and vet, all linters, plugin typecheck, unit and server tests, plugin build
make ci-local         # make check plus the rest of CI's checks: generated code and vectors up to date, buf breaking, script tests, bundle check
make convergence      # the random multi-device suite (not part of make check): CONVERGENCE_SEEDS=1000 for the full run
make plugin-install VAULT=~/vaults/test    # build and copy the plugin into a vault
make cli-build        # plugin/dist/obsync-cli.mjs, the headless client
make docker-build     # image for this machine
```

Dependabot proposes grouped updates every week for the workflows' actions, the images, the Go modules and both npm packages, and CI runs `govulncheck` on the server.

The plugin tests start the real `obsync` server; the convergence suite runs three simulated devices through 60 random operations per seed (edits, edits made while a sync cycle is running, renames, deletes, going offline, crashes, server backups and restores, server maintenance passes (history pruning, trash purge, chunk collection) on a server with very short retention, case-only renames, folder and file clashes, one device with whole-second mtimes in a third of the seeds) and checks that every device ends with the same vault and that no edit is lost. CI runs 100 seeds on every push, 1,000 before every release, and 1,000 new seeds every night. A failing seed prints its whole history and can be replayed with `CONVERGENCE_SEED=<n> make convergence`.

Releases are made by pushing a tag `X.Y.Z` that matches `manifest.json` (no `v`): the release workflow runs 1,000 convergence seeds, builds the binaries, the plugin files, `obsync-cli.mjs` and the multi-arch image, and publishes them together.

## License

[MIT](LICENSE)
