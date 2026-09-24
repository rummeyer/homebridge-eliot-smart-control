# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.11.0] — 2026-09-24

### Changed

- **Memory switches show where the desk is.** A switch is on while the desk
  sits within 12 mm of its position, whether it was sent there from the Home
  app, the handset's memory key or the slider. Switched on in the Home app it
  stays on rather than springing back, and goes off again if the move is called
  off before it arrives. Switching it off on the way stops the desk.

## [1.10.1] — 2026-09-24

### Changed

- **The debug log says what auto movement is doing** — `next move at 13:08`,
  `outside its hours`, or why the countdown has not started — once each time
  that changes.
- **The raw Bluetooth frames are gone from the debug log.** The idle poll
  alone put six unreadable lines in it every half minute. Set `ELIOT_TRACE=1`
  to get them back, now spelled out: `→ SETTINGS`, `← HEIGHT 839 mm`.

## [1.10.0] — 2026-09-24

### Added

- **Sitting and standing time.** While auto movement is on and inside its
  hours, the plugin counts how long the desk spent below and above the
  midpoint between its sitting and standing heights, keeps 100 days of daily
  totals in the Homebridge storage directory, and shows today and the last 7,
  30 and 100 days on the settings page, each once there is that much record.
  **Reset data** below the table starts the count again.
- **At the end of the day** (`autoMove.endOfDay`) moves the desk to standing
  or sitting height once, when the day's last window closes, if auto movement
  is on. Off by default.

### Changed

- **A shorter settings page.** The scan explains itself in one line, and the
  "takes about 12 seconds" hint is gone.

## [1.9.0] — 2026-09-24

### Changed

- **A changed eco mode, travel speed or anti-collision sensitivity now puts
  the desk into reset mode.** The box stores a new setting at once but runs
  the old one until it is reset, and loses an unreset value when it loses
  power — so a config change used to go live weeks later at some unrelated
  reset, or not at all. After a write the plugin sends `0x91`; the handset
  shows RESET, and turning it left finishes the job. Nothing is sent when the
  desk already holds what is configured.

## [1.8.2] — 2026-09-23

### Added

- **`tools/speed-test.js`** measures travel speed over one `GOTO_HEIGHT`
  without polling during the move. `docs/PROTOCOL.md` records what it found
  above the app's ceiling of 40: the box stores any value up to 255 and runs
  45, 50 and 55 at 48, 54 and 60 mm/s, and 255 made the motor stutter. The
  plugin still only ever writes 20 or 40.

### Fixed

- **Eco mode is checked again after a reconnect.** The plugin kept the
  desk's settings from the previous connection and compared against those, so
  a desk that lost power and came back running an older speed was reported as
  fine and left alone. It now forgets them when the link drops and waits for
  the box to say what it has.

## [1.8.1] — 2026-09-23

### Changed

- **The README shows the npm download count and a Buy Me a Coffee badge**,
  instead of three donate badges. GitHub Sponsors, PayPal and Buy Me a Coffee
  all stay in `package.json` and `.github/FUNDING.yml`. No behaviour changes.

## [1.8.0] — 2026-09-23

### Changed

- **A gap between working hours pauses the auto-movement countdown** instead
  of throwing it away. With windows of 08:00–12:00 and 13:00–16:00, a
  countdown that has ten minutes left at noon still has ten minutes left at
  13:00. Before this, the afternoon always started a fresh interval. The Timer
  slider holds still over lunch. The move never comes sooner than the warning
  time, so the warning that was withdrawn at 12:00 is raised again first. A
  handset move during the break, turning auto movement off and on, or a new
  day each start a full interval.

### Added

- **Buy Me a Coffee** as a third funding link, next to GitHub Sponsors and
  PayPal.

## [1.7.1] — 2026-09-23

### Changed

- **A handset move restarts the auto-movement countdown once, when it ends,**
  rather than for every height the desk streams on the way — about thirty
  times for a trip from standing to sitting, each with its own log line.
  While the handset is driving, auto movement also holds off, so a countdown
  that runs out mid-move waits instead of fighting somebody for the desk.

## [1.7.0] — 2026-09-23

### Added

- **The desk's own anti-collision sensitivity is settable**, as
  `collisionSensitivity`: `high`, `medium`, `low` or `leave`. This is the
  control box's brake, not the plugin's stall check — on a sensitive setting,
  arms resting on the desk are enough to end a move nine millimetres in and
  have it reported as stalled. Written only when it differs from what the box
  is holding. Like eco mode, it takes effect when the desk is next reset, and
  the log says so.
