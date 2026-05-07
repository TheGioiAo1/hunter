# Mobile Debugging Reference

## Debugging Mindset

### Unique Mobile Challenges

1. **Device Diversity** — iOS versions, Android API levels, screen sizes, processor capabilities vary widely
2. **Resource Constraints** — Memory, battery, CPU are limited; behavior differs from desktop
3. **Network Variability** — Unstable connections, latency spikes, offline scenarios are common in the field
4. **Platform Differences** — OS-level APIs, permissions models, UI frameworks differ fundamentally
5. **Real Device Necessity** — Simulators mask hardware-specific bugs (camera, sensors, background behavior)
6. **Limited Production Access** — Debugging live users requires remote logging; can't attach debugger to production

### Golden Rules

1. **Reproduce locally first** — Use device logs, network inspector, memory profiler before guessing
2. **Check the basics** — Permissions, network connectivity, background state, lifecycle hooks
3. **Leverage platform tools** — Xcode Instruments, Android Profiler, DevTools are designed for this
4. **Test on real devices** — Simulator behavior diverges from production in battery, memory, network
5. **Narrow the scope** — Use conditional breakpoints and logpoints; avoid stopping on every line
6. **Think holistically** — Consider OS version, API level, device capability, network state together

---

## iOS Debugging

### Xcode Debugger (LLDB)

The debugger attaches via USB or network to live app instances.

**Essential LLDB Commands:**

```
po <expression>          # Print object description (calls -description)
p <expression>           # Print expression value with type info
bt                       # Print backtrace (call stack)
up / down                # Navigate stack frames
frame variable           # Show local variables in current frame
expr <var> = <value>     # Modify variable at runtime
c                        # Continue execution
n                        # Next line (step over)
s                        # Step into (step through function calls)
```

**Breakpoints:**

- **Conditional:** Right-click breakpoint → Edit Breakpoint → add condition (e.g., `user.id == 42`)
- **Watchpoints:** Set watchpoint on variable; debugger breaks when value changes
- **Exception Breakpoints:** Add breakpoint for all Objective-C exceptions or Swift errors
- **Symbolic Breakpoints:** Break on method name across all classes (e.g., `-[UIViewController viewDidLoad]`)

**View Debugging:**

- Runtime Inspector: Xcode menu → Debug → View Hierarchy; select elements in 3D view
- Inspect layout constraints: Expand view tree, check constraint violations in console
- Preview in Canvas: SwiftUI previews with live REPL interaction

**Console.app Log Filtering:**

1. Connect device or use simulator
2. Open Console.app (macOS Utilities)
3. Filter by process name or subsystem:
   ```
   process:MyApp subsystem:com.example
   ```

**Network Link Conditioner:**

- Install Additional Tools for Xcode → Network Link Conditioner.prefpane
- Simulate poor networks: 3G, LTE, offline, packet loss
- Test timeout handling, retry logic, UI responsiveness under latency

### Instruments

Launch from Xcode: Cmd+I or Debug → Simulate Performance.

**Key Instruments:**

- **Time Profiler:** Find CPU hotspots; see which functions consume CPU
- **Allocations:** Track heap growth; detect memory leaks via "Malloc Stack"
- **Leaks:** Automated leak detection (supplements Allocations)
- **Network:** Monitor HTTP/HTTPS requests, DNS resolution, connection reuse
- **CoreData:** Profile fetch requests, save operations, cache hits/misses
- **Metal System Trace:** GPU usage, shader compilation time

**Example Workflow:**

1. Xcode → Product → Profile (Cmd+I)
2. Select Time Profiler
3. Record action (scroll, animation, API call)
4. Stop recording; sort by "Self Weight" (time spent in that function)
5. Click on function → Source view shows hot lines

### View Debugging

**Layout Borders (SwiftUI):**
```swift
.border(Color.red)  // Visual debugging aid
Text("Debug").background(Color.yellow.opacity(0.3))
```

**Layout Bounds (UIKit):**
```objc
// In AppDelegate or view controller
[[UIView setAnimationsEnabled:NO];
[[UIView appearanceWhenContainedInInstancesOfClasses:@[[UIWindow class]]] 
    setBackgroundColor:[UIColor colorWithRed:1 green:0 blue:0 alpha:0.3]];
```

