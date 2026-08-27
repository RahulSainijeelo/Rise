# Rise — Widget & Sensor Overhaul: Verification Checklist

Everything checkable without an Android toolchain has been checked and passes.
What remains needs a real Gradle build and a device. Work top to bottom; stop at
the first failure and paste the error back rather than letting it be inferred.

## 1. Build (this is the one that matters)

```bash
cd android && ./gradlew :app:assembleDebug --console=plain
```

This settles every Kotlin question the sandbox could not: unresolved references,
type mismatches, `when` exhaustiveness, nullability. Twelve Kotlin files were
added or rewritten, so expect this to be where any remaining defect shows up.

Highest-risk spots if it fails:

- `SensorWidgetRenderer.kt` — colours are `private val`, not `const val`, because
  `0xFFD71921.toInt()` is not reliably a compile-time constant. If the compiler
  disagrees with that reasoning in either direction, this is the line.
- `SensorForegroundService.kt` — `foregroundTypes()` uses `FOREGROUND_SERVICE_TYPE_HEALTH`,
  which is API 34+. Confirm it is behind an SDK_INT guard the compiler accepts.
- `WidgetContract.kt` — `@JvmStatic`/`@JvmOverloads` on `readSlot` with a defaulted
  `expectedDate` parameter.

Then:

```bash
./gradlew :app:lintDebug
```

Read only the manifest and foreground-service warnings; the rest is pre-existing noise.

## 2. Install and smoke-test each widget state

For each of the five sensor widgets (Steps, Distance, Silence, Movement, Sunset):

- [ ] **Empty state** — widget with no linked habit shows `+ LINK …` and tapping it
      deep-links to the add-habit screen for the right template.
- [ ] **Progress state** — shows the habit's *real* title and unit, not a hardcoded
      string. This was the original "hard coded" complaint.
- [ ] **Controls** — the button row matches what the in-app habit page offers for that
      habit type (numeric → −/+, timer → timer/done, inverse goal → held/slipped).
      Tapping a button mutates in place and does **not** open the app.
- [ ] **Card body** — tapping the card (not a button) opens HabitDetail.
- [ ] **Completed state** — the dot-matrix animation flips through 6 frames on a
      ~2.4 s loop.

## 3. Live updates

- [ ] Grant the sensor permissions, then background the app. Walk. Step widget
      advances **without** reopening the app (this is the foreground service).
- [ ] Check the service notification: it should be a white glyph, not a grey blob.
      (`ic_stat_rise.xml` was added for exactly this.)
- [ ] Toggle a habit in the app → the habit heatmap widget redraws immediately.
      This was broken until now: `HabitControlWidget` never declared
      `com.rise.WIDGET_UPDATE`, so it only redrew on the host's own schedule.

## 4. Digital Sunset

- [ ] Open the Digital Sunset habit detail. If usage access is not granted, a
      `GRANT USAGE ACCESS` row appears; tapping it opens Settings, and returning
      makes the row disappear (it re-checks on AppState `active`, since returning
      from a Settings page is not a navigation event).
- [ ] With access granted, verification should read real post-cutoff screen minutes;
      without it, it should fall back to unlock counts, then to manual confirm/slipped.

## 5. The two date bugs worth actively trying to break

- [ ] **Stale overlay.** Force-stop the app before midnight with a non-zero step
      count, then reopen after midnight. Today must read 0, not yesterday's total.
      (Overlays are now date-stamped and discarded when the date does not match.)
- [ ] **Midnight window.** Tap a Sunset control at ~01:00. The op must be filed
      against the *previous* evening's date, since the window opens at 22:00.

## 6. Known and deliberately left alone

- Two pre-existing type errors in `src/components/RiseLogoAnimation.tsx`
  (`style` prop on animated `G`/`Circle`) — unrelated to this work.
- 18 dead vector drawables `anim_*_frame{1,2,3}.xml`. Nothing references them; the
  release resource shrinker drops them. The sandbox could not delete them.
- `SIGTTIN`/`SIGTTOU` equivalents — n/a here, ignore.

## 7. If the build is clean

The remaining unknowns are all runtime/device behaviour, not correctness of the
contract: the JS↔native key agreement, resource resolution, RemoteViews setter
remotability, and PendingIntent request-code uniqueness were all verified
statically and pass.