- **The auto-movement countdown is visible, and adjustable, as a `Timer`
  slider.** A light whose brightness is how much of the interval is left before
  the next move. Dragging it changes the wait and nothing else: all the way up
  is a fresh interval, all the way down runs the timer out, which moves the desk
  at once and without the warning — nobody needs telling about a move they just
  asked for. Off it reads 0, because a timer that is not running has no
  remainder to show. Outside the working hours it reads full and does
  not run: switching on at 07:00 starts the countdown at 08:00, not at 07:00,
  and a drag there is ignored rather than scheduling a move for later. `timerSlider: false` leaves it out.

### Changed

- **The desk is put into one-touch mode when it is found in hold mode.** In
  hold mode the control box treats `GOTO_HEIGHT` as a nudge and waits to be
  asked again, so a single command moves the desk a centimetre and stops —
  which is to say the plugin cannot drive the desk at all. There is nothing to
  configure, because the alternative is a plugin that does not work. `0` is one
  touch and `1` is hold, now confirmed against a control box rather than read
  out of the app: written to a desk found in hold mode, the handset changed
  behaviour immediately and without a reset. It changes the handset as well as
  the commands, so it is a write somebody standing at the desk will notice.
- **Reconnect attempts stop thinning out at thirty seconds** rather than a
  minute. The ceiling is what somebody waits after the thing blocking the
  dongle goes away — usually the Eliot app, which holds the dongle's one
  connection until it is closed — and a minute of that is a minute of a desk
  showing as unreachable when it is not.

## [1.6.3] — 2026-09-21

### Changed

- **The hardware tools stay out of the npm package.** `tools/` is a workbench
  for a Raspberry Pi with a dongle attached, not something an install needs:
  117 kB of it shipped to every user, a dozen scripts of which drive the desk
  and one of which drives it to the floor. Finding a dongle, the one thing a
  user might have wanted from it, is the scan button in the config UI.

### Removed

- **Fourteen single-question probes.** Each was written to settle one point
  about the protocol — whether `VELOCITY` bites, whether a memory move can be
  interrupted, what `VERSION` answers — and each of those answers, with the
  measurements behind it, is written up in `docs/PROTOCOL.md`. The scripts were
  the scaffolding, and the reference is the thing that was being built. What
  remains in `tools/` is the eight that answer a question you can still have.

## [1.6.2] — 2026-09-21

### Changed

- **The plugin declares the transport it speaks.** `supports-hap` in the
  keywords, which is how Homebridge now expects a plugin to say whether it
  publishes over HAP, Matter or both.
- **`required` in the settings schema is spelled the way JSON Schema spells
  it** — an array on the object rather than `"required": true` on each field.
  The Homebridge UI reads both; only one of them is valid JSON Schema.
- **The plugin icon lives in `docs/` and stays out of the npm package.** It is
  loaded from GitHub where it is shown, so shipping 280 kB of photograph to
  every install bought nothing.

### Fixed

- **`MOTION_MODE` in the protocol reference had its two values swapped.** One
  touch is `0` and hold-to-move is `1`, as the Eliot app's own command table
  and its reader both have it. Nothing in the plugin writes or interprets that
  setting, so this is documentation only.

## [1.6.1] — 2026-09-21

### Added

- **The plugin has an icon**: a photograph of the desk, square, at the top of
  the README and on the npm page. A copy sized for the Homebridge plugin icon
  request sits in `docs/` — Homebridge hosts those icons itself, so the
  repository holds the source rather than the thing the UI reads.

## [1.6.0] — 2026-09-21

### Added

- **Ask again each day**, an option for automatic sit/stand: the *Auto
  Movement* switch turns itself off at the end of the day, so it means "move me
  today" rather than "move me from now on". Off by default, so the switch keeps
  the behaviour it has. The day is remembered rather than timed, so a restart
  late in the evening does not hand it a fresh one.

### Changed

- **Troubleshooting covers a blank tile and a room that will not change.** Both
  are the Home app holding an old copy of what the accessory offers, and both
  are fixed by restarting it — worth writing down, since the plugin can be
  publishing perfectly good values throughout.

## [1.5.2] — 2026-09-21

### Changed

- **Troubleshooting now covers the `npm ERR!` wall on install.** It is
  `usocket`, an optional native dependency of `dbus-next` by way of `node-ble`,
  whose build uses a `node-gyp` too old for Node 22. Optional is the operative
  word: npm reports it, carries on, and `dbus-next` uses its own socket
  implementation — which is what this plugin has always run on.

## [1.5.1] — 2026-09-21

### Added

- **Funding links**: GitHub Sponsors and PayPal, in `package.json` where npm
  and the Homebridge UI read them, and in `.github/FUNDING.yml` for the Sponsor
  button on the repository page.