**View Tree Dump (LLDB):**
```
po [[UIApplication sharedApplication] keyWindow].recursiveDescription
```

---

## Android Debugging

### Android Studio Debugger

**Conditional Breakpoints:**

- Click breakpoint → Edit → Add Condition (e.g., `userId == 5`)
- Suspend policy: All threads, thread, or no suspend (logpoint)

**Logpoints (Non-Breaking Logging):**

- Right-click breakpoint → Convert to Logpoint
- Prints message without stopping; useful for tight loops
- Example: `User logged in: {user.name}`

**Exception Breakpoints:**

- Debug menu → Breakpoints → Exception Breakpoints
- Break on all exceptions, or filter by class

**Evaluate Expression (Cmd+F8):**

Modify variables mid-execution:
```
userId = 99
isLoggedIn = true
```

### Android Profiler

**Launch:** Android Studio menu → View → Tool Windows → Profiler

**CPU Profiler:**
- Sample or instrumented recording
- Flame chart shows call stack over time
- Identify long-running functions, thread contention

**Memory Profiler:**
- Heap snapshots: capture memory state
- Allocation tracking: see what allocated since snapshot
- Detect memory leaks via "memory leak" indicator
- Filter by class or package

**Network Profiler:**
- Monitor HTTP/HTTPS requests
- View request/response headers, body, timing
- Identify inefficient API calls, large payloads

**Example Workflow:**

1. Profiler → Memory tab
2. Capture heap dump (camera icon)
3. Filter by package name
4. Sort by "Allocations" (count)
5. Double-click class → see retained instances, GC roots

### Layout Inspector

**View:**
Android Studio → Layout Inspector (or Tools → Layout Inspector)

Shows real-time view hierarchy with:
- Dimensions, padding, margin
- Visibility, z-order
- Constraint layout information
- Text content

**Debug Layout Issues:**

Toggle layout bounds in Developer Options:
```
adb shell setprop debug.atrace.tags.enableflags 1
adb shell am broadcast -a android.intent.action.BOOT_COMPLETED
```

Or programmatically:
```kotlin
debugPaintSizeEnabled = true  // Compose
```

### ADB Commands

**View Logs:**
```bash
adb logcat | grep MyApp
adb logcat *:S MyApp:D  # Suppress all, show MyApp debug
adb logcat --clear      # Clear existing logs
```

**Install / Uninstall:**
```bash
adb install app-release.apk
adb uninstall com.example.myapp
```

**Screenshot / Screen Recording:**
```bash
adb shell screencap -p /sdcard/screen.png
adb pull /sdcard/screen.png
adb shell screenrecord /sdcard/video.mp4  # Press Ctrl+C to stop
```

**Package Info:**
```bash
adb shell pm list packages | grep myapp
adb shell dumpsys package com.example.myapp
```

**File Exploration:**
```bash
adb shell ls /data/data/com.example.myapp/databases/
adb pull /data/data/com.example.myapp/files/data.db
```

---

## React Native Debugging

### React DevTools

**Setup:**

```bash
npm install --save-dev react-devtools
npx react-devtools
```

In your app, connect to the DevTools window (automatic on dev server).

**Features:**

- Component tree inspection (props, state, hooks)
- Highlight renders
- Edit state/props in real-time
- Profiler: measure component render time

### Flipper

**Setup:**

1. Download Flipper Desktop
2. Install React Native plugin: Flipper → Plugins → install "React Native"
3. App connects automatically on debug build

**Features:**

- App logs aggregated in one place
- Network tab: HTTP/HTTPS requests
- Database: SQLite, Realm browser
- Preference: SharedPreferences (Android), UserDefaults (iOS)

### Chrome DevTools

**iOS (Hermes engine):**

```bash
# App running on simulator
safari://debugger
# or via remote debugger
```

**Android (Hermes):**

1. App running on device/emulator
2. Chrome: `chrome://inspect`
3. Click "Inspect" on your app
4. Standard web DevTools: console, network, performance

**Features:**

- JavaScript breakpoints, step through code
- Console: evaluate expressions, log messages
- Network: HTTP requests
- Performance: profile JavaScript execution

### React Native Debugger (Standalone)

**Setup:**

```bash
npm install -g react-native-debugger
react-native-debugger
```

**Combines:**

- Redux DevTools (if using Redux)
- React DevTools
- Hermes debugger
- Network inspector

