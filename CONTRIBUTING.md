# Contributing

## Getting set up

```bash
npm install
npm test          # builds, then runs the suite
```

Nothing here needs a desk or a Bluetooth adapter. The transport reports an
unreachable D-Bus rather than throwing, and everything under test takes its
transport as a dependency, so the suite runs anywhere.

## Working against a real desk

The tools in `tools/` talk to hardware and are plain JavaScript, so they run on
a Raspberry Pi with nothing but `npm install node-ble`:

| | |
|---|---|
| `find-desks.js` | List the dongles in range, confirmed by service UUID |
| `eliot-probe.js ask <MAC>` | Read height, limits and memory positions. **Does not move the desk** |
| `link-smoke.js <MAC>` | The same, through the plugin's own transport |
| `desk-test.js <MAC> <percent…>` | **Moves the desk** to each position in turn |
| `move-test.js`, `goto-stop-test.js`, `conflict-test.js` | **Move the desk.** Each was written to answer one question about the protocol; see the header of each |

The dongle takes one connection at a time, so Homebridge has to be stopped
before any of these can connect:

```bash
sudo systemctl stop homebridge
node tools/find-desks.js
sudo systemctl start homebridge
```

## The protocol

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is the reference, and it distinguishes
throughout between what has been measured on hardware and what has been
inferred. Please keep that distinction when adding to it — several things in
this plugin were built the wrong way round because a published write-up was
taken on trust, and the corrections are recorded there too.

## Releasing

Publishing runs from GitHub Actions using [npm trusted
publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is
stored in the repository and there is none to rotate.

**One-time setup on npmjs.com**, under the package's *Settings → Trusted
publisher*:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `rummeyer` |
| Repository | `homebridge-eliot-smart-control` |
| Workflow filename | `publish.yml` |

That page only exists once the package does, so the very first version has to
go up another way — `npm publish` from a logged-in checkout. Every release
after it runs from Actions.

**To release:**

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag: `git tag v1.0.0 && git push --follow-tags`.
3. Create a GitHub release for that tag.

The workflow checks the tag against `package.json` before publishing — a
mistagged release would otherwise put the wrong version under the right name,
and that cannot be undone.