## [1.5.0] — 2026-09-21

### Fixed

- **A new target while the desk is moving now works.** Cancelling a move sent
  `STOP` and then a step command, as insurance for a control box too old to
  know `STOP`. On a box driving a `GOTO_HEIGHT` that step starts a small move
  of its own, and the replacement target arrives in the middle of it — which is
  a command arriving mid-move, the one thing this box answers by giving up. The
  desk took the 4 mm step and ignored where it had been told to go, so setting
  the slider to 65% moved it by one. `STOP` alone now, followed by a pause long
  enough for the desk to finish coasting before it is given somewhere new.
- **The idle poll no longer cancels a move.** It skipped polling while the
  plugin was driving the desk, but not while the *control box* was — which is
  precisely the case that must not be polled, because `SETTINGS` is a command
  and one arriving mid-move makes the box abandon it. The move died, the desk
  stopped short, and the box then looked like one that had never understood
  `GOTO_HEIGHT`, so the step-command fallback took over and the position
  jumped. Dragging the slider was where this showed.
- **Service names are back, and the room can be changed.** `ConfiguredName` is
  what the Home app displays for a bridged accessory's services — without it
  every switch shows as "Schalter 1", "Schalter 2" and so on — but Switch,
  MotionSensor and WindowCovering do not list it, so it has to be declared with
  `addOptionalCharacteristic` before it is set. Setting it undeclared made
  Homebridge warn on every start and left an accessory the Home app would not
  fully edit. It is also written only when empty, so a name given in the Home
  app stays.

### Added

- **Automatic sit/stand movement.** Set a sitting height, a standing height, an
  interval and the hours it applies to, and the desk alternates between them.
  It arrives switched off behind an **Auto Movement** switch in the Home app,
  because starting to move somebody's furniture on the strength of a config
  file being saved is not a good first impression.
- **A *Desk Move Soon* sensor**, tripped a few minutes before each move. It is
  a motion sensor because HomeKit gives an accessory no way to send a
  notification and a sensor is the one thing the Home app will offer to notify
  about; turning that on is a one-time step in the Home app that nothing here
  can do for you.
- **The settings page checks the pairs of values the schema cannot.** A warning
  that is not shorter than the interval, a sitting height above the standing
  one, and a working-hours entry that is not a time range are all said while
  they are being typed, rather than in the Homebridge log after a restart where
  nobody is looking.
- **A warning of 0 turns the warning off** and takes the *Desk Move Soon*
  sensor out of the Home app with it. A motion sensor that can never report
  motion is a thing in somebody's house that does nothing and cannot be
  explained.
- **Moving the desk by hand restarts the timer**, which makes a nudge on the
  handset the snooze: the warning says it is about to move, you touch the
  handset, and you have another interval.

### Changed

- **Slider targets are allowed to settle before one is acted on.** A drag is
  dozens of them, and each taken literally meant stopping the desk, waiting out
  its coast and handing it somewhere new. Seven targets now make one command.
- **A target the desk is already at is not a move.** The Home app sends the
  current position the moment the slider is touched, and the desk was setting
  off towards where it already was — the small movement before the real one.
- **The settings page says less, and says it once.** Field hints had grown into
  paragraphs and the sit/stand section said the same thing twice. What was cut
  is in the README, where the long version belongs.
- **The dongle is no longer described as advertising under one particular
  name.** It carries whatever name the desk was given in the Eliot app, which
  on many units is nothing useful. The scan always matched the service UUID
  instead, which does not depend on what anybody called it.

## [1.4.0] — 2026-09-21

### Changed

- **Eco mode now means travel speed 20**, not 28. 28 was where the Eliot app
  stops offering, which turned out to be a fact about the app rather than the
  control box — the desk here was found storing 21, a value no version of the
  app could have written, and took 21 back without complaint. Eco mode that is
  barely slower than no eco mode is not worth resetting a desk to switch on.
- **Switches are called what they are** — *Memory 1*, *Child Lock* — instead of
  carrying the desk's name in front of them. The Home app already shows which
  accessory a switch belongs to, and *Schreibtisch Memory 1* said it twice.
  Switches named by an earlier version are renamed on the next start, but only
  where the name is still exactly what that version wrote: anything else is
  yours, including a rename that happens to begin with the desk's name.

## [1.3.0] — 2026-09-21

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
- **The settings page is in English throughout.** It had drifted into half
  German and half English, one setting at a time.

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

[Unreleased]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.11.0...HEAD
[1.11.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.6.3...v1.7.0
[1.6.3]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/rummeyer/homebridge-eliot-smart-control/compare/v1.2.0...v1.3.0
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
