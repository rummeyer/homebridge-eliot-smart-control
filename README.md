<h1 align="center">homebridge-eliot-smart-control</h1>

<p align="center">
  Control your <b>Eliot sit-stand desk</b> from the Apple Home app &mdash; over Bluetooth, with no cloud and no account.
</p>

<p align="center">
  <a href="https://github.com/rummeyer/homebridge-eliot-smart-control/blob/main/LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence"></a>
  <img src="https://img.shields.io/badge/homebridge-%E2%89%A5%202.0.0-purple" alt="Homebridge 2.0.0+">
  <img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-green" alt="Node 22, 24 or 26">
</p>

---

## What you get

Your desk appears in the Home app as a **window covering**, with a slider from
0 to 100%:

- **0% is the lowest height the desk is set to allow**, 100% the highest. Those
  come from the desk's own limits, not from this plugin, so changing them on the
  handset changes what the ends of the slider mean.
- **It shows which way the desk is going** while it moves, and stops where you
  tell it to.
- **Siri**: *"Hey Siri, set the desk to 100%"*
- **Automations**: stand up for the morning meeting, sit down at the end of the
  day.

Alongside it, **the desk's own memory positions as switches** — the ones behind
the buttons on the handset. Press one and the desk goes there; the switch
springs back, the way a scene does.

Only memories the desk actually has appear. An unset one reports as zero, which
is not a height anything could be at, so no button is offered for it. Set one on
the handset and it shows up the next time the plugin connects.

These take a different route from the slider, and a better one: the control box
has a *go to memory* command of its own, so the desk runs its own ramp and eases
into the position, stopping within a couple of millimetres. The slider has no
such luxury — there is no *go to height X* in the protocol — so it is driven
step by step from here.

A covering rather than a light, deliberately. A light would join in with "turn
off all the lights" and with every bedtime scene — and off, for a desk, means
driving down to its lowest setting.

**It follows the desk, not just the other way round.** Use the handset and the
Home app keeps up. A desk that is out of range says *No Response* rather than
showing the height it had an hour ago.

**Nothing leaves your home.** No account, no cloud, no Eliot app required after
setup. The plugin talks to the Smart Dongle over Bluetooth.

## Before you start

| | |
|---|---|
| **Desk** | An Eliot with the Smart Dongle fitted, or the Procontroller |
| **Homebridge** | 2.0.0 or newer, on Linux |
| **Node.js** | 22.18, 24 or 26 |
| **Range** | The Homebridge host must be within Bluetooth range of the desk and stay there |

**Linux only.** The plugin talks to BlueZ over D-Bus; macOS and Windows have no
equivalent. A Raspberry Pi running Homebridge is the usual home for it. In a
container, the host's `/var/run/dbus/system_bus_socket` must be mounted.

**One connection at a time.** The dongle accepts a single Bluetooth connection.
While Homebridge holds it, the Eliot app on your phone cannot connect, and
vice versa — if the app is connected, this plugin will not get in.

## Step 1 — Install the plugin

In the Homebridge UI, go to **Plugins**, search for
`homebridge-eliot-smart-control` and choose **Install**.

## Step 2 — Give it a child bridge

In the plugin's **⋮** menu, choose **Bridge Settings** and turn the child bridge
on. Bluetooth links drop and reconnect; in a child bridge that churn stays in
its own process instead of unsettling your other accessories.

## Step 3 — Find your desk

Open the plugin's **Settings** and press **Scan for desks**.

This is the fiddly part done for you. The dongle does not announce itself
usefully: it advertises as **`Schreibtisch`**, with no manufacturer name, and
many units have no address printed on them — in a scan list it sits among forty
anonymous phones with nothing to tell them apart. The page looks for the
Bluetooth service the desk actually speaks, so a result marked *confirmed* is
the right device rather than a good guess.

Press **Use this** next to yours, give it a name, and save.

If nothing turns up, the usual cause is that something else has it: the dongle
takes one connection at a time, so close the Eliot app and turn Bluetooth off
on any phone that has been paired with the desk. Then unplug the dongle for
five seconds.

The same thing is available from the command line, in the plugin's directory:

```bash
node tools/find-desks.js
```

And this reads the desk's height, limits and memory positions to prove you have
the right one. It **does not move it**:

```bash
node tools/eliot-probe.js ask E5:11:22:33:44:55
```

## Step 4 — Or configure it by hand

In `config.json`:

```json
{
  "platform": "EliotSmartControl",
  "desks": [
    {
      "name": "Schreibtisch",
      "mac": "E5:11:22:33:44:55",
      "memoryNames": ["Sitzen", "Stehen", "Besprechung"]
    }
  ]
}
```

| setting | | |
|---|---|---|
| `name` | required | What the desk is called in the Home app |
| `mac` | required | Bluetooth address of the Smart Dongle |
| `idlePollSeconds` | default 30 | How often to ask a standing desk for its height. It reports by itself while moving, so this only catches the handset being used. 0 turns it off |
| `memorySwitches` | default on | Offer the desk's memory positions as switches |
| `memoryNames` | optional | What to call them, in order. Defaults to *Memory 1* … *Memory 4* |

## Step 5 — Add it to the Home app

The child bridge has its own QR code, under **Bridge Settings**. Scan it in the
Home app the same way you paired Homebridge itself.

## Things worth knowing

**About 3% is the finest step that moves the desk.** It needs roughly 18 mm to
come to a stop, so a request smaller than that can only produce hunting. The
plugin reports the move as done without sending anything, and the slider
springs back. This is the desk, not the plugin.

**Positions land within about 1%.** Once a move finishes, the reported position
snaps onto what you asked for, so the Home app settles instead of claiming to
be moving forever.

**There is no stop button in the protocol.** The desk moves because the plugin
keeps telling it to, and stops when that stops — so a stop still coasts the
same ~18 mm any move does.

**A memory move can be stopped**, even though the control box is driving it
itself. There is no stop command, but any step command cancels one — the same
thing that happens when you touch the handset mid-move. It then coasts to a
halt like any other move.

**Using the handset during a move is safe and does what you would expect.** The
control box gives the handset priority and stops — it never drives against you.
A brief press pauses the move, which then carries on; holding the button ends
it, and the Home app settles on wherever the desk actually is rather than
trying again.

**The desk's own safety features still apply.** Anti-collision and the soft
limits live in the control box and are untouched by this plugin, which adds its
own limits on top: it gives up if the desk stops making progress, if it takes
longer than the distance can account for, or if the desk stops reporting where
it is.

## Troubleshooting

**The scan does not find it.** Close the Eliot app, and turn Bluetooth off on
any phone that has been paired with the desk — closing the app is not always
enough to release the connection, and the dongle will not advertise while
something is connected. Then unplug the dongle for five seconds and plug it
back in; it advertises immediately on power-up.

**It connects, then drops.** Check the signal — the settings page prints it
beside each result, and warns when it is weak. Anything around -90 dBm is at
the edge of usable and will come and go. Move the Homebridge host closer, or
put a second one near the desk.

A dongle that is silent while plugged in and powered is simply broken. That
sounds obvious written down; in practice it is indistinguishable from a range
problem, and worth ruling out early by trying another one.

**"No D-Bus system bus"** means BlueZ is not reachable: you are not on Linux, or
you are in a container without `/var/run/dbus/system_bus_socket` mounted.

**Everything looks right but nothing moves.** Make sure the dongle is in the
port marked **F** on the control box, not the one marked **HS** — that one is
for the handset.

## How it works

The Smart Dongle is a Lierda `LSD4BT-E95ALSP001` presenting a transparent
Bluetooth-to-serial bridge; behind it the control box speaks the Jiecang
handset protocol. None of this was documented anywhere, so
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) writes it down: the framing, the command
set, the measured travel speed and stopping distance, and which parts are
verified against hardware rather than assumed.

Credit where it is due: the serial protocol was reverse-engineered for other
desks by [phord/Jarvis](https://github.com/phord/Jarvis) and
[Rocka84/jiecang_desk_controller](https://github.com/Rocka84/jiecang_desk_controller).
Working out that an Eliot speaks it, and what the Bluetooth side looks like, is
what this project added.

## Licence

MIT