### Performance Monitor

**Enable in code:**

```javascript
import { PerformanceMonitor } from 'react-native';

// Show on-screen metrics: FPS, RAM, heap
if (__DEV__) {
  console.log(PerformanceMonitor.instance().fps);
}
```

**Or via menu:**

- Shake device → Enable "Show Perf Monitor"
- Displays real-time FPS and memory

### LogBox

React Native's built-in error overlay.

**Configuration:**

```javascript
import { LogBox } from 'react-native';

// Suppress specific warning
LogBox.ignoreLogs(['VirtualizedList: missing keys']);

// Disable all yellow box warnings
LogBox.ignoreAllLogs(true);  // NOT for production
```

**View errors:**

- Yellow box: warnings (non-fatal)
- Red box: errors (fatal)
- Tap to expand, see stack trace

---

## Flutter Debugging

### DevTools

**Launch:**

```bash
flutter pub global activate devtools
devtools
# App will connect automatically
```

Or inline:
```bash
flutter run -d <device> --devtools
```

**Tabs:**

- **Inspector:** Widget tree, inspect props, toggle debug paint
- **Timeline:** Frame-by-frame performance (janky frames appear red)
- **Memory:** Heap snapshots, garbage collection tracking
- **Network:** HTTP requests, WebSocket activity
- **Logging:** Structured logs from app

### Debug Painting & Widget Tree

**Enable Debug Paint:**

```dart
// In main()
debugPaintSizeEnabled = true;  // Show borders
debugPaintBaselinesEnabled = true;  // Show text baselines
```

Or in DevTools Inspector tab → Toggle "Debug paint"

**Dump Widget Tree:**

```dart
import 'dart:developer' as developer;

// In code
developer.Timeline.instantSync('button_tap', arguments: {'button': 'login'});

// In console
flutter logs | grep Timeline
```

### Performance Overlay

**Enable in code:**

```dart
MaterialApp(
  showPerformanceOverlay: true,  // FPS, GPU load
  checkerboardRasterCacheImages: true,  // GPU cache misses
  child: MyApp(),
)
```

**Displays:**

- Top bar: FPS (green = 60, red = dropping frames)
- Bottom bar: GPU work (rendering performance)
- Checkerboard: images cached in GPU memory

### Structured Logging

```dart
import 'dart:developer' as developer;

developer.log(
  'User logged in',
  level: 1000,
  name: 'auth',
  time: DateTime.now(),
);

// View with: flutter logs | grep auth
```

---

## UI Debugging

### Layout Issues per Platform

**iOS (SwiftUI):**

```swift
// Add border to see frame
Text("Hello").border(Color.red)

// Debug view alignment
VStack(alignment: .leading) {
    Text("Title")
}.background(Color.yellow.opacity(0.2))

// LLDB: inspect view frame
po view.frame
po view.bounds
po view.constraints
```

**iOS (UIKit):**

```objc
// Visual bounds
self.view.layer.borderColor = [UIColor redColor].CGColor;
self.view.layer.borderWidth = 1.0;

// Console inspection
po self.view.frame
po self.view.autoresizingMask
```

**Android:**

```kotlin
// Jetpack Compose
modifier.border(1.dp, Color.Red)

// Android Views
view.setBackgroundColor(Color.YELLOW)

// ADB layout bounds
adb shell getprop debug.layout true  // (deprecated, use Inspector)
```

### Animation Debugging

**iOS (SwiftUI):**

```swift
// Slow down animations
withAnimation(.easeInOut(duration: 0.3)) {
    state = true
}

// Debug in DevTools: Timeline tab shows frame drops
```

**iOS (UIKit):**

```objc
// Xcode: Debug → Slow Animation
// Shows frame-by-frame execution
```

**Android (Compose):**

```kotlin
// Profile animations via Android Profiler
// or Compose Preview with "Design Mode"
```

**React Native:**

```javascript
// Slow down JS animations
I18nManager.allowRTL(true);  // Forces slower frame pacing for testing

// Profile with Performance.now() + frame callback
requestAnimationFrame(() => {
  console.log('Frame time:', performance.now());
});
```

---

## Performance Debugging

### Frame Rate Issues (< 60 FPS)

**iOS Diagnosis:**

