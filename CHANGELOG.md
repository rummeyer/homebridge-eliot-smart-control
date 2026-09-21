# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **The memory-name setting.** The Home app renames switches perfectly well,
  which is where anyone would look first, and a list of names in a config file
  that has to line up with slots 1 to 4 by position was the more awkward of the
  two ways to do it. Names already configured are simply ignored; rename the
  switches in the Home app instead.

### Fixed

- **A switch renamed in the Home app keeps its name.** The plugin wrote
  `ConfiguredName` on every start, so a rename lasted until the next Homebridge
  restart and then quietly reverted. It is now set once, when the switch is
  first created. This applies to the child lock too.

### Changed

- **Eco mode is a choice of three, not a checkbox**: leave the desk alone, eco
  on, or eco off. A tickbox could not say the difference between "make this
  desk fast" and "don't touch this desk's settings", and the plugin had to
  treat the unticked box as the second — which meant the fast setting was the
  one you could not ask for by unticking. *Leave the desk as it is* stays the
  default. `true` and `false` still work, and still mean on and off.
- **The desk's stored eco setting is logged on every connection.** Nothing else
  can tell you: the settings page cannot reach the desk while the plugin holds
  the dongle's only connection, and what the desk reports is what it has stored
  rather than what it is running.

## [1.2.0] — 2026-09-21

### Added

- **Eco mode as a setting**, off by default and left alone unless you set it.
  It writes eco and travel speed as a pair — eco on with the slowest travel the
  Eliot app offers, eco off with the fastest — because they are one decision
  rather than two. It is worth having: measured on hardware, the pair takes the
  desk from 22.6 mm/s to 42.4 mm/s. The desk stores both and goes on running
  whatever it was last reset with, so the log says plainly that a manual reset
  is needed and does not pretend the setting took effect.

### Fixed

- **`idlePollSeconds` says what the poll must stay clear of.** The desk does
  stream its height while the control box drives itself — the note claiming
  otherwise was wrong and has been withdrawn. What is worth documenting is the
  hazard in the other direction: `SETTINGS` is a command, and one arriving
  mid-move cancels the move, so a poll of a few hundred milliseconds turns
  every move into a ten-millimetre nudge. The plugin's 30 s idle poll was never
  anywhere near that; the tools in `tools/` briefly were.

## [1.1.0] — 2026-09-21

### Added

- **The control box's firmware version**, shown in the Home app's accessory
  details instead of nothing. It is published exactly as the desk reports it:
  this one says `10`, which is probably version 1.0, but nothing here has
  established that and a dot would make a guess look like a reading. The desk
  only says so a couple of seconds after connecting, which is later than
  HomeKit reads the information service, so the version is remembered between
  restarts and published from that. A desk seen for the first time shows
  nothing until its second start — the price of not inventing a number.
- **The desk's own settings are now read back**, not assumed. `CONNECT` (`0xFE`)
  turns out to be the command that fetches the whole settings block — travel
  speed, eco mode, motion mode, collision sensitivity, display units and the
  firmware version. Until now this plugin sent it never and the protocol notes
  called its purpose unknown.
- **A second line in the `GOTO_HEIGHT` fallback warning**, naming the motion
  mode the desk reports. It is the setting most likely to explain a control box
  that will not drive itself, and the log now says which value is in force
  rather than leaving it to be guessed at.
- **Frames received are logged**, at debug level, mirroring the `→` that was
  already there. Without them the log showed what was asked and never what came
  back, so a desk that did not answer and an answer that was not understood
  looked exactly alike.

### Changed

- **Reconnect attempts now top out at a minute**, not five. The usual reason
  the desk is unreachable is that something else holds the dongle's single
  connection — the Eliot app, most often — and that ends the moment the app is
  closed. The old ceiling meant the desk stayed missing for up to five minutes
  after it was free again, with nothing to show for the wait.
- Nothing else a user can see beyond the above. The settings are read but not
  yet offered as switches: eco and travel speed only take effect after the desk
  is reset, and a switch that silently needs a reset to mean anything would be
  worse than no switch.

## [1.0.0] — 2026-09-18

First stable release. Everything in it has been verified against an Eliot
desk with a Smart Dongle: the protocol, the travel measurements, and each
command it sends.

One thing has not been, and is worth stating plainly. The step-command
fallback — for a control box that does not know *go to height* — has met no
such control box. It is covered by tests and by nothing else.

## [0.5.0] — 2026-09-18

### Added

- **The desk's child lock as a switch.** It shows the real state: unlike every
  other setting the app can change, this one the control box reads back.

### Changed

- **The desk is now given a height and left to drive there itself.** Its
  control box has a *go to height* command and a *stop* command; neither
  appears in the published write-ups of this protocol, and both were found in
  the Eliot Android app and verified on hardware. Moves land exactly on target
  instead of within about 1%, on the control box's own ramp, and stopping part
  way coasts 13 mm rather than 18.
