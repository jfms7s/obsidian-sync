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

Everything the server stores (the database and the encrypted chunks) is in the `obsync-data` volume, which is also all you need to back up. `docker compose logs -f obsync` shows what it does. The server never logs tokens, keys, passphrases or encrypted payloads.

The image is published as `ghcr.io/jfms7s/obsync` with a tag for every release. Pin a release in `.env` (`OBSYNC_VERSION=0.1.0`) rather than following `latest`.

### Without Docker

Release archives contain the `obsync` binary for Linux (amd64 and arm64) and the example systemd unit.

```bash
sudo install -m 0755 obsync /usr/local/bin/obsync
sudo install -m 0644 deploy/systemd/obsync.sysusers /usr/lib/sysusers.d/obsync.conf && sudo systemd-sysusers
sudo install -d /etc/obsync
sudo cp deploy/systemd/obsync.env.example /etc/obsync/obsync.env      # edit it
sudo cp deploy/systemd/obsync.service /etc/systemd/system/
sudo systemctl enable --now obsync
# Accounts are created as the service's user, with the service's environment:
sudo -u obsync env OBSYNC_DATA_DIR=/var/lib/obsync obsync admin user create --username alice
```

Put a reverse proxy with TLS in front of it (the compose example's `Caddyfile` is two lines). The server itself speaks plain HTTP on `OBSYNC_LISTEN` (default `:8080`; the systemd unit binds `127.0.0.1:8080`).

- The server is built for Linux. On any other system (macOS, Windows) run the Docker image.

### Configuration

Settings come from environment variables (or a YAML file named by `OBSYNC_CONFIG` or `--config`; variables win). Nothing needs to be set for a single-node setup besides how it is reached.

| Variable | Default | Meaning |
|---|---|---|
| `OBSYNC_LISTEN` | `:8080` | Address the HTTP server listens on |
| `OBSYNC_DATA_DIR` | `/data` | Folder for the database and the encrypted chunks |
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

Or install beta releases with the [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) plugin, pointing it at `jfms7s/obsidian-sync`.

### Set up the first device

Open **Settings → Obsync** and follow the steps:

1. **Sign in** with the server address, the account name and the password the administrator gave you.
2. **Choose an encryption passphrase** (at least 10 characters). Creating the keys takes a few seconds, longer on a phone.
3. **Write down the 24 recovery words.** They are shown only now.
4. **Create the vault** on the server, or choose one that already exists. Files that are in this vault and not on the server are uploaded.

### Add another device

Sign in with the same account, **unlock** with the passphrase (or the recovery words), and choose the vault. An existing local copy of the vault on the new device is merged with the server's: files with the same name and different content are merged or kept side by side. For a clean start, begin with an empty vault folder.

### Using it

- The status bar shows *synced*, *syncing*, *offline*, *sync error*, *sync stopped* or, before the setup is finished, *not set up*. On a phone there is no status bar: the settings tab and the notices show the state. The ribbon button only starts a sync (**Sync now**).
- **Show history of the current file** (command palette, or the file's menu) lists the versions, compares one with the file as it is now, and restores it. **Restore a deleted file** lists what was deleted.
- **Ignored files** in the settings are patterns of files and folders this device does not sync, one per line (`Private/`, `*.pdf`, `drafts/**/*.md`). `.trash/`, `.git/`, the vault's configuration folder and operating-system junk files are never synced.
- Files deleted by another device are moved the way Obsidian's **Files and links → Deleted files** setting says (system trash by default). The server keeps the content for the history view either way.

### Good to know

- **Mobile apps sync only while Obsidian is open.** iOS and Android suspend apps in the background. When you come back, the plugin compares everything with the server.
- **Edits made while Obsidian was closed** (with another editor, or by `git`) are picked up when it starts.
- **Obsidian's own settings and community plugins are not synced** in this release. They are planned as a separate, per-account layer.
- A file larger than 256 MiB is skipped, with a notice.
- If the server is restored from an older backup, devices notice it, keep their newer edits, and upload them again. A copy of the older text is saved next to a file that now differs.

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
plugin/    The TypeScript plugin: src/ (engine and shell), test/, lint/ (Obsidian's lint rules)
deploy/    Compose stack with Caddy, systemd unit
scripts/   Release checks
```

You need Go (the `go.mod` pins the toolchain), Node 22.12 or newer, and a C compiler (the libSQL driver needs CGO).

```bash
make tools            # buf, protoc-gen-go, golangci-lint into ./bin, and npm ci
make check            # Go tests (-race) and vet, all linters, plugin typecheck and tests, plugin build
make convergence      # the random multi-device suite: CONVERGENCE_SEEDS=1000 for the full run
make plugin-install VAULT=~/vaults/test    # build and copy the plugin into a vault
make docker-build     # image for this machine
```

The plugin tests start the real `obsync` server; the convergence suite runs three simulated devices through hundreds of random operations (edits, renames, deletes, going offline, crashes, server restores, case-only renames, folder and file clashes) and checks that every device ends with the same vault and that no edit is lost. A failing seed prints its whole history and can be replayed with `CONVERGENCE_SEED=<n> make convergence`.

Releases are made by pushing a tag `X.Y.Z` that matches `manifest.json` (no `v`): the release workflow runs 1,000 convergence seeds, builds the binaries, the plugin files and the multi-arch image, and publishes them together.

## License

[MIT](LICENSE)