1. Xcode Instruments → Time Profiler
2. Record interaction causing jank
3. Sort by "Self Weight"; find CPU hotspot
4. Common causes:
   - Synchronous I/O on main thread
   - Large view tree (> 500 views)
   - Expensive computations in `body` (SwiftUI)
   - Weak reference cycles (memory bloat)

**Solutions:**

```swift
// Move work off main thread
DispatchQueue.global().async {
    // Expensive operation
    DispatchQueue.main.async {
        self.state = result
    }
}

// SwiftUI: memoize expensive views
@State private var cachedView: SomeView?

// Reduce view hierarchy depth
```

**Android Diagnosis:**

1. Android Profiler → CPU tab
2. Record jank (frame drops appear in flame chart)
3. Common causes:
   - Large list without `RecyclerView.ViewHolder` optimization
   - Synchronous database queries on UI thread
   - Expensive XML inflation in `onCreateViewHolder`

**Solutions:**

```kotlin
// Offload to background
lifecycleScope.launch(Dispatchers.Default) {
    val result = expensiveWork()
    withContext(Dispatchers.Main) {
        updateUI(result)
    }
}

// RecyclerView: use DiffUtil for efficient updates
val diffResult = DiffUtil.calculateDiff(MyCallback(old, new))
diffResult.dispatchUpdatesTo(adapter)
```

### Memory Issues

**Detection:**

- iOS: Instruments → Allocations tab; filter by "malloc Stack" → "Top N Objects by Size"
- Android: Android Profiler → Memory tab; capture heap dump → filter by package
- React Native: Profiler memory tab or `console.time()`
- Flutter: DevTools → Memory tab

**Common Causes:**

1. **Leaked Event Listeners:**
   ```javascript
   // BAD: listener never removed
   useEffect(() => {
     window.addEventListener('scroll', handleScroll);
   }, []);
   
   // GOOD: cleanup in useEffect
   useEffect(() => {
     window.addEventListener('scroll', handleScroll);
     return () => window.removeEventListener('scroll', handleScroll);
   }, []);
   ```

2. **Uncleared Timers:**
   ```javascript
   useEffect(() => {
     const timer = setTimeout(doWork, 5000);
     return () => clearTimeout(timer);
   }, []);
   ```

3. **Retained Controllers/Delegates:**
   ```swift
   // iOS: self is retained by closure
   var callback = { self.doWork() }  // Memory cycle
   // Fix: use [weak self]
   var callback = { [weak self] in self?.doWork() }
   ```

4. **Image Memory:**
   ```javascript
   // BAD: full-resolution images in list
   <Image source={require('./full-res-image.jpg')} />
   
   // GOOD: pre-resize or use ImageBackground with maxWidth
   <Image style={{ width: 100, height: 100 }} />
   ```

---

## Network Debugging

### HTTP Proxy Tools

**Proxyman (macOS, Windows, iOS):**

1. Install Proxyman → Add Device (iOS) or use on macOS
2. Install root certificate on device
3. Launch app; all HTTPS traffic visible
4. View requests: headers, body, response, timing

**Charles (Cross-Platform):**

1. Install Charles Proxy
2. iOS device: Settings → WiFi → Proxy → Manual
3. Enter Charles host IP + port (usually :8888)
4. Trust certificate
5. Monitor traffic in Charles window

**Flipper Network Plugin:**

- Automatic (no proxy setup needed)
- View HTTP requests in Flipper app
- Inspect headers, body, response

### Network Simulation

**iOS (Xcode):**

- Xcode → Debug → Simulate → Network Link Conditioner
- Presets: 3G, LTE, WiFi Slow, Offline
- Custom packet loss, latency, bandwidth

**Android (Emulator):**

```bash
# Throttle network
adb emu network speed 56  # 56 kbps
adb emu network speed full  # Restore

# Latency
adb emu network delay 500ms
```

**React Native / Flutter:**

Use Proxyman or Charles to throttle connection bandwidth.

---

## Crash Debugging

### Firebase Crashlytics Setup

**iOS:**

```swift
import Firebase
import FirebaseCrashlytics

// In AppDelegate
FirebaseApp.configure()
Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(true)

// Custom logging
Crashlytics.crashlytics().record(error: NSError(...))
```

**Android:**

```gradle
dependencies {
  implementation 'com.google.firebase:firebase-crashlytics'
}
```

