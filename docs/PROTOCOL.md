# Eliot desk protocol

Notes on the protocol this plugin speaks. Verified on hardware — see the status
table for what is measured and what is still inferred.

**Verified 2026-09-18** against an Eliot desk with a Smart Dongle, from a
Raspberry Pi 5 running BlueZ 5.66, using `tools/eliot-probe.js ask`.

## Status

| Layer | Claim | Verified? |
|---|---|---|
| Hardware | Lierda `LSD4BT-E95ALSP001`, firmware `v1.13.Dec 14 2022`, hardware `Rev13` | **Yes**, read from GATT |
| BLE | Transparent serial bridge on service `FE60`, write `FE61`, notify `FE62` | **Yes** |
| Framing | Jiecang handset protocol, `F1 F1 … 7E` | **Yes**, 9 report frames decoded |
| Height | uint16 big-endian, millimetres | **Yes**, 880 mm read while the desk stood at 88 cm |
| Absolute move | No such command; must be closed-loop | Inferred — no `goto` seen, none documented |

## The dongle

It advertises as **`Schreibtisch`** with a random-static address. That is worth
knowing: there is no vendor name, no Texas Instruments OUI and no `FFE0` to
search for, which is what made it hard to find. Search by name.

The vendor's blog describes a CC2541, and that is out of date — this dongle is a
Lierda module. `FE60` is Lierda's SIG-assigned service.

| Characteristic | Flags | Use |
|---|---|---|
| `FE61` | write, write-without-response | Bytes towards the control box |
| `FE62` | notify | Bytes from the control box |
| `FE63` | write, write-without-response, notify | Unidentified |
| `FE64` | write, write-without-response, notify | Unidentified |

Device Information (`180A`) is mostly placeholder text — manufacturer name reads
literally `Manufacturer Name` and the serial number reads `Serial Number`. The
model, revisions and System ID are real; the PnP vendor ID is `0x2717`, which is
Xiaomi's and is certainly a leftover default in the module firmware.

## Measured on this desk

    memory 1    801 mm        physical max   1285 mm
    memory 2   1204 mm        physical min    642 mm
    memory 3   1000 mm        soft max       1280 mm
    memory 4      0 mm        soft min        700 mm
    height      880 mm        (unset)

Both soft limits are set (`LIMIT_FLAGS = 0x11`), so the usable travel is
700–1280 mm. That range, not the physical one, is what HomeKit's 0–100% maps
onto: 0% is the minimum the desk is configured to allow, 100% the maximum. The
plugin must read these at startup rather than assume them, and re-read them,
because the desk lets you change both from the handset.

## Where the hypothesis comes from

Eliot's own founder [describes the dongle][blog] as a TI CC2541 whose job is to
"set the commands of the iOS and Android app onto the serial interface of the
control box", with the real intelligence in the box. The control box has had
two serial ports for years: **HS** for the handset or Smartcontroller, and **F**
for the Bluetooth controller.

Two things follow. First, a CC2541 in that role is almost always a transparent
BLE-to-UART bridge — the HM-10 class of module, service `FFE0`, characteristic
`FFE1` — which means there is no Eliot-specific Bluetooth protocol to break,
only a serial protocol to identify. Second, a control box with a handset port
plus a separate dongle port is the Jiecang pattern, and that protocol is
documented: [phord/Jarvis][jarvis] reverse-engineered it from a Fully Jarvis,
and [Rocka84/jiecang_desk_controller][rocka] implements it for ESPHome. Jarvis
calls the two ports RJ-45 (handset) and RJ-12 (dongle) and notes that the dongle
port answers a narrower set of reports — which is the port we are on.

Both guesses held, one of them for the wrong reason: the framing is Jiecang's,
but the radio module is a Lierda, not the CC2541 the blog names.

[blog]: https://sahlmann.tech/smartfurniture-eliot-mit-bluetooth-steuerung/
[jarvis]: https://github.com/phord/Jarvis
[rocka]: https://github.com/Rocka84/jiecang_desk_controller

## Framing

    [ADDR] [ADDR] [CMD] [LEN] [PARAMS…] [CHK] [EOM]

