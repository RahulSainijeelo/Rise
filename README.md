<div align="center">

# RISE

**Minimalist Task Mastery | Atomic Habits | Real-Time Sensor Telemetry**

*Crafted with the Nothing OS aesthetic — dot-matrix typography, monochrome contrast, and dynamic micro-interactions.*

---

[![React Native](https://img.shields.io/badge/React_Native-0.76+-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactnative.dev/)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-D71921?style=for-the-badge)](LICENSE)

<br/>

<a href="https://github.com/RahulSainijeelo/Rise/releases/download/v2.0.0/app-release.apk">
  <img src="https://img.shields.io/badge/DOWNLOAD_LATEST-APK-D71921?style=for-the-badge&logo=android&logoColor=green" height="42" alt="Download APK" />
</a>

</div>

---

## Quick Download & Installation

### Option 1: Direct APK Download (Android)

1. Download the latest production APK from the [Releases Page](https://github.com/RahulSainijeelo/Rise/releases/latest).
2. Open the downloaded file (`Rise.apk`) on your Android device.
3. If prompted by Android, allow **"Install from unknown sources"** for your browser/file manager.
4. Tap **Install** and launch **Rise**.

<details>
<summary><b>Option 2: Installation via ADB (Command Line)</b></summary>
<br/>

If you have an Android device connected with USB Debugging enabled:

```bash
# Download latest release APK
curl -L -o Rise.apk https://github.com/RahulSainijeelo/Rise/releases/latest/download/Rise.apk

# Install to connected device
adb install -r Rise.apk
```

</details>

<details>
<summary><b>Option 3: Build & Install from Source</b></summary>
<br/>

```bash
# 1. Clone repository
git clone https://github.com/RahulSainijeelo/Rise.git
cd Rise

# 2. Install dependencies
npm install

# 3. Build and launch on connected Android device
npm run android
```

</details>

---

## Overview

Rise is a personal operating system designed to eliminate digital noise and foster intentional productivity. Combining the principles of Atomic Habits with hardware-level sensor verification and native Android home screen widgets, Rise turns daily routines into verified milestones.

---

## Key Features

### 1. High-Performance Task Engine
- **Normalized Relational Architecture**: Sub-millisecond rendering and zero-lag list manipulation, tested with hundreds of simultaneous tasks.
- **Organization**: Categorization, custom tags, subtask breakdowns, deadlines, and recurrence rules (daily, weekly, custom intervals).
- **Nothing-Inspired Interface**: Dot-matrix calendar view, dynamic priority badges, and fluid gesture handling.

### 2. Atomic Habits Framework
- **The 4 Laws of Behavior Change**: Define custom Cue, Craving, Response, and Reward loops for every habit.
- **Tracking Modes**:
  - `Check`: Binary daily commitments.
  - `Timer`: Focus sessions, meditation, and quiet counters.
  - `Numeric`: Quantitative tracking (water intake, pages read, repetitions).
- **Habit Heatmap**: 35-day contribution matrix tracking active days, streaks, and best streaks.

### 3. Hardware-Verified Sensor Habits
Eliminates self-reporting bias with real-time sensor verification:
- **Step Legend** *(Pedometer / Accelerometer)*: Tracks daily step cadence.
- **City Glider** *(High-Precision GPS)*: Measures verified travel and cycling distance.
- **Deep Silence** *(Decibel Meter / Audio Sensor)*: Measures minutes spent in quiet environments (< 45dB).
- **Immediate Rise** *(Kinetic Motion)*: Anti-snooze verification requiring physical movement upon waking.
- **Digital Sunset** *(Screen State)*: Bedtime wind-down habit verifying zero phone usage past curfew.

---

## Android AppWidgets Ecosystem (8 Native Widgets)

Rise provides 8 standalone Android home screen widgets built with native Kotlin `RemoteViews` and real-time SharedPreferences IPC:

| Widget | Purpose | Interactive Action Button | Animation / Visualizer |
| :--- | :--- | :--- | :--- |
| **Tasks Matrix** | Daily task tracker | Direct task completion checkboxes | Dynamic priority indicator |
| **Habit Control** | Pinned habit manager | Toggle habit status | 35-day dot matrix heatmap |
| **Task Timer** | Focus stopwatch | Play / Pause / Reset | Live ticking second hand |
| **Step Legend** | Pedometer tracker | `+100 STEPS` quick-add | Stride cadence pulse |
| **City Glider** | Distance tracker | `TRACK / SYNC` GPS refresh | Radar compass glider sweep |
| **Deep Silence** | Quiet session logger | `+5M SILENCE` quick-record | Serene soundwave equalizer |
| **Immediate Rise** | Anti-snooze motion | `RISE NOW` instant check | Kinetic lightning surge |
| **Digital Sunset** | Bedtime curfew | `WIND DOWN` curfew check | Setting sun horizon sequence |

### Dynamic Widget States
- **3-Frame Vector Animations**: Auto-looping dot-matrix visuals for in-progress habits.
- **Celebratory Completion State**: Transforms into an achievement starburst and trophy seal once 100% of the goal is achieved.
- **Zero-Latency Synchronization**: Direct store hooks push updates instantly from React Native to native widget receivers.

---

## Technical Stack

- **Framework**: React Native 0.76 (Fabric and TurboModules enabled)
- **Languages**: TypeScript 5.x and Kotlin (Native Bridge / RemoteViews)
- **State Management**: Zustand with custom normalized dictionary indices
- **Hardware & Telemetry**: `react-native-sensors`, `react-native-geolocation-service`, `react-native-sound-level`
- **Audio Engine**: `react-native-sound-player`
- **Notifications**: `@notifee/react-native`
- **Storage**: AsyncStorage and Encrypted SharedPreferences IPC

---

## Development Setup

### Prerequisites
- Node.js >= 18
- JDK 17+
- Android Studio & Android SDK (API 34)

### Local Development Commands

```bash
# 1. Install dependencies
npm install

# 2. Start Metro bundler
npm start

# 3. Run on Android device or emulator
npm run android
```

---

## Production Build

To build production APK and AAB binaries locally:

```bash
cd android

# Clean build cache
./gradlew clean

# Build Universal Release APK
./gradlew assembleRelease

# Build Google Play Bundle (AAB)
./gradlew bundleRelease
```

Generated binary locations:
- **APK**: `android/app/build/outputs/apk/release/app-release.apk`
- **AAB**: `android/app/build/outputs/bundle/release/app-release.aab`

---

## License

**Copyright (c) 2026 Rahul Saini (jeelo).**

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

Under this license:
- Anyone who modifies or distributes this software must disclose the complete source code under the same GPL-3.0 license.
- No closed-source, proprietary, or commercial forks may be created without preserving complete source disclosure and original author attribution.
- See the [LICENSE](LICENSE) file for the full legal terms and conditions.
