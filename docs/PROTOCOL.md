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

Codes `05`, `06`, `17`, `1C`, `1F` appear as answers to requests but have never
been decoded.

## Height units

Heights are a big-endian uint16 in tenths of the display unit: millimetres with
the display in centimetres, hundredths of an inch with it in inches. The plugin
works in millimetres and never writes `UNITS`, so it must read the current
setting rather than assume it. Jarvis's rule of thumb — 240–530 means inches,
650–1290 means millimetres — is a fallback, not a substitute.

## The consequence for HomeKit

**There is no "move to height X" command.** The handset protocol only has
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
