<p align="center">
  <img src="https://raw.githubusercontent.com/rummeyer/homebridge-eliot-smart-control/main/docs/icon.png" alt="" width="120" height="120">
</p>

<h1 align="center">homebridge-eliot-smart-control</h1>

<p align="center">
  Your <b>Eliot sit-stand desk</b> in the Apple Home app &mdash; over Bluetooth, with no account and no cloud.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-eliot-smart-control"><img src="https://img.shields.io/npm/v/homebridge-eliot-smart-control?label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/homebridge-eliot-smart-control"><img src="https://img.shields.io/npm/dt/homebridge-eliot-smart-control" alt="Downloads"></a>
  <a href="https://github.com/rummeyer/homebridge-eliot-smart-control/actions/workflows/build.yml"><img src="https://github.com/rummeyer/homebridge-eliot-smart-control/actions/workflows/build.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/rummeyer/homebridge-eliot-smart-control/blob/main/LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence"></a>
  <img src="https://img.shields.io/badge/homebridge-%E2%89%A5%202.0.0-purple" alt="Homebridge 2.0.0+">
  <img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-green" alt="Node 22, 24 or 26">
</p>

<p align="center">
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

**Your memory positions**, as switches &mdash; the same ones as on the handset.
A switch is on while the desk is at its position, however it got there: from
the Home app, from the memory key on the handset, or by the slider. Switch one
on and the desk goes there, and the switch stays on; if the move is called off
at the handset before it arrives, the switch goes back off. Switching it off
on the way stops the desk. Only positions you have actually stored appear.

**The child lock**, as a switch. It shows the desk's real state, so if someone
locks it at the handset the Home app knows.