| Field | Bytes | |
|---|---|---|
| `ADDR` | 2 | Same value twice. `F1` from the handset or dongle, `F2` from the control box |
| `CMD` | 1 | Command or report code |
| `LEN` | 1 | Number of parameter bytes |
| `PARAMS` | `LEN` | Payload |
| `CHK` | 1 | `(CMD + LEN + PARAMS…) & 0xFF` |
| `EOM` | 1 | Always `0x7E` |

**`0x7E` is not escaped and does occur in payloads.** A height of 115.0 cm
encodes as `04 7E`, so a parser that scans for the terminator loses every height
report from a desk parked at a normal standing height. `FrameReader` in
`src/eliot/protocol.ts` reads `LEN` instead and validates the checksum; the
ESPHome implementation takes the scanning approach and says in a comment that it
breaks on exactly this.

## Commands (handset → control box)

| Name | CMD | Params | |
|---|---|---|---|
| `RAISE` | `01` | 0 | Raise one step |
| `LOWER` | `02` | 0 | Lower one step |
| `PROGMEM_1` | `03` | 0 | Store current height as memory 1 |
| `PROGMEM_2` | `04` | 0 | Store current height as memory 2 |
| `MOVE_1` | `05` | 0 | Move to memory 1 |
| `MOVE_2` | `06` | 0 | Move to memory 2 |
| `SETTINGS` | `07` | 0 | Request settings; on the dongle port the desk answers `25 26 27 28` and `01` |
| `RANGE` | `0C` | 0 | Request physical travel range; answered by `07` |
| `UNITS` | `0E` | 1 | `00` cm, `01` inches |
| `MEM_MODE` | `19` | 1 | `00` one-touch, `01` constant-touch |
| `COLL_SENS` | `1D` | 1 | `01` high, `02` medium, `03` low |
| `LIMITS` | `20` | 0 | Request soft limits |
| `SET_MAX` | `21` | 0 | Set soft max to current height |
| `SET_MIN` | `22` | 0 | Set soft min to current height |
| `LIMIT_CLR` | `23` | 1 | `01` clear max, `02` clear min |
| `PROGMEM_3` | `25` | 0 | Store current height as memory 3 |
| `PROGMEM_4` | `26` | 0 | Store current height as memory 4 |
| `MOVE_3` | `27` | 0 | Move to memory 3 |
| `MOVE_4` | `28` | 0 | Move to memory 4 |
| `WAKE` | `29` | 0 | Poll a control box that has gone quiet |
| `CALIBRATE` | `91` | 0 | Height calibration; desk must be at its lowest. **Leaves the desk in RESET mode** |

## Reports (control box → handset)

| Name | CMD | Params | |
|---|---|---|---|
| `HEIGHT` | `01` | 3 | `{P0,P1}` height, big-endian. `P2` seen as `07` here, `0F` elsewhere; meaning unknown |
| `RANGE` | `07` | 4 | `{P0,P1}` upper, `{P2,P3}` lower. Observed `05 14 02 8A` = 1300 mm / 650 mm |
| `UNITS` | `0E` | 1 | `00` cm, `01` inches |
| `MEM_MODE` | `19` | 1 | |
| `COLL_SENS` | `1D` | 1 | |
| `LIMIT_FLAGS` | `20` | 1 | bit 0 max set, bit 4 min set |
| `LIMIT_MAX` | `21` | 2 | Soft max height |
| `LIMIT_MIN` | `22` | 2 | Soft min height |
| `LIMIT_STOP` | `23` | 1 | Limit reached. **Not sent on the dongle port** |
| `POSITION_1..4` | `25`–`28` | 2 | Memory heights, in answer to `07` |
| `RESET` | `40` | 0 | Control box in RESET mode |
| `REP_PRESET` | `92` | 1 | Moving to a preset. **Not sent on the dongle port** |

The settings block that `CONNECT` answers with adds `0D`, `0E`, `0F`–`19`, `1A`,
`1C`–`1E` and `23` as report codes; see below for which of those have a meaning.
Codes `05`, `06` and `04` appear as answers to requests and have never been
decoded — `04` is the one that arrives in place of the height when a second
commander is fighting for the connection.

