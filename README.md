<p align="center">
  <img src="https://raw.githubusercontent.com/rummeyer/homebridge-eliot-smart-control/main/docs/icon.png" alt="" width="120" height="120">
</p>

<h1 align="center">homebridge-eliot-smart-control</h1>

<p align="center">
  Your <b>Eliot sit-stand desk</b> in the Apple Home app &mdash; over Bluetooth, with no account and no cloud.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-eliot-smart-control"><img src="https://img.shields.io/npm/v/homebridge-eliot-smart-control?label=npm" alt="npm"></a>
  <a href="https://github.com/rummeyer/homebridge-eliot-smart-control/actions/workflows/build.yml"><img src="https://github.com/rummeyer/homebridge-eliot-smart-control/actions/workflows/build.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/rummeyer/homebridge-eliot-smart-control/blob/main/LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence"></a>
  <img src="https://img.shields.io/badge/homebridge-%E2%89%A5%202.0.0-purple" alt="Homebridge 2.0.0+">
  <img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-green" alt="Node 22, 24 or 26">
</p>

<p align="center">
  <a href="https://github.com/sponsors/rummeyer"><img src="https://img.shields.io/badge/donate-GitHub%20Sponsors-yellow" alt="Donate with GitHub Sponsors"></a>
  <a href="https://paypal.me/rummeyer"><img src="https://img.shields.io/badge/donate-PayPal-yellow" alt="Donate with PayPal"></a>
  <a href="https://buymeacoffee.com/rummeyer"><img src="https://img.shields.io/badge/donate-Buy%20Me%20a%20Coffee-yellow" alt="Buy Me a Coffee"></a>
</p>

---

## What it looks like in the Home app

**The desk itself**, as a slider from 0 to 100%.

0% is the lowest height your desk is set to allow and 100% the highest. Those
come from the desk, not from this plugin, so if you change the limits on the
handset the ends of the slider follow.

*"Hey Siri, set the desk to 100%."* Or put it in an automation: up for the
morning meeting, down at the end of the day.

**Your memory positions**, as buttons &mdash; the same ones as on the handset.
Press one and the desk goes there; the button springs back, the way a scene
does. Only positions you have actually stored appear.

**The child lock**, as a switch. It shows the desk's real state, so if someone
locks it at the handset the Home app knows.

Everything follows the desk, not just the other way round. Use the handset and
the Home app keeps up. A desk out of range says *No Response* rather than
showing you the height it had an hour ago.

## What you need

| | |
|---|---|
| **Desk** | An Eliot with the Smart Dongle, or the Procontroller |
| **Homebridge** | 2.0.0 or newer, **on Linux** |
| **Node.js** | 22.18, 24 or 26 |
| **Range** | Homebridge has to stay within Bluetooth range of the desk |

**Linux only.** The plugin talks to BlueZ over D-Bus, and macOS and Windows
have no equivalent. A Raspberry Pi running Homebridge is the usual home for it.
In a container, mount the host's `/var/run/dbus/system_bus_socket`.

**One connection at a time.** The dongle accepts a single Bluetooth connection.
While Homebridge has it, the Eliot app on your phone cannot connect — and while
the app has it, this plugin cannot.

## Setting it up

**1. Install it.** In the Homebridge UI, go to **Plugins**, search for
`homebridge-eliot-smart-control` and choose **Install**.

**2. Give it a child bridge.** In the plugin's **⋮** menu, choose **Bridge
Settings** and turn the child bridge on. Bluetooth links drop and reconnect;
in a child bridge that churn stays in its own process instead of unsettling
your other accessories.

**3. Find your desk.** Open the plugin's **Settings** and press **Scan for
desks**.

This is the part worth having help with. The dongle does not announce itself:
it advertises under whatever name the desk was given in the Eliot app, carries
no manufacturer name, and many units have nothing printed on them — in a scan
list it sits among forty anonymous phones with nothing to tell them apart. The
page looks for the Bluetooth service the desk actually speaks, so a result
marked *confirmed* is the right device and not a good guess.

Press **Use this** next to yours, name it, and save.

*Nothing found?* Something else probably has it. Close the Eliot app and turn
Bluetooth off on any phone that has been paired with the desk, then unplug the
dongle for five seconds.