---

# How to test the awkward parts

Use a **physical device** for anything sensor-related; the emulator has no step
counter. Debug build throughout, so `run-as` works.

## The single most useful debugging tool

The entire JS↔native contract is one SharedPreferences file. Read it directly:

```bash
adb shell run-as com.rise cat /data/data/com.rise/shared_prefs/RiseWidgetPrefs.xml
```

`sensorData` is what JS wrote, `sensorRuntime` is what the native service wrote,
`pendingOps` is the queue of widget taps not yet drained. If a widget shows the
wrong thing, diff these three before touching any code — it tells you which side
is wrong.

## Watch what the native side is doing

```bash
adb logcat -c    # clear first
adb logcat AndroidRuntime:E SensorForegroundService:V SensorWidgetRenderer:V HabitControlWidget:V '*:S'
```

Confirm the foreground service is alive and which types it claimed:

```bash
adb shell dumpsys activity services com.rise | grep -iE 'foreground|isForeground|fgsType'
adb shell dumpsys appwidget | grep -A3 com.rise
```

## Force a widget refresh without touching the app

This directly tests the `HabitControlWidget` manifest fix:

```bash
adb shell am broadcast -a com.rise.WIDGET_UPDATE -p com.rise
```

Every widget on the home screen must redraw, including the habit heatmap. Before
the fix the heatmap ignored this.

## Verify the control broadcast can't be forged

The fix is a per-install token, so the test is that a broadcast *without* one does
nothing. Pick a real habit id out of the prefs dump, then:

```bash
adb shell am broadcast -a com.rise.WIDGET_CONTROL -n com.rise/.StepWidget \
  --es extra_slot pedometer --es extra_habit_id <habitId> \
  --es extra_op inc --ed extra_amount 500
```

Expected: **nothing happens** — no progress change, no new entry in `pendingOps`.
If progress moves, `isTrustedControl` is not being consulted.

## Digital Sunset without waiting for 22:00

Grant and revoke usage access from the shell instead of the Settings UI:

```bash
adb shell appops set com.rise GET_USAGE_STATS allow   # real screen-time path
adb shell appops set com.rise GET_USAGE_STATS deny    # falls back to unlocks
```

With it denied, the `GRANT USAGE ACCESS` row must appear on the habit detail screen.
Also set the habit's cutoff to a couple of minutes from now in-app rather than
waiting for the evening, then drive lock/unlock cycles:

```bash
adb shell input keyevent KEYCODE_POWER   # sleep
adb shell input keyevent KEYCODE_POWER   # wake, then swipe to unlock
```

Unlock detection needs a real unlock (`ACTION_USER_PRESENT`), so swipe past the
keyguard — a bare screen-on does not count if a lockscreen is set.

## The two date bugs

These need the clock moved, which needs root on most devices. Practical path:
Settings → System → Date & time → turn **off** automatic, then set the date by hand.

**Stale overlay.** Accumulate a non-zero step count, then:

```bash
adb shell am force-stop com.rise
```

Advance the date by one day, reopen. Today must read **0**. Check the prefs dump:
the `sensorRuntime` entry should carry yesterday's `date` and be ignored, not merged.

**Midnight window.** With the sunset cutoff at 22:00, set the clock to ~01:00 and
tap a Sunset widget control. The resulting `pendingOps` entry must carry the
*previous* day's date, not the current one.

## Boot path

Worth one test because a `microphone`-typed foreground service cannot legally start
from the background, and boot is background:

```bash
adb shell am force-stop com.rise
adb shell am broadcast -a android.intent.action.BOOT_COMPLETED -p com.rise
```

Watch logcat for a `SecurityException` or `ForegroundServiceStartNotAllowed`. (This
broadcast is protected; if the shell refuses it, reboot the device instead.)

## What deserves real automated tests

The pure TypeScript logic is where the bugs actually were, and it needs no device:
`localDate`, `habitControls`, `habitStep`, `isInverseGoal`, and the store's
`derivesCompletion`/`applyCompletion` inverse-goal path. A small Jest suite over
those would have caught the date-rollover class of bug outright.

```bash
npx jest
```