## Height units

Heights are a big-endian uint16 in tenths of the display unit: millimetres with
the display in centimetres, hundredths of an inch with it in inches. The plugin
works in millimetres and never writes `UNITS`, so it must read the current
setting rather than assume it. Jarvis's rule of thumb — 240–530 means inches,
650–1290 means millimetres — is a fallback, not a substitute.

## Measured dynamics

From four test moves on the verified desk, loaded with a normal desk's worth of
equipment:

| | |
|---|---|
| Travel speed | ~22 mm/s, both directions |
| Coasting after the last step | 17 mm up, 19 mm down |
| Height reports while moving | every 100–300 ms, unprompted |
| Landing accuracy | ±3 mm once the stopping distance is calibrated |

**The control box reports height on its own while the desk moves.** Nothing has
to poll for it, which is what makes the `lost` stopping condition meaningful:
silence during a move is a real fault, not the normal state of affairs.

The coasting figure is measured from the last height reported before the final
pulse to where the desk came to rest, so it absorbs report lag as well as
momentum. That is why `approachMm` is a measurement rather than a calculation.

One consequence worth stating plainly: **the desk cannot make a move shorter
than its stopping distance.** Asking for 10 mm when it needs 18 mm to stop can
only produce hunting, so the controller arrives without sending anything. In
HomeKit terms roughly 3% is the finest step that actually moves the desk, and a
smaller request will leave the reported position where it was.

## Memory positions

`MOVE_1`, `MOVE_2`, `MOVE_3` and `MOVE_4` hand the whole job to the control
box, and it does it better than the step commands allow: sent **once**, it runs
its own ramp and eases into the stored height. Verified on hardware — 878 mm to
998 mm against a stored 1000 mm, with the reported height slowing from 5 mm per
report to 1 mm as it arrived.

**A memory move can be cancelled by any step command.** Also verified: a move
from 1203 mm towards 801 mm stopped at 1148 mm after a single `LOWER`, 347 mm
short, coasting the usual ~12 mm. This is presumably the same mechanism that
lets a handset press interrupt one. There is no dedicated stop command, and
this is the closest thing to one.

Send the cancelling step in the direction the desk is already travelling. If a
control box were ever to ignore it, the cost is one extra step the way it was
already going rather than a lurch the other way.

An unset memory reports a height of `0`, which no desk could be at; treat it as
absent rather than as a destination.

## Two commanders at once

Tested with a person holding the handset against a move this plugin had
started. The control box gives the handset priority and simply stops: it does
not fight, oscillate, or split the difference. Height reports keep coming; they
just stop changing.

    6.3s  1151 mm   move begins, towards 920 mm, downwards
    9.9s  1084 mm   handset pressed the other way
   12.4s  1082 mm   2 mm in 2.5 s — the desk is standing still
   12.8s  1078 mm   released; the move carries on
   14.3s  1044 mm   handset pressed and held
   17.2s            stalled — the loop gives up after 3 s of no progress
   18.5s  1052 mm   pulses stop, and the handset gets its way

Two things follow, both of which the plugin already handles. Nothing has to be
forced apart, because the control box will not drive against a person. And
`stalled` is the correct response rather than a fault to be worked around: the
loop stops asking, and the target is set to where the desk actually is, so it
makes no later attempt to overrule whoever was at the handset.

A consequence of the 3-second stall window that is worth knowing: a *brief*
handset press pauses a move rather than cancelling it, and the move resumes
when the button is released. Only sustained resistance ends it.

## Commands the published write-ups do not have

Read out of the Eliot Android app (`com.eliot` 1.0, React Native, so the
command table is plain JavaScript) and then verified against the desk. The
first two matter most: without them this plugin drove the desk by repeating
step commands and could not stop it properly.