```kotlin
import com.google.firebase.crashlytics.ktx.crashlytics
import com.google.firebase.ktx.Firebase

Firebase.crashlytics.recordException(exception)
```

**React Native:**

```bash
npm install --save @react-native-firebase/app @react-native-firebase/crashlytics
```

```javascript
import crashlytics from '@react-native-firebase/crashlytics';

crashlytics().recordError(new Error('Debug message'));
crashlytics().crash();  // Force test crash
```

**Flutter:**

```bash
flutter pub add firebase_crashlytics
```

```dart
import 'package:firebase_crashlytics/firebase_crashlytics.dart';

FlutterError.onError = (errorDetails) {
  FirebaseCrashlytics.instance.recordFlutterError(errorDetails);
};
```

### Reading Stack Traces

**iOS (Xcode Organizer):**

1. Xcode → Window → Organizer
2. Select app → Crashes tab
3. Click crash → view full symbolicated stack trace
4. Click symbol → jump to source line

**Android (Play Console):**

1. Google Play Console → Your App → Crashes
2. Click crash group → Logcat tab shows full stack
3. Click class → navigate to source in Android Studio

**Manual Stack Trace Parsing:**

```
0   MyApp               0x00010a4c _TFC5MyApp10ViewControllerC16didLoadViewyycfU_ + 200
1   UIKit              0x0001b23c -[UIViewController loadViewIfRequired] + 124
2   UIKit              0x0001b4c0 -[UIViewController view] + 44
```

- Address `0x00010a4c` → look up in Xcode Organizer (symbolication)
- `_TFC5MyApp10ViewController...` → Swift mangled name
- Use `xcrun swift-demangle` to decode: `xcrun swift-demangle <mangled_name>`

---

## Common Scenarios

### App Crashes on Startup

**Diagnosis:**

1. Attach debugger (Xcode / Android Studio)
2. Set exception breakpoint: breaks on first error
3. Read stack trace: initialization code, dependency injection, permissions

**Common Causes & Fixes:**

```swift
// CRASH: Missing asset
let image = UIImage(named: "photo")!  // Fatal if missing

// FIX: Check first
guard let image = UIImage(named: "photo") else {
    print("Image missing")
    return
}

// CRASH: Deadlock in background thread
DispatchQueue.main.sync { /* from main thread */ }  // Deadlock!

// FIX: Check thread
if Thread.isMainThread {
    // main thread
} else {
    DispatchQueue.main.async { /* switch to main */ }
}
```

### UI Not Updating

**Diagnosis:**

1. Check state / props passed to widget
2. Verify state setter is called
3. Use DevTools to inspect component

**React Native:**

```javascript
// BAD: state not triggering re-render
class MyComponent extends React.Component {
  data = [];  // Not state
  render() { return <Text>{this.data.length}</Text>; }
}

// GOOD: use state
const [data, setData] = useState([]);
```

**Flutter:**

```dart
// BAD: setState not called
onPressed: () {
  _counter++;  // No rebuild
}

// GOOD: setState wraps state changes
onPressed: () {
  setState(() {
    _counter++;
  });
}
```

### Image Not Loading

**Diagnosis:**

1. Network tab: image request status (404, 403, timeout)
2. Image path: typo in URL or asset name
3. Permissions: camera roll access denied (iOS), read permission (Android)

**iOS:**

```swift
// Check URL validity
guard let url = URL(string: urlString) else {
    print("Invalid URL")
    return
}

// Check permissions
import Photos
PHPhotoLibrary.requestAuthorization { status in
    if status != .authorized {
        print("Photo access denied")
    }
}
```

**Android:**

```kotlin
// Check permissions
if (ContextCompat.checkSelfPermission(
    context, Manifest.permission.READ_EXTERNAL_STORAGE
) != PackageManager.PERMISSION_GRANTED) {
    ActivityCompat.requestPermissions(...)
}
```

### Keyboard Covering Input

**iOS (SwiftUI):**

```swift
.ignoresSafeArea(.keyboard)  // Don't push content up
.safeAreaInset(edge: .bottom) {
    // Space reserved for keyboard
}
```

**iOS (UIKit):**

```objc
- (void)keyboardWillShow:(NSNotification *)notif {
    CGFloat keyboardHeight = [notif.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue].size.height;
    [UIView animateWithDuration:0.3 animations:^{
        self.bottomConstraint.constant = keyboardHeight;
        [self.view layoutIfNeeded];
    }];
}
```