**4. Add it to the Home app.** The child bridge has its own QR code under
**Bridge Settings**. Scan it the same way you paired Homebridge itself.

## Settings

| | | |
|---|---|---|
| **Name** | required | What the desk is called in the Home app |
| **Dongle address** | required | Filled in for you by the scan |
| **Idle refresh** | 30 s | How often to ask a standing desk for its height. It reports by itself while moving, so this only catches the handset being used. 0 turns it off |
| **Memory switches** | on | Offer your stored positions as buttons. Rename them in the Home app |
| **Child lock switch** | on | Offer the desk's child lock |
| **Eco mode** | leave alone | Eco mode and travel speed, as a pair. Takes effect only after the desk is reset by hand |
| **Automatic sit/stand** | off | Move between two heights on a timer, during configured hours |
| **Ask again each day** | off | Switch auto movement off at the end of each day, so it only runs on days you turn it on |

Or by hand, in `config.json`:

```json
{
  "platform": "EliotSmartControl",
  "desks": [
    {
      "name": "Desk",
      "mac": "E5:11:22:33:44:55",
      "ecoMode": "off"
    }
  ]
}
```

## Automatic sit/stand

Configure it, and the desk gains an **Auto Movement** switch. Nothing moves
until you turn that on — the switch is the feature's on/off, so that turning it
off is somewhere obvious rather than in a config file.

Once on, inside the hours you have set, the desk alternates between your
sitting and standing heights. It always heads for whichever of the two it is
further from, so a desk parked halfway still does the right thing.

**A break between two windows pauses the timer.** With 08:00–12:00 and
13:00–16:00, whatever is left at noon is still left at 13:00, and the slider
holds still over lunch. If the desk would move within the warning time, it
waits for the warning first. Overnight does not count as a break: each
morning starts a full interval.

**Moving the desk yourself restarts the timer.** That is the snooze: when the
warning says it is about to move and you are mid-call, nudge the desk with the
handset and you have bought another interval. It is also simply true — the
timer measures time spent at a height, and that clock restarts when the height
does.

**The countdown is on show, as a slider.** Auto movement brings a **Timer**
with it — a light whose brightness is how much of the interval is left before
the next move. It fills to 100% when you switch auto movement on and runs down
from there; a handset nudge or a move fills it again.

Dragging it is how you change the wait, and nothing else about it: halfway
means half an interval left, all the way up buys a fresh one. **All the way
down moves the desk now**, and skips the warning — you just asked for the move,
so being told it is coming would be late. With auto movement off the slider
sits at 0 and stays there, because there is no countdown to show. Set
`timerSlider` to `false` if you would rather not have it.

**Getting told about it takes one step you have to do yourself.** HomeKit gives
a plugin no way to send a notification, so the warning is a motion sensor
called **Desk Move Soon**. Open it in the Home app, and under *Status and
Notifications* turn notifications on. Nothing here can do that for you, and if
you never do it the feature still works, silently.

Outside the configured hours nothing moves and no warning is raised — a phone
buzzing at 17:05 about a move that will never happen is worse than silence.

**Ask again each day** turns the switch off at the end of the day, so it means
"move me today" rather than "move me from now on". Without it the switch is a
standing instruction, which is right for a desk used the same way every day and
wrong for one that is not: a week away, and it has been cycling an empty room
for five days. The day is remembered rather than timed, so a restart at 23:59
does not hand it a fresh one.

## When the desk stops by itself

The control box has its own anti-collision detection, and on a sensitive
setting it does not take much: arms resting on the desk can be enough to end a
move a centimetre in. The plugin then reports the move as `stalled`, which is
accurate — the desk did stop — but says nothing about why, because from the
outside a desk stopped by an obstruction and a desk stopped for any other
reason look identical.

`collisionSensitivity` sets that threshold: `high`, `medium`, `low`, or `leave`
to keep whatever the desk came with, which is the default. It is written to the
control box when it differs from what the box is holding, once per connection.

**It takes effect after the desk is reset by hand** — run it to the bottom and
hold the down key until it re-homes. Until then the desk keeps its old setting,
the same way travel speed and eco mode do. And the setting belongs to the desk
rather than to this plugin, so it stays changed until something changes it
back.

## Things worth knowing