| Name | CMD | Params | |
|---|---|---|---|
| `GOTO_HEIGHT` | `1B` | 2 | Drive to a height, big-endian millimetres. **Verified**: 802 → 900 mm against a target of 902, landing 2 mm out, on one command |
| `STOP` | `2B` | 0 | Stop now. **Verified**: sent 108 mm into a move, halted after 13 mm of coasting |
| `LOW_POWER` | `18` | 1 | `0` off, `1` on. **Verified stored**; takes effect only after a reset — see below |
| `MOTION_MODE` | `19` | 1 | `0` one touch, `1` hold the button. **Corrected 21.09.2026, verified on hardware 22.09.2026** — see below |
| `VELOCITY` | `13` | 1 | Travel speed; the app offers 28, 31, 35, 38, 40. **Verified stored**; found at 21, below anything the app offers — see below |
| `SENSITIVITY` | `1D` | 1 | Anti-collision: `1` high, `2` medium, `3` low. **Verified stored**: 2 → 3 → 2, each read back; takes effect at the next reset — see below |
| `LOCK` | `1F` | 1 | Child lock: `0` reads the state, `1` toggles it. **Verified** |
| `PUT_LIMIT_MAX` | `21` | 2 | Set the soft maximum to a height |
| `PUT_LIMIT_MIN` | `22` | 2 | Set the soft minimum to a height |
| `LIMIT_CLEAR` | `23` | 1 | Clear limits: `0` both, `1` max, `2` min |
| `VERSION` | `1C` | 0 | Control box firmware version |
| `CONNECT` | `FE` | 0 | **Reads the whole settings block.** Not decoration — see below |

`GOTO_HEIGHT` is only sent once when the desk is in one-touch mode
(`MOTION_MODE = 0`). In hold mode the app repeats it on an interval, which is
worth knowing before exposing that setting to anyone: turning one-touch off
takes away the desk's ability to drive itself anywhere.

**Correction, 21.09.2026.** This table had `MOTION_MODE` the wrong way round —
`0` as hold and `1` as one touch — and the sentence above inherited it. The
app's own command table has both frames written out, and the parameter and its
checksum settle it:

```
MOTION_PRESS: F1 F1 19 01 00 1A 7E      one touch is 0
MOTION_HOLD:  F1 F1 19 01 01 1B 7E      hold is 1
```

Its reader agrees, in two places: `case '19'` maps `0` to `ONE_TOUCH` and `1`
to `CONSTANT_TOUCH`.

**Measured against the control box, 22.09.2026.** The desk was found holding
`19 01`, and the handset was in hold mode — its owner noticed before this code
did. The plugin wrote `F1 F1 19 01 00 1A 7E`, byte for byte the app's
`MOTION_PRESS`, and one-touch was back **at the handset** — a press sends the
desk on its way instead of having to be held. So the mapping is no longer read
out of the app alone: `0` is one touch on real hardware, and the setting
reaches the buttons, not just the commands.

**And it bites at once.** No reset happened between the write at 10:57:39 and
the confirmation. That sets `MOTION_MODE` apart from `VELOCITY` and
`LOW_POWER`, which sit in the same settings block and stay dormant until a
reset, as does `SENSITIVITY`. `MOTION_MODE` is so far the only field in this
block known to bite on the spot, which is worth remembering before assuming
the block behaves one way: three of its fields wait for a reset and one does
not.

**And the consequence, measured the same day.** With `19 00` in force, one
`GOTO_HEIGHT` and nothing else:

```
11:15:04  moving to 50% (990 mm) from 799 mm
11:15:04  → F1 F1 1B 02 03 DE FE 7E
          799 → 836 → 880 → 924 → 968 → 989 mm
11:15:12  move ended: arrived at 989 mm
```

190 mm in eight seconds, about 24 mm/s, stopping a millimetre short. So the
sentence at the top of this section is not a reading of the app any more: in
one-touch mode a single `GOTO_HEIGHT` carries the desk, and that is what the
plugin depends on.

The wrong version was believed because it seemed to have been confirmed: with
`00` stored the desk moved 10 mm on a `GOTO_HEIGHT` and stopped, which looks
exactly like hold mode. That was the `SETTINGS` poll described below, not the
motion mode, and the same afternoon produced two other conclusions of the same
shape.

