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
| `MOTION_MODE` | `19` | 1 | `0` hold the button, `1` one touch |
| `VELOCITY` | `13` | 1 | Travel speed; the app offers 28, 31, 35, 38, 40. **Verified stored**; found at 21, below anything the app offers — see below |
| `SENSITIVITY` | `1D` | 1 | Anti-collision: `1` high, `2` medium, `3` low |
| `LOCK` | `1F` | 1 | Child lock: `0` reads the state, `1` toggles it. **Verified** |
| `PUT_LIMIT_MAX` | `21` | 2 | Set the soft maximum to a height |
| `PUT_LIMIT_MIN` | `22` | 2 | Set the soft minimum to a height |
| `LIMIT_CLEAR` | `23` | 1 | Clear limits: `0` both, `1` max, `2` min |
| `VERSION` | `1C` | 0 | Control box firmware version |
| `CONNECT` | `FE` | 0 | **Reads the whole settings block.** Not decoration — see below |

`GOTO_HEIGHT` is only sent once when the desk is in one-touch mode
(`MOTION_MODE = 1`). In hold mode the app repeats it, which is worth knowing
before exposing that setting to anyone: turning one-touch off takes away the
desk's ability to drive itself anywhere.

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

What is **not** established is how much faster it gets. Every speed figure taken
that day (24.3, 16.8, 12.1 mm/s) was measured by pulsing `RAISE`, in three
different and partly unknown drive states, and none of them is comparable to
another or to the 22.2–22.6 mm/s of the earlier runs. A number worth recording
needs `GOTO_HEIGHT`, where the box runs its own ramp — and that needs a control
box that will drive itself, which this one stopped doing (see below).

One trap for that measurement, learned the hard way: **do not hold the plugin
off the dongle by killing its child bridge in a loop.** Homebridge restarts it
within seconds, so a kill every two seconds produces a fresh competitor for the
dongle's single connection every two seconds. The symptoms are a control box
that answers queries, accepts every command, moves nothing, and streams `04`
where the height report belongs — which looks exactly like a desk that has lost
its calibration, and is not one.

### The control box never reports its height unprompted

Not while moving, not after a command, never. `SETTINGS` (`0x07`) is answered
with a `HEIGHT` frame, and that is the only way a height arrives.

This was assumed the other way round for a long time, and it is written into
`idlePollSeconds` as "the desk reports by itself while moving". It does not.
Every tool here that drove the desk without polling was measuring blind: it
watched a height that never changed and concluded the desk had not moved. One
of them concluded that for forty-five seconds while pulsing `RAISE`, and drove
the desk into its top stop hard enough to cost it its calibration.

Anything that drives this desk must poll, and must refuse to drive when it has
no height to poll for.

### Unsolved: the control box stopped driving itself

On the morning of 21.09.2026 this desk drove itself. One `MOVE_1` at 08:23:14
and it arrived at 802 mm twelve seconds later, with nothing else sent in
between — the log shows the single frame. By that evening the same command
moved it six millimetres and stopped, and so did `GOTO_HEIGHT`. It has not
driven itself since.

`MOTION_MODE` (`0x19`) is the obvious suspect and does not survive the
evidence. The Jarvis notes give `0` as hold-to-move and `1` as one-touch, and
one-touch is what makes a box drive to a position unattended:

| when | stored `0x19` | `MOVE_n` over the dongle |
|---|---|---|
| before any reset | `0` | drove fully |
| after reset 1 | `0` | nudge, ~10 mm |
| after reset 2 | `1` | nudge |
| after a mains power cycle | `1` | nudge |
| after reset 3 | `1` | nudge |

Neither value predicts the behaviour. Reset 3 demonstrably committed the rest
of the block — the desk came back slow, from the eco and velocity stored before
it — so the stored `1` was made live and self-driving still did not return.

Other things observed the same day, none of them explained:

- `0x18` read back as `1` after a mains power cycle, having been `0` before it,
  with nothing written in between. The stored block is not as stable as the
  rest of these notes assume.
- Between the first reset and the last, the box twice lost its zero and
  streamed `0x04` where the height belongs. Both times it was being driven by
  repeated step commands.
- A handset re-home restores the zero. Whether it commits the stored block was
  not established; reset 3, which the box itself asked for, did.

What has not been tried is the app's *Automatischer Reset*, which writes the
phone's stored configuration to the desk before resetting it. That is the one
operation known to have produced a self-driving desk, and the difference
between it and a hand re-home is the most promising place to look next.

Until this is understood, a plugin cannot assume `GOTO_HEIGHT` will drive a
desk that answered it yesterday. The step fallback is not a legacy path for old
control boxes; it is what keeps this one working.

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