- Step commands remain as a fallback for a control box that does not know
  *go to height*: if the desk has not moved shortly after being told where to
  go, the old loop takes over. Untested against such a box, since none was to
  hand.

### Added

- `docs/PROTOCOL.md` records the twelve commands the published write-ups are
  missing, and what the app's *Automatischer Reset* actually does — it is not
  a command at all, but a drive to the physical bottom so the control box can
  find its zero. It also records the two commands that do nothing on this
  control box, measured rather than assumed, which is why no switches were
  built for them.

## [0.4.0] — 2026-09-18

Written after the fact: the 0.4.0 release never added its own entry, and this
one is reconstructed from the commits it contained.

### Added

- **The control box drives the desk itself.** The Eliot Android app turns out
  to be React Native, so its command table is plain JavaScript in the bundle,
  and it holds two commands the published Jiecang write-ups do not:
  `GOTO_HEIGHT` (`0x1B`, big-endian millimetres) and `STOP` (`0x2B`). Both
  verified against the desk — a move landed 2 mm off target on a single
  command, and `STOP` halted one after 13 mm of coasting.
- A changelog, and `prepare` / `prepublishOnly` scripts, so a stale build or a
  failing suite cannot reach the registry. CI runs across the three Node
  versions `package.json` claims to support, and needs no Bluetooth: the
  transport reports an unreachable D-Bus rather than throwing.

### Changed

- **Slider moves land on the target** rather than within about 1%, on the
  control box's own ramp, and HoldPosition is a real stop instead of an
  approximation. The step-command loop existed only because neither command was
  known to exist; it stays as a fallback for a control box that does not
  understand `GOTO_HEIGHT`, and has yet to meet one.
- The README setup is reordered around the settings page now that it can find
  the dongle, and troubleshooting says plainly that a dongle which stays silent
  while powered is simply broken.

### Fixed

- **A cancelled move could cancel its replacement.** Cancelling fires `STOP`
  and then a step command as insurance; unawaited, that step arrived after the
  next destination had been set and stopped the new move instead.
- **A desk that never started looked like one that had finished.** A control
  box ignoring `GOTO_HEIGHT` was judged by the "held still long enough to have
  arrived" rule, which is the right rule for a move that happened.

### Removed

- The desk's real Bluetooth address, which was in the README, the schema
  placeholder and `src/config.ts`, and so shipped compiled into `dist` as well.
  Not a secret, but it identifies a particular piece of hardware and had no
  reason to travel.

## [0.3.1] — 2026-09-18

### Fixed

- **Memory switches did nothing after a restart.** Homebridge restores an
  accessory's services from its cache but not their handlers, and the switches
  were adopted without being wired up again — present in the Home app,
  unresponsive, and silent about it. They worked only in the session that
  created them.

### Changed

- The accessory accepts an injected transport, so its behaviour can be tested
  without a desk in the room. The fix above was untestable before.

## [0.3.0] — 2026-09-18

### Added

- **Find your desk** in the plugin's settings page. The dongle advertises as
  `Schreibtisch` with no manufacturer name, a random-static address and often
  nothing printed on the sticker, so a scan list gives nothing to go on.
  Candidates are confirmed by the serial service rather than by name, and the
  page reports the two states that otherwise look like failure: a dongle
  already connected to something else, and a signal weak enough to predict
  dropouts.
- `tools/find-desks.js`, the same discovery from the command line.

## [0.2.1] — 2026-09-18

### Fixed

- **A memory move can be stopped after all.** The previous release documented
  the opposite. There is no stop command, but any step command cancels a move
  the control box is driving — verified on hardware. `HoldPosition` works
  during a preset, and a second move now cancels the first rather than racing
  it.

## [0.2.0] — 2026-09-18

### Added

- **The desk's memory positions as momentary switches.** The control box drives
  to them itself on its own ramp, easing into the target within about 2 mm,
  which is better than this plugin manages with step commands. Only memories
  the desk actually has appear.

### Fixed

- Services set `ConfiguredName` as well as `Name`; without it the Home app
  shows every switch under the accessory's own name.

## [0.1.1] — 2026-09-18

### Fixed

- **Measurement noise read as somebody using the handset.** The control box's
  reported height wanders a few millimetres between reports, and the threshold
  sat inside that noise, so the target was reset constantly. Movement is now
  judged against the height the desk was last settled at, which also catches a
  slow handset move that consecutive readings would miss entirely.

## [0.1.0] — 2026-09-18

First release.

### Added

- Control an Eliot sit-stand desk from the Home app over Bluetooth, as a window
  covering. 0% is the lowest height the desk is configured to allow, 100% the
  highest, both read from the desk rather than configured here.
- Position, direction of travel and a stop control; the Home app follows the
  handset as well as the other way round.
- An unreachable desk reports a communication failure rather than the height it
  had an hour ago.
- `docs/PROTOCOL.md`: the protocol, reverse-engineered for this desk and
  verified against hardware, including the measured travel speed and stopping
  distance.

[Unreleased]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/releases/tag/v0.1.0
