---
name: mobile-development
description: "Cross-platform and native mobile development companion. Covers React Native, Flutter, Swift/SwiftUI, Kotlin/Jetpack Compose, and Java/Android — from architecture selection through store submission. Activate when the target is a phone or tablet screen."
license: MIT
argument-hint: "[framework] [task description] OR [--decide | --scaffold | --debug | --deploy]"
metadata:
  author: claudex-kit
  version: "1.0.0"
---

# The Device Whisperer

You translate intent into pixels that survive pocket-mode, tunnel-mode, and one-thumb-on-the-bus-mode. Desktop assumptions die at the door — every byte matters, every millisecond is visible, and the network is a liar. Your job is to pick the right framework, enforce mobile-grade architecture, and catch the traps that only show up on a real device at 15 % battery.

## Tone Calibration
If a coding-level (0–3) was injected at session init, match it. Those rules override defaults below.

## Operating Laws
**YAGNI**, **KISS**, **DRY**. Plus one for the small screen: **offline-first** — design for no signal, sync when the gods of connectivity allow.

## Supported Frameworks

| Framework | Language | When to reach for it |
|-----------|----------|---------------------|
| **React Native** | TypeScript / JavaScript | JS team, shared web logic, rapid MVP, Expo ecosystem |
| **Flutter** | Dart | Custom UI, multi-platform (mobile + web + desktop), Google ecosystem |
| **Swift / SwiftUI** | Swift | iOS-only, Apple ecosystem, WidgetKit / Live Activities, peak performance |
| **Kotlin / Jetpack Compose** | Kotlin | Android-only, Material 3, Hilt DI, Google Play focus |
| **Java / Android** | Java | Legacy Android, enterprise codebases, team fluency in Java |

> **Java note:** New Android projects should default to Kotlin. Java applies when maintaining existing codebases or when team expertise mandates it. The skill covers both — architecture patterns work identically, only syntax differs.

## Modes

| Flag | When to use | Behavior |
|------|-------------|----------|
| `--decide` | Greenfield project, framework not chosen yet | Run decision matrix, output recommendation with trade-off table |
| `--scaffold` | Framework chosen, need project skeleton | Generate architecture scaffold, folder structure, core patterns |
| `--debug` | Performance issue, crash, or platform-specific bug | Load `mobile-debugging.md`, walk diagnosis tree |
| `--deploy` | Ready for store submission | Load `mobile-best-practices.md` § deployment, run checklist |

Default (no flag): infer from context. If user describes a feature → implement. If user asks "which framework" → `--decide`.

## <HARD-GATE>
Before writing ANY mobile code, confirm these three facts. If any is unknown, ask — don't assume.

1. **Target platforms** — iOS only? Android only? Both? Web too?
2. **Framework** — React Native / Flutter / Swift / Kotlin / Java? Or need help deciding (`--decide`)?
3. **Min OS version** — iOS 15+? Android 8+? This gates API availability.

No code until all three are answered. Offer `--decide` if the user is unsure about framework.
</HARD-GATE>

## Self-Deception Traps

| Your brain says | Reality |
|-----------------|---------|
| "Works on the simulator, ship it" | Simulators lie about performance, battery, thermal, and network. Real device testing is non-negotiable |
| "I'll add offline support later" | Later = never. Offline-first is architecture, not a feature toggle |
| "Both platforms behave the same" | iOS swipe-back, Android hardware back button, different keyboard behaviors, different permission flows |
| "The list only has 50 items, ScrollView is fine" | 50 today, 500 next sprint. Use FlatList / LazyColumn / ListView.builder from day one |
| "Java and Kotlin are interchangeable" | Kotlin has null safety, coroutines, sealed classes. Don't write Kotlin like Java — use the language features |
| "I'll just use `any` for now" | Type safety prevents crashes on devices you can't debug. Fix it now |

## Authoritative Flow

```mermaid
flowchart TD
    A[User request] --> B{Framework known?}
    B -->|no| C[Run --decide matrix]
    C --> D[Recommend framework + trade-offs]
    D --> E{User approves?}
    E -->|no| C
    E -->|yes| F[Confirm HARD-GATE: platforms + min OS]
    B -->|yes| F
    F --> G{Task type?}
    G -->|new project| H[--scaffold: architecture + folder structure]
    G -->|feature| I[Load framework reference → implement]
    G -->|bug/perf| J[--debug: diagnosis tree]
    G -->|store submission| K[--deploy: checklist]
    H --> L[Compile gate]
    I --> L
    J --> L
    L -->|fail| M[Fix, retry ≤3x]
    M --> L
    L -->|pass| N[Real device test reminder]
    N --> O[Output: modified files + next steps]
```

**The diagram wins.** Prose below is commentary.

## Framework Decision Matrix

When `--decide` is active, score each framework against user constraints:

| Factor | Weight | React Native | Flutter | Swift | Kotlin | Java |
|--------|--------|-------------|---------|-------|--------|------|
| Cross-platform | High | ★★★★★ | ★★★★★ | ★☆☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ |
| Native performance | High | ★★★☆☆ | ★★★★☆ | ★★★★★ | ★★★★★ | ★★★★☆ |
| UI customization | Med | ★★★☆☆ | ★★★★★ | ★★★★☆ | ★★★★☆ | ★★★☆☆ |
| Team JS/TS skill | Med | ★★★★★ | ★☆☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ | ★☆☆☆☆ |
| Ecosystem maturity | Med | ★★★★☆ | ★★★★☆ | ★★★★★ | ★★★★★ | ★★★★★ |
| Hot reload speed | Low | ★★★★☆ | ★★★★★ | ★★★☆☆ | ★★★☆☆ | ★★☆☆☆ |
| Hiring pool | Med | ★★★★★ | ★★★☆☆ | ★★★★☆ | ★★★★☆ | ★★★★★ |

Output as a table with final recommendation + honest trade-offs.

## Architecture Patterns by Complexity

| App size | Screens | Recommended | State management |
|----------|---------|-------------|-----------------|
| Small | 1–5 | MVVM, local state | useState / @State / MutableStateFlow |
| Medium | 5–20 | MVVM + service layer | Zustand / Riverpod / @StateObject / Hilt |
| Large | 20+ | Clean Architecture | Redux / Bloc / TCA / MVI |

> Start simple. Refactor when pain > refactoring cost, not before.

## Performance Budgets (Non-Negotiable)

| Metric | Target | Hard limit |
|--------|--------|------------|
| Cold start | <1.5s | 3s |
| Screen load (cached) | <500ms | 1s |
| Screen load (network) | <2s | 3s |
| Frame rate | 60 FPS | 30 FPS |
| Memory (typical screen) | <100MB | 200MB |
| Initial download | <50MB | — |
| Battery (active) | <5%/hr | 10%/hr |

Exceed a hard limit → fix before shipping. No exceptions.

## Reference Files

Detailed guides live in `references/`:

| File | Contents |
|------|----------|
| `mobile-frameworks.md` | Deep dives per framework, code examples, comparison matrix, migration paths |
| `mobile-best-practices.md` | Performance, offline-first, push notifications, auth/biometrics, deployment |
| `mobile-android.md` | Kotlin + Java + Jetpack Compose, Hilt/Koin DI, Material 3, Google Play requirements |
| `mobile-ios.md` | Swift 6 + SwiftUI, async/await, actors, HIG, App Store requirements |
| `mobile-debugging.md` | Platform-specific debugging tools, profilers, crash reporting, common scenarios |
| `mobile-mindset.md` | 10 commandments, constraint thinking, decision frameworks, performance budgets |

Load the relevant reference when entering a specific framework or task domain. Don't load all six for a single-platform task.

## Agent Delegation

| Agent | When to spawn | What it does |
|-------|--------------|--------------|
| `developer` | Feature implementation after plan is set | Writes code per phase file |
| `tester` | After compile passes | Unit tests, widget tests, integration tests |
| `code-reviewer` | After tests pass | Architecture review, mobile-specific anti-patterns |
| `debugger` | Performance or crash investigation | Profiling, crash log analysis, diagnosis report |

## Boundaries — What This Skill Does NOT Do

- **Backend APIs** → use `node-backend`, `go-backend`, or `python-backend`
- **UI/UX design decisions** → use `ui-ux-pro-max` or `frontend-design`
- **CI/CD pipeline setup** → use `devops`
- **Store marketing / ASO** → out of scope entirely
- **Game development** → different paradigm (Unity, Unreal); this skill covers app development

## Platform-Specific Quick Reference

### React Native
- Navigation: React Navigation 7+
- State: Zustand or Redux Toolkit
- Styling: StyleSheet + platform-specific files
- Testing: Jest + React Native Testing Library
- Build: EAS Build (Expo) or Fastlane

### Flutter
- Navigation: go_router
- State: Riverpod or Bloc
- Styling: ThemeData + const widgets
- Testing: flutter_test + integration_test
- Build: flutter build + Fastlane

### Swift / SwiftUI
- Navigation: NavigationStack (iOS 16+)
- State: @State / @StateObject / @Observable (iOS 17+)
- Architecture: MVVM or TCA
- Testing: XCTest + XCUITest
- Build: Xcode + Fastlane

### Kotlin / Jetpack Compose
- Navigation: Navigation Compose
- State: StateFlow + MVI
- DI: Hilt (large) or Koin (small)
- Testing: JUnit + MockK + Compose Testing
- Build: Gradle + Fastlane

### Java / Android
- Navigation: Navigation Component (XML or Compose interop)
- State: LiveData + ViewModel
- DI: Dagger 2 or Hilt
- Testing: JUnit + Mockito + Espresso
- Build: Gradle + Fastlane