**Android (Compose):**

```kotlin
Scaffold(
    modifier = Modifier.imePadding()  // Adjust for IME
)
```

### Navigation Not Working

**Diagnosis:**

1. Check navigation stack (e.g., DevTools navigation tab)
2. Verify route name matches
3. Check conditional navigation logic

**React Navigation:**

```javascript
// BAD: wrong screen name
navigation.navigate('HomScreen');  // Typo

// GOOD: use constant
const SCREENS = { HOME: 'Home', LOGIN: 'Login' };
navigation.navigate(SCREENS.HOME);

// DEBUG: log all navigation actions
const linking = {
  subscribe: (listener) => {
    const onNavigationStateChange = () => listener();
    const subscription = navigation.addListener('state', onNavigationStateChange);
    return () => subscription();
  },
};
```

---

## Production Debugging

### Remote Logging

**LogRocket (JavaScript, React Native):**

```bash
npm install logrocket
```

```javascript
import LogRocket from 'logrocket';

LogRocket.init('app-id/org');

// Capture network requests
const getRedactUrl = (url) => url.replace(/auth=\w+/, 'auth=[REDACTED]');
LogRocket.getSessionURL(sessionURL => {
  console.log('Session URL:', sessionURL);
});
```

**Firebase Remote Config:**

```swift
// iOS: enable debug logging
#if DEBUG
    Firebase.configInstance.setLoggerLevel(.debug)
#endif

Firestore.firestore().enableLogging(true)
```

### Feature Flags for Debugging

```javascript
// React Native
const isDebugMode = () => {
  const flags = remoteConfig().getAll();
  return flags['debug_mode']?.asBoolean() ?? false;
};

// Show extra UI, logs only in debug mode
{isDebugMode() && <DebugPanel />}
```

### A/B Testing for Bug Investigation

```kotlin
// Android
val variant = FirebaseRemoteConfig.getInstance()
    .getString("crash_variant")

if (variant == "control") {
    // Original code
} else if (variant == "fix") {
    // Fixed code
}
```

---

## Debugging Checklist

### Before Filing a Bug

- [ ] Reproduce on real device (not simulator)
- [ ] Test on multiple OS versions (iOS 14+, Android 8+)
- [ ] Clear app cache / reinstall fresh
- [ ] Disable all debugging tools (show perf monitor, layout borders, etc.)
- [ ] Collect logs: screenshot, console output, crash stack
- [ ] Note exact reproduction steps

### Investigation

- [ ] Attach debugger; set exception breakpoint
- [ ] Review stack trace: which function failed?
- [ ] Check permissions (iOS/Android docs)
- [ ] Verify network connectivity (use proxy tool)
- [ ] Inspect memory usage (Instruments / Profiler)
- [ ] Search known issues in framework docs / GitHub

### Production

- [ ] Enable Firebase Crashlytics or equivalent
- [ ] Capture user session ID with crash
- [ ] Review logs **before** user reports impact
- [ ] Use feature flags to deploy fix incrementally
- [ ] Monitor metrics (crash rate, session duration) post-fix

### After Fix

- [ ] Write unit test covering the bug
- [ ] Add integration test (UI test) if user-facing
- [ ] Document root cause in commit message
- [ ] Monitor crash rate in Crashlytics
- [ ] Close related issues in bug tracker

---

## Quick Reference: Keyboard Shortcuts

| Platform | Shortcut | Action |
|----------|----------|--------|
| **Xcode** | Cmd+\ | Toggle breakpoint |
| **Xcode** | Cmd+Y | Continue execution |
| **Xcode** | F6 | Step over |
| **Xcode** | F7 | Step into |
| **Xcode** | Cmd+I | Profile (Instruments) |
| **Android Studio** | Ctrl+F8 (Win) / Cmd+F8 (Mac) | Evaluate expression |
| **Android Studio** | Ctrl+Alt+H | Call hierarchy |
| **Chrome DevTools** | F12 | Open DevTools |
| **Chrome DevTools** | Cmd+\ | Pause on uncaught exception |
| **Flutter DevTools** | `w` key (in terminal) | Reload hot reload |
| **React DevTools** | Highlight | Inspect rendered component |