**The app writes to service `FF12`, characteristic `FF01`** — not the `FE60`
this dongle exposes. It targets an older generation. The frame layer is
evidently unchanged, since this desk answers commands from both sets, but that
is the reason each one above was checked here rather than taken on trust.

### What the control box will tell you about itself

**Correction, 19.09.2026.** This section used to say "almost nothing", and that
was wrong — the question had simply never been asked the right way. Asked over
the dongle port, the box reports height, the four memory positions, the travel
range, the soft limits, the child lock, *and its entire settings block*. The
command that fetches the last of those is `CONNECT`, described below.

The child lock is still the one setting that answers its own command:

    → F1 F1 1F 01 00 20 7E     ask
    ← F2 F2 1F 01 00 …         unlocked
    → F1 F1 1F 01 01 21 7E     toggle
    ← F2 F2 1F 01 01 …         now locked

Note that `1F` is a **toggle**, not a setting: asking for the state it is
already in would flip it. Param `0` asks, param `1` flips, and both answer with
the state afterwards, so nothing has to be assumed.

The app does keep its own copy of the speed and the eco setting on the phone,
and that copy is not merely a cache: **it is written to the desk whenever the
app connects.** Observed on 19.09.2026, over a single afternoon, with nothing
but the app being opened in between, the desk moved from `VELOCITY 21` to `40`
to `35` and back to `21`. Anything this plugin writes can be overwritten by a
phone in the room, which is the argument for reading settings back rather than
remembering them.

### `CONNECT` reads the settings block

`FE` takes no parameters and is answered with one frame per setting, each
reusing the code of the command that writes it. Captured on 19.09.2026:

    → F1 F1 FE 00 FE 7E
    ← F2 F2 0D 01 02 …      undecoded
    ← F2 F2 0E 01 00 …      UNITS, cm
    ← F2 F2 0F 01 00 07 …   undecoded
    ← F2 F2 10 02 02 7B …   635, undecoded
    ← F2 F2 11 02 02 8A …   650, undecoded
    ← F2 F2 12 02 00 9C …   156, undecoded
    ← F2 F2 13 01 15 …      VELOCITY, 21
    ← F2 F2 14 01 4B …      75, undecoded
    ← F2 F2 15 01 2D …      45, undecoded
    ← F2 F2 16 01 64 …      100, undecoded
    ← F2 F2 17 01 01 …      undecoded
    ← F2 F2 18 01 01 …      LOW_POWER, on
    ← F2 F2 19 01 00 …      MOTION_MODE
    ← F2 F2 1C 01 0A …      VERSION
    ← F2 F2 1D 01 02 …      SENSITIVITY, medium
    ← F2 F2 1E 01 01 …      undecoded
    ← F2 F2 1A 01 00 …      undecoded
    ← F2 F2 23 04 21 92 0A 0B …  undecoded

`VERSION` asked on its own answers a single byte, `1C 01 0A`, and nothing else.
The block only comes from `CONNECT`, which is why the app brackets its
configuration writes with it: it is reading back what it just wrote.

Writes do **not** need the bracket. `VELOCITY` was taken bare from 21 to 40 and
`LOW_POWER` bare from 1 to 0, both confirmed by reading the block afterwards.

### Speed and eco: stored immediately, effective after a reset

An earlier version of this file claimed these two commands "do nothing here".
They do. What they do not do is take effect straight away.

The measurements that produced that claim stand: `VELOCITY` at 40 and 28 over
the same 220 mm in the same direction gave **22.6, 22.4, 22.4 mm/s**, and
`LOW_POWER` off, on and off gave **22.2, 22.4, 22.6 mm/s**. What was missing is
the step the app performs and this plugin did not: the Eliot app warns, when
either setting is changed, that **the desk must be reset before the change
takes effect**. Reported by the desk's owner on 19.09.2026, and consistent with
what followed — eco switched off in the app, a reset performed, and the desk
observably faster afterwards.

