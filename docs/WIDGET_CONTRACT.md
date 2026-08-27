# Rise widget contract

The five sensor widgets (Step, Distance, Silence, Movement, Sunset) have no access to the
JavaScript runtime. They are `AppWidgetProvider`s that wake up, read a blob out of
`SharedPreferences`, and inflate `RemoteViews`. Everything they know about a habit arrives
through that blob. This document defines it.

The machine-readable definitions live in two files that must be changed together:

- `src/services/WidgetContract.ts`
- `android/app/src/main/java/com/rise/WidgetContract.kt`

There is no compiler checking that those two agree, because `SharedPreferences` is an
untyped string bag. If you rename a key in one and not the other, widgets silently fall
back to their empty state — which is the intended failure mode, but it is still a bug.

## Why the rewrite

The previous implementation bound habits to widgets by guessing at their titles
(`lowerTitle.includes('sunset') || lowerTitle.includes('phone') || ...`), then discarded
whatever goal and unit the user had configured and substituted hardcoded ones
(`goal = habit.numericGoal || 10000; unit = 'STEPS'`). Renaming a habit broke its widget;
two habits with similar names fought over one slot. Separately, the noise sensor wrote
progress into `numericProgress` while the widget read it from `timerProgress`, so silence
never appeared to accrue. The contract exists to make that class of mismatch impossible to
introduce quietly.

## Storage

One prefs file, `RiseWidgetPrefs`, holds every key. Three of them matter here.

`sensorData` is written only by JavaScript and is authoritative for identity, goals, units
and completion. `sensorRuntime` is written only by `SensorForegroundService` and carries
live values while the app is closed. `pendingOps` is written only natively, when the user
taps a widget control with no JS running, and is drained and cleared by JavaScript on next
foreground.

Ownership is strict in both directions. The service never writes identity or goals; JS never
writes runtime. The renderer merges them with `WidgetContract.readSlot`, which takes the
larger of the two progress values so that a stale runtime overlay can never walk a habit's
progress backwards.

## Slots

A *slot* is one widget's reserved seat, and exactly one habit may occupy it. The five slots
are `pedometer`, `gps`, `noise`, `movement` and `screen`. Binding is by `templateId` first,
falling back to an exact `sensorType` match — never by inspecting the title.

| templateId | slot | habit type | canonical unit |
| --- | --- | --- | --- |
| `step_legend` | `pedometer` | numeric | steps |
| `city_glider` | `gps` | numeric | kilometres |
| `deep_silence` | `noise` | timer | seconds |
| `immediate_rise` | `movement` | check | — |
| `digital_sunset` | `screen` | numeric, inverse | minutes used |

`sensorData` puts each slot at the top level of the object, alongside a `_meta` key holding
`version`, `syncedAt` and `loggedIn`. Any key beginning with an underscore is metadata: when
iterating slots, skip it. This keeps room for future metadata without a schema migration.

Each slot carries `exists`, and when true also `id`, `templateId`, `title`, `habitType`,
`progress`, `goal`, `unit`, `step`, `displayMode`, `goalDirection`, `isCompleted`, `streak`,
`controls`, `live` and `note`. When `exists` is false the widget renders its `+ LINK HABIT`
empty state, which deep-links to `rise://add-sensor-habit/{templateId}` so the tap lands on
the right template rather than a generic list.

`displayMode` tells the renderer how to format the number: `int` prints it whole, `distance`
switches between metres and kilometres at the 1 km mark, `duration` converts seconds to whole
minutes, and `sunset` promotes `note` to the primary status line. `unit` is still the user's
own string — the renderer uppercases it for display and only overrides it in the one case
where the unit genuinely changes with magnitude (metres versus kilometres).

## Inverse goals

Digital Sunset is the only habit where a lower number is better, so `goalDirection` exists to
say so. The default, `atLeast`, means `progress >= goal` completes the habit. `atMost` means
staying under `goal` completes it, and completion cannot be decided mid-window — you have not
yet succeeded at not using your phone. During the window the status badge reads `HOLDING`
while `progress <= goal` and `BROKEN` once it is exceeded; completion is committed either when
the user confirms from the widget or when the window closes with the allowance intact.

Anything in the store that compares progress against a goal must consult `goalDirection`, or
Digital Sunset will complete itself the moment you exceed your own screen-time limit.

## Controls

`controls` is an ordered list drawn left to right; the renderer supports `dec`, `inc`,
`check`, `timer`, `confirm`, `slipped` and `refresh`. Which ones a habit gets follows from
its type: numeric habits get `dec` and `inc` sized by `step`, timer habits get `timer`,
check habits get `check`, and Digital Sunset gets `confirm` and `slipped`. This mirrors the
controls on the in-app habit detail screen, which was the point of the exercise.

Every control fires a `PendingIntent.getBroadcast` carrying `ACTION_WIDGET_CONTROL` with the
op, habit id, slot and amount as extras. Broadcasts, not activities: the old implementation
used `PendingIntent.getActivity` with a `rise://habit-action/...` deep link, which meant
every button press launched the app to change a number. The receiver now applies the change
to `sensorRuntime`, redraws immediately, and enqueues a `pendingOp` for JS to reconcile
later. The card body still opens `rise://item/{habitId}/habit`, so tapping the widget itself
behaves as before.

`pendingOps` entries carry an `opId`, and JavaScript must ignore an `opId` it has already
applied. Without that, a drain interrupted midway replays increments on the next foreground.
Native trims the queue to the most recent 200 entries so a long offline stretch cannot grow
the prefs blob without bound.

## Live updates

`updatePeriodMillis` cannot go below 30 minutes and the old value was 24 hours, so widgets
only ever refreshed when foreground JavaScript happened to push. `SensorForegroundService`
replaces that: it owns the hardware step counter, the unlock receiver, the ambient noise
sampler and the location watch, writes `sensorRuntime`, and broadcasts `ACTION_WIDGET_UPDATE`.
The `live` flag on a slot tells the renderer the service is currently feeding it, which is
what distinguishes a genuinely idle counter from a dead one.

Step counting uses the hardware `Sensor.TYPE_STEP_COUNTER`, which reports a cumulative total
since boot rather than since midnight; the service stores a daily baseline and subtracts it.
The accelerometer magnitude heuristic remains only as a fallback for devices without the
hardware counter. Note that `react-native-pedometer` is iOS-only — it ships no Android source
and does not appear in the generated `PackageList.java` — so on Android the JS-side
`NativeModules.Pedometer` is always undefined and must not be relied on.

## Digital Sunset verification

Verification degrades in three tiers, chosen at runtime by what the user has granted.
`usagestats` reads real post-cutoff screen time via `UsageStatsManager` and requires the
`PACKAGE_USAGE_STATS` special access grant, which cannot be requested with a normal runtime
permission dialog and must be sent to Settings. `unlocks` counts device unlocks after the
cutoff using a runtime-registered `ACTION_USER_PRESENT` receiver and needs no permission at
all. `manual` is self-reported through the widget's confirm and slipped buttons.

The window defaults to 22:00 through 06:00 with a five-minute allowance, all three
configurable per habit and mirrored into `sensorConfig` for the service to read.
