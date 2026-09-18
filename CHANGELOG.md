# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  find its zero.

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

[Unreleased]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/releases/tag/v0.1.0