**A reset does make them bite; that much is now established.** On 21.09.2026
`LOW_POWER 1` and `VELOCITY 21` were stored on a desk visibly running eco off at
40, a reset was performed, and the desk came back slow. The settings block is a
record of what the box has been *told*, and the box goes on running what it was
last reset with — which is why it can report a value the desk is plainly not
using.

**And the effect is large.** Measured 21.09.2026, same tool, same 220 mm, same
direction, one reset between the two runs:

| | `GOTO_HEIGHT` | stepped `RAISE` |
|---|---|---|
| `LOW_POWER 1`, `VELOCITY 21` | **22.6 mm/s** | 9.0 mm/s |
| `LOW_POWER 0`, `VELOCITY 40` | **42.4 mm/s** | 23.9 mm/s |

The `GOTO_HEIGHT` column is the honest one — the box running its own ramp, which
is how anything unattended moves this desk. It very nearly doubles.

The stepped column is included only to show it moves the same way. Pulsed travel
is dominated by the pulse cadence and the box's ramp restarting, so those
numbers measure the method as much as the desk and should not be compared with
anything but each other.

This also explains why the question stayed open so long. Every earlier attempt
measured 22.2–22.6 mm/s whatever it set, and concluded the commands did nothing.
They were all measured without a reset in between, on a box that was still
running whatever it had last been reset with — which was `VELOCITY 21`, so they
were measuring the same configuration every time and getting, correctly, the
same number.

One trap for that measurement, learned the hard way: **do not hold the plugin
off the dongle by killing its child bridge in a loop.** Homebridge restarts it
within seconds, so a kill every two seconds produces a fresh competitor for the
dongle's single connection every two seconds. The symptoms are a control box
that answers queries, accepts every command, moves nothing, and streams `04`
where the height report belongs — which looks exactly like a desk that has lost
its calibration, and is not one.

### `SENSITIVITY` is the box's own brake, and it takes a write

`1D` is the control box's anti-collision threshold: `1` high, `2` medium, `3`
low. It is the box deciding by itself that something is in the way, and it is a
different thing from the stall check in this plugin, which only notices
*afterwards* that the desk has stopped.

**One stop that is still not explained.** On 22.09.2026 at 09:47 the desk's
owner rested their arms lightly on the desk during an automatic move. The box
stopped after nine millimetres — `801 → 810 mm` — and the plugin reported
`stalled` 1.5 s later. The trace shows one command going out, the
`GOTO_HEIGHT` itself, and no poll during the move, so nothing in the plugin
ended it.

This was written up here as the box's anti-collision, which was too quick. The
desk was also holding `MOTION_MODE = 01` at the time, and a nine-millimetre
nudge is exactly what hold mode produces — see the `MOTION_MODE` section. Four
things differ between that run and the one at 11:15 that drove 190 mm without
complaint: the motion mode, this setting, a reset in between, and whether
anybody's arms were on the desk. One run cannot separate four variables.

So this stop is evidence that the box stopped itself, and nothing more
specific. Repeating the 09:47 conditions — arms resting, one `GOTO_HEIGHT`, now
at `low` — is the test that would say whether this setting is the one that
matters, and it has not been done.

**Verified stored, on this hardware, 22.09.2026.** With the plugin disabled so
the dongle was free:

```
    read   1D 01 02      medium, what the box was holding
    write  1D 01 03      low
    read   1D 01 03      taken
    write  1D 01 02      back to medium
    read   1D 01 02      taken
```

The round trip works in both directions and the box reports the new value
immediately.

**It takes effect at the next reset, not before.** Tested by the desk's owner
on 22.09.2026, after this file had spent the day saying the question was open.
Tested again on 23.09.2026 with 1.7.0, with the same result: the change only
arrives with a reset.
So it behaves like `VELOCITY` and `LOW_POWER`, which share this block, and not
like `MOTION_MODE`, which bites on the spot.

Which means a change here is a promise about the desk's behaviour after its
next re-home — the plugin's log and the settings page both say so, and they are
right to.

### When the box streams its height, and when a poll cancels the move