**Automatic sit/stand**, as an **Auto Movement** switch, a **Timer** slider
counting down to the next move, and a **Desk Move Soon** sensor that warns
before it. See [Automatic sit/stand](#automatic-sitstand).

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
| **Memory switches** | on | Offer your stored positions as switches that show which one the desk is at. Rename them in the Home app |
| **Child lock switch** | on | Offer the desk's child lock |
| **Eco mode** | leave alone | Eco mode and travel speed, as a pair. Takes effect after a reset, which the plugin asks for |
| **Automatic sit/stand** | off | Move between two heights on a timer — see [below](#automatic-sitstand) for its settings |

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

The desk moves between your sitting and standing heights on a timer. The
**Auto Movement** switch in the Home app starts and stops it: nothing moves
while it is off, and it is off until you turn it on — so turning it off is
somewhere obvious rather than in a config file.

Each move heads for whichever of the two heights the desk is further from, so a
desk parked halfway still does the right thing.

| | | |
|---|---|---|
| **Sitting / standing height** | 800 / 1200 mm | The two heights it moves between |
| **Interval** | 30 min | How long at one height before moving to the other |
| **Warn before** | 5 min | How long before a move the **Desk Move Soon** sensor trips. 0 turns the warning off and removes the sensor |
| **Timer slider** | on | Show the countdown as a **Timer** slider |
| **Turn off at the end of the day** | off | Switch auto movement off when the day is over, so it only runs on days you turn it on |
| **Working hours** | none | When it may move, as `08:00-12:00`. None means any time |
| **Days** | Mon–Fri | Which days the working hours apply to. Only with working hours |
| **Action at the end of working hours** | do nothing | Move to standing or sitting height when the day's last working hours end. Only with working hours |

By hand, in `config.json`, inside the desk:

```json
"autoMove": {
  "sittingMm": 750,
  "standingMm": 1150,
  "intervalMinutes": 45,
  "windows": ["08:00-12:00", "13:00-17:00"],
  "switchOffDaily": true,
  "endOfDay": "standing"
}
```

### Working hours

**Without working hours, it may move at any time, on any day**, for as long as
the switch is on. The countdown carries on across midnight. Days and the
end-of-day action need working hours, and the settings page hides them until
there are some.

**With working hours, it moves only inside them, on the days you have
ticked.** Outside them nothing moves and no warning is raised — a phone
buzzing at 17:05 about a move that will never happen is worse than silence.
The countdown starts when a window opens rather than moving the desk then, so
it does not jump at 08:00 sharp before anyone has sat down.

**A break between two windows pauses the timer.** With 08:00–12:00 and
13:00–17:00, whatever is left at noon is still left at 13:00, and the slider
holds still over lunch. If the desk would move within the warning time, it
waits for the warning first. Overnight does not count as a break: each
morning starts a full interval.

### The timer

**Moving the desk yourself restarts the timer.** That is the snooze: when the
warning says it is about to move and you are mid-call, nudge the desk with the
handset and you have bought another interval. It is also simply true — the
timer measures time spent at a height, and that clock restarts when the height
does.

**The countdown is on show, as a slider.** The **Timer** is a light whose
brightness is how much of the interval is left before the next move. It fills
to 100% when you switch auto movement on and runs down from there; a handset
nudge or a move fills it again. Outside working hours it stands still — full,
or where lunch interrupted it.

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

### The end of the day

**Turn off at the end of the day** switches auto movement off when the day is
over, so the switch means "move me today" rather than "move me from now on".
The day is over when your working hours end — after the last window, not at
lunch — or at midnight if you have set none, or if you switched it on after
they ended. Without it the switch is a standing instruction, which is right for
a desk used the same way every day and wrong for one that is not: a week away,
and it has been cycling an empty room for five days. The switch-on time is
remembered, so a restart does not hand it a fresh day.

**Action at the end of working hours** moves the desk once when the day's
last window closes — to standing height, so the next morning starts on your
feet, or to sitting height, to have it out of the way. Only with auto movement
on and only on the configured days; not at a gap between windows, like lunch.
If the desk is out of reach at the close, the move still happens when it comes
back within a quarter of an hour, and not after that. A desk already there
stays put. With **Turn off at the end of the day** as well, the switch goes off
after this move.

### Sitting and standing time

While auto movement is running — switched on, and inside its working hours if
you have set any — the plugin counts how long the desk stood at sitting height
and how long at standing height. The rest of the time it counts nothing: a desk
left up overnight is not somebody standing overnight. Without working hours
only the switch tells the two apart, so turn it off when you leave, or let
**Turn off at the end of the day** do it at midnight.
Anything halfway between the sitting and standing heights or above counts as
standing.

The totals appear on the **Statistics** tab of the plugin's settings page in
the Homebridge UI — today, and the last 3, 7, 30 and 100 days, each as soon as
the record reaches back further than the span before it — and not in the Home
app, which has no sensor for a length of time. **Reset data** below the table
starts the count again; it asks once more on the button itself before deleting
anything. The totals are kept per day for 100 days, in
`eliot-stats-<address>.json` in the Homebridge storage directory, and written
every five minutes, so the page can trail the desk by that much.

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

**It takes effect after a reset**, the same way travel speed and eco mode do,
and the plugin puts the desk into reset mode when it writes it — see below. And the setting belongs to the desk
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

**An unset memory gets no switch.** If you store a new position on the handset,
its switch appears the next time the plugin connects.

**Rename the switches in the Home app.** They arrive as *Memory 1*…*Memory 4*
and the plugin names them only once, when it first creates them, so whatever
you rename them to survives restarts.

**A changed eco mode or sensitivity puts the desk into reset mode.** The
control box stores a new setting at once but keeps running whatever it was last
reset with, and a value stored without a reset is lost if the desk loses power.
So when the plugin writes one, it also switches the box to reset mode: the
handset shows RESET, and the desk ignores everything else — memory keys and the
Home app included — until you turn the handset left. It then drives to the
bottom, re-homes and comes back up, and the new setting is live. This happens
only when a setting actually changed, never on an ordinary reconnect. If the
desk is stuck in reset mode and you cannot do the reset now, unplug it.

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