**Positions land exactly.** The desk is handed a height and drives there on its
own ramp, easing in and stopping within a couple of millimetres — the same
mechanism as the memory buttons on the handset.

**Stopping works, and coasts about 13 mm.** There is no instant brake on a desk.

**Using the handset during a move is safe.** The control box gives the handset
priority and stops; it never drives against you. A brief press pauses the move
and it carries on, holding the button ends it, and the Home app settles on
wherever the desk actually is rather than trying again.

**An unset memory gets no button.** If you store a new position on the handset,
its button appears the next time the plugin connects.

**Rename the switches in the Home app.** They arrive as *Memory 1*…*Memory 4*
and the plugin names them only once, when it first creates them, so whatever
you rename them to survives restarts.

**Eco mode is stored now and takes effect later.** The control box keeps
running whatever it was last reset with, so the settings it reports back can
differ from the speed it is visibly travelling at. A reset by hand — run the
desk to the bottom and hold the down key until it re-homes — is what makes a
stored setting live. No command over this connection can do it.

**The idle refresh is only for what happens between moves.** The control box
streams its height for as long as it is driving itself, so nothing needs asking
then. It is also why the poll must stay in seconds: a request arriving while
the box is moving makes it abandon the move, which looks exactly like a desk
that stops a centimetre after it starts.

**The desk's own safety features are untouched.** Anti-collision and the soft
limits live in the control box. The plugin adds limits of its own on top: it
gives up if the desk stops making progress, if a move takes longer than the
distance can account for, or if the desk stops saying where it is.

## When something is wrong

**The scan finds nothing.** Close the Eliot app and turn Bluetooth off on any
phone that has been paired with the desk — closing the app does not always
release the connection, and the dongle will not advertise while something holds
it. Then unplug it for five seconds; it advertises immediately on power-up.

**It connects, then drops.** Check the signal. The settings page shows it beside
each result and warns when it is weak; anything near -90 dBm comes and goes.
Move Homebridge closer, or put a second one near the desk.

**A dongle that stays silent while plugged in and powered is broken.** Obvious
written down, indistinguishable from a range problem in practice, and worth
ruling out early by trying another one. It cost a day here.

**The tile shows nothing, or its room cannot be changed.** Restart the Home
app, and the phone if that is not enough. The Home app keeps its own copy of
what an accessory offers, and updating the plugin can change that — new
switches, a sensor, a characteristic that was not there before. Until the app
refetches it, the tile can sit blank or refuse to be edited while the plugin is
publishing perfectly good values. Seen twice on one afternoon of changes, and
resolved by restarting the app both times.

**Installing or updating prints a wall of `npm ERR!` and works anyway.** That
is `usocket`, an *optional* native dependency of `dbus-next`, which reaches
here through `node-ble`. Its build uses a version of `node-gyp` too old for
Node 22 and fails with `Cannot assign to read only property 'cflags'`. Because
it is optional, npm reports the failure and carries on, and nothing here needs
it — `dbus-next` falls back to its own socket implementation, which is what
this plugin has always run on. There is nothing to fix at this end; the noise
comes from two dependencies further down.

**"No D-Bus system bus"** means BlueZ is not reachable: you are not on Linux, or
you are in a container without `/var/run/dbus/system_bus_socket` mounted.

**Everything looks right but nothing moves.** Check the dongle is in the port
marked **F** on the control box, not **HS** — that one is for the handset.

## How it works

The Smart Dongle is a Lierda `LSD4BT-E95ALSP001` presenting a transparent
Bluetooth-to-serial bridge; behind it the control box speaks the Jiecang
handset protocol. None of that was written down anywhere for this desk, so
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) writes it down now: the framing, the
command set, the measured travel speed and stopping distance, what the app's
*Automatischer Reset* really does, and which parts are verified against
hardware rather than assumed. Including the commands that turned out to do
nothing, which is worth knowing too.

Credit where it is due: the serial protocol was reverse-engineered for other
desks by [phord/Jarvis](https://github.com/phord/Jarvis) and
[Rocka84/jiecang_desk_controller](https://github.com/Rocka84/jiecang_desk_controller).
Working out that an Eliot speaks it, what the Bluetooth side looks like, and
the several commands those write-ups are missing is what this project added.

## Licence

MIT