The control box streams `HEIGHT` frames, several a second, for as long as it is
driving itself — a `GOTO_HEIGHT`, a memory position. It says nothing at all
while it is being walked up by repeated `RAISE` or `LOWER`, because then it is
not driving, it is being pushed.

**A `SETTINGS` poll during a self-driven move cancels the move.** `0x07` is a
command like any other, and the box abandons what it was doing to answer it. At
a 400 ms poll interval a `MOVE_n` covers about ten millimetres and stops.

This is worth stating plainly because the failure is so convincing. On
21.09.2026 a poll was added to three tools here on the theory that the box never
reported its height unprompted — which is true of step-driven movement and
false of everything else. Every `MOVE_n` and `GOTO_HEIGHT` then produced the
same ~10 mm nudge, on a desk whose handset worked perfectly, and the afternoon
went into motion modes, resets and a mains power cycle looking for the cause.
The settings block was byte-for-byte identical before and after. The cause was
the poll.

So:

- A move the box drives: send it, then listen. Do not send anything.
- A climb on step commands: poll, or measure nothing.
- Idle: poll, at the leisurely interval `idlePollSeconds` describes.

The plugin was never affected. It polls every 30 s while idle and listens
during a move, which is the right shape by construction.

### A box that has lost its zero answers everything except its height

Observed 22.09.2026, with a before and an after. The control box stopped
reporting `HEIGHT` altogether: the 30-second `SETTINGS` poll kept coming back
with `25 26 27 28` and no `01`, the full `CONNECT` block still arrived
complete, limits and range still answered, and **no `0x40` was ever sent**. The
handset showed RESET. After the owner re-homed the desk, `01` came back on the
very next poll, reading `02BC` — 700 mm, the soft minimum, which is where a
re-homed desk lands.

So a box without its zero is not quiet and not broken-looking. It is talkative
about everything it still knows and silent about the one thing it does not, and
`0x40` is not the way to find out — asking for a height and getting nothing is.

For anything built on this, that silence is worth treating as its own state
rather than as a dropped link: they look identical from a distance and want
opposite responses.

### There is no reset command

The app's *Automatischer Reset* is not a protocol command at all. Its own
warning says what it does: *"Der Tisch wird selbstständig auf eine Höhe von ca.
64 cm fahren"* — 64 cm being this desk's physical minimum of 642 mm. It drives
to the bottom so the control box can find its zero again. Soft limits and
memory positions survive it. `0x91 CALIBRATE` from the Jarvis notes appears
nowhere in the app.

**`0x91` was tried, on 21.09.2026, and does nothing observable.** Sent to a
healthy desk it produces no answer, no `0x40`, and no change on the handset,
with the link held open for 45 s. It was briefly believed to work: it was first
sent to a box that had lost its zero, whose handset was already showing RESET
and asking to be re-homed, and the two were mistaken for cause and effect.

The re-home itself is done by hand and cannot be triggered from here: run the
desk to the bottom and keep holding the down key until it re-seats. That works
without the app.

## The consequence for HomeKit

**Correction, and it invalidates what follows.** There *is* a move-to-height
command, `GOTO_HEIGHT` above, and a `STOP`. The section below describes the
first implementation, which repeated step commands because the published
write-ups have neither. It is kept because the step loop still exists as a
fallback for control boxes that do not know `GOTO_HEIGHT`, and because the
measurements in it are real.

The handset protocol as published only has
step-up, step-down and the four memory positions. Continuous movement is the
handset repeating `RAISE` or `LOWER` roughly twice a second; the desk stops when
the repeats stop.

So a HomeKit `TargetPosition` cannot be handed to the desk — the plugin has to
close the loop itself: work out the direction, repeat the step command, watch
the `HEIGHT` reports, and stop on arrival. That puts the responsibility for
stopping in our code, which needs:

- a travel timeout, so a desk that stops reporting does not get driven forever
- an abort if `HEIGHT` reports stop arriving mid-move
- a stall check — if height has not changed across several reports, stop
- overshoot tolerance, since the desk coasts after the last step

The control box keeps its own anti-collision detection, and the soft limits set
on the desk still apply. Neither is something the plugin should rely on as its
only brake.
