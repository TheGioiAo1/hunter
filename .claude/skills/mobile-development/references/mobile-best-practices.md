# Mobile Development Best Practices

Cross-cutting best practices for iOS, Android, React Native, Flutter, and web mobile applications.

## 1. Performance Optimization

### Launch Time Optimization

**Cold Start** (app not in memory):
- Minimize main thread blocking during app startup
- Lazy-load heavy dependencies
- Defer non-essential initialization

**Warm Start** (app backgrounded but not killed):
- Cache critical data in-memory or local storage
- Restore session state efficiently

**Hot Start** (app foreground):
- Keep main UI responsive using background threads

**React Native tips:**
```js
// Use react.lazy() + Suspense for code splitting
const HeavyComponent = React.lazy(() => import('./HeavyComponent'));

// Defer non-critical libraries
useEffect(() => {
  import('analytics-sdk').then(({ Analytics }) => {
    Analytics.init();
  });
}, []);
```

**Flutter tips:**
- Use `Image.asset()` precaching: `precacheImage()` during splash screen
- Lazy-load packages in `main()` using `WidgetsBinding.instance.deferFirstFrame()`

### Image Optimization

- **Lazy Loading**: Load images only when visible (e.g., Intersection Observer web, visibility detection mobile)
- **Caching**: HTTP caching headers; SQLite for persistent cache (React Native: `react-native-fast-image`, Flutter: `cached_network_image`)
- **Formats**: WebP (25-35% smaller than JPEG), AVIF (better compression), PNG for transparency
- **Thumbnails**: Always load low-res preview while full image downloads
- **Responsive**: Serve different resolutions for device pixel density (1x, 2x, 3x)

**React Native example:**
```js
import FastImage from 'react-native-fast-image';

<FastImage
  source={{ uri: 'https://example.com/image.webp', priority: FastImage.priority.normal }}
  style={{ width: 200, height: 200 }}
  onLoadEnd={() => console.log('Loaded')}
/>
```

### List Virtualization

Render only visible items to reduce memory and improve scrolling performance.

**React Native (FlatList):**
```js
<FlatList
  data={items}
  renderItem={({ item }) => <ListItem {...item} />}
  keyExtractor={item => item.id}
  initialNumToRender={10}
  maxToRenderPerBatch={20}
  updateCellsBatchingPeriod={50}
  removeClippedSubviews={true}
/>
```

**Flutter (ListView.builder):**
```dart
ListView.builder(
  itemCount: items.length,
  itemBuilder: (context, index) => ListTile(title: Text(items[index].name)),
)
```

### Memory Management

- **Leak Detection**: Use Xcode Memory Graph (iOS), Android Profiler (Android)
- **Cleanup Patterns**: Always unsubscribe from streams/listeners on component unmount/dispose
- **Image Cache**: Clear image cache when memory warning fires
- **Weak References**: Use weak references in event listeners to prevent circular references

**React Native cleanup:**
```js
useEffect(() => {
  const subscription = eventEmitter.subscribe('event', handler);
  return () => subscription.remove(); // Cleanup on unmount
}, []);
```

### Animation Performance

Target 60fps (120fps on ProMotion displays). Use GPU-accelerated transforms.

- **React Native**: Reanimated 2 (native driver) for smooth animations
- **Flutter**: Custom Paint + AnimationController for low-level control
- Avoid animating `opacity` and `size` on large lists; use `transform` instead
- Profile with DevTools Performance monitor

**React Native Reanimated example:**
```js
const animatedStyle = useAnimatedStyle(() => ({
  transform: [{ translateX: progress.value }],
}));

return <Animated.View style={animatedStyle} />;
```

### Bundle Size Reduction

- **Tree Shaking**: Enable in Webpack/Metro by using ES6 imports
- **Code Splitting**: Dynamic imports for feature-based bundles
- **Dynamic Features**: On-demand delivery for rarely-used features
- **Minification**: ProGuard (Android), UglifyJS/Terser (JavaScript)

**React Native Metro config:**
```js
const config = {
  transformer: { minifierConfig: { keep_classnames: true } },
};
```

---

## 2. Offline-First Architecture

### Local-First Data Design

Store primary data locally; sync with server asynchronously.

**React Native:** AsyncStorage, SQLite (react-native-sqlite-storage), Realm
**Flutter:** Hive, Sqflite, ObjectBox

**Example: Simple sync queue (React Native):**
```js
class SyncQueue {
  async addOperation(op) {
    await db.insert('sync_queue', {
      id: uuid(),
      type: op.type, // 'create', 'update', 'delete'
      entity: op.entity,
      payload: JSON.stringify(op.data),
      createdAt: Date.now(),
    });
  }

  async processPending() {
    const ops = await db.query('SELECT * FROM sync_queue ORDER BY createdAt');
    for (const op of ops) {
      try {
        await api[op.type](op.entity, JSON.parse(op.payload));
        await db.delete('sync_queue', { id: op.id });
      } catch (err) {
        console.error('Sync failed, will retry:', err);
      }
    }
  }
}
```

### Sync Strategies

**Write-Through Cache**: Write locally first, sync server in background.
**Hybrid Push+Pull**: Push changes to server; pull changes from server on app open.
**Periodic Sync**: Use work scheduling (WorkManager Android, Background Tasks iOS).

### Conflict Resolution

- **Last-Write-Wins**: Simple, suitable for non-critical data
- **CRDT (Conflict-free Replicated Data Type)**: Distributed consensus (use Yjs, Automerge)
- **Manual Merge**: User chooses which version to keep for critical conflicts

**Last-write-wins timestamp:**
```js
// Client stores version timestamp; server compares
const merge = (local, server) => local.updatedAt > server.updatedAt ? local : server;
```

### Optimistic UI Updates

Update UI immediately; revert if server request fails.

```js
const [items, setItems] = useState([...]);

const deleteItem = async (id) => {
  const oldItems = items;
  setItems(items.filter(i => i.id !== id)); // Optimistic
  
  try {
    await api.delete(`/items/${id}`);
  } catch (err) {
    setItems(oldItems); // Revert on failure
    showError('Failed to delete');
  }
};
```

### Queue-Based Operations

Use background job queues for offline mutations.

```js
// Enqueue mutation
await db.insert('mutations', {
  id: uuid(),
  mutation: 'updateProfile',
  variables: { name: 'New Name' },
  status: 'pending',
});

// Process when online
if (isOnline) {
  const mutations = await db.query('SELECT * FROM mutations WHERE status = "pending"');
  for (const m of mutations) {
    await executeMutation(m.mutation, m.variables);
    await db.update('mutations', { id: m.id, status: 'completed' });
  }
}
```

---

## 3. Push Notifications

### FCM (Android) and APNs (iOS)

**Android (FCM):**
1. Register app in Firebase Console
2. Download google-services.json → place in `android/app/`
3. Add Firebase dependencies to `build.gradle`

**iOS (APNs):**
1. Create APNS certificate in Apple Developer
2. Upload to Firebase Console or OneSignal
3. Ensure entitlements are configured

### React Native: @react-native-firebase/messaging

```js
import messaging from '@react-native-firebase/messaging';

// Request permission (iOS)
messaging().requestPermission();

// Get FCM token
const token = await messaging().getToken();

// Listen to foreground messages
messaging().onMessage(async msg => {
  console.log('Notification:', msg.notification);
});

// Listen to background/killed state (via linking)
messaging().onNotificationOpenedApp(msg => {
  navigation.navigate(msg.data.screen);
});
```

### Flutter: firebase_messaging

```dart
FirebaseMessaging messaging = FirebaseMessaging.instance;

// Request permission
NotificationSettings settings = await messaging.requestPermission();

// Get token
String? token = await messaging.getToken();

// Foreground handler
FirebaseMessaging.onMessage.listen((RemoteMessage msg) {
  print('Notification: ${msg.notification?.title}');
});

// Background handler (requires top-level function)
FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);
```

### Permission Handling

**iOS**: Automatically request on first use; user can grant/deny.
**Android 13+**: POST_NOTIFICATIONS permission required in AndroidManifest.xml.

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

### Deep Linking from Notifications

Pass deeplink data in notification payload:
```json
{
  "notification": { "title": "New Message" },
  "data": { "screen": "ChatDetail", "userId": "123" }
}
```

Handle in app initialization:
```js
// React Native
messaging().onNotificationOpenedApp(msg => {
  const { screen, userId } = msg.data;
  navigation.navigate(screen, { userId });
});
```

### Silent/Background Notifications

**Android**: Set `priority: high` and use background service.
**iOS**: Ensure `content_available: true` in payload; requires background capability.

---

## 4. Authentication & Security

### Biometric Authentication

**React Native:** `react-native-biometrics`, `react-native-touch-id`
**Flutter:** `local_auth`

```js
// React Native example
import Biometrics from 'react-native-biometrics';

const authenticateWithBiometrics = async () => {
  try {
    const result = await Biometrics.biometricKeysExist();
    if (result.keysExist) {
      await Biometrics.createSignature({ payload: 'test' });
      // Biometric successful
    }
  } catch (err) {
    console.error('Biometric auth failed:', err);
  }
};
```

### Secure Storage

**iOS Keychain** (via `react-native-keychain`):
- Encrypted at rest
- Syncs across devices via iCloud Keychain (opt-in)

**Android Keystore**:
- Hardware-backed encryption (if available)
- Automatically managed by AndroidKeyStore

**React Native example:**
```js
import * as Keychain from 'react-native-keychain';

await Keychain.setGenericPassword('username', 'password', {
  service: 'myapp.credentials',
  storage: Keychain.STORAGE_TYPE.ENCRYPTED,
});

const credentials = await Keychain.getGenericPassword({ service: 'myapp.credentials' });
```

### OAuth 2.0 / OIDC Mobile Flow

Use Authorization Code Flow with PKCE for mobile:
```js
// React Native with react-native-app-auth
import { authorize } from 'react-native-app-auth';

const result = await authorize({
  clientId: 'YOUR_CLIENT_ID',
  redirectUrl: 'com.myapp://oauth',
  scopes: ['profile', 'email'],
});

// Store tokens securely
await Keychain.setGenericPassword('token', result.accessToken);
```

### Certificate Pinning

Pin server certificates to prevent MITM attacks.

**React Native:** `react-native-ssl-pinning`
**Flutter:** `http_certificate_pinning` package

### Jailbreak/Root Detection

Detect compromised devices:

**React Native:** `react-native-jailbreak-detect`
**Flutter:** `flutter_jailbreak_detection`

```js
import JailMonkey from 'react-native-jailbreak-detect';

if (JailMonkey.isJailBroken()) {
  // Handle compromised device
}
```

### ProGuard/R8 Obfuscation

Protect sensitive code from reverse engineering (Android).

**build.gradle:**
```gradle
buildTypes {
  release {
    minifyEnabled true
    shrinkResources true
    proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
  }
}
```

---

## 5. Accessibility

### VoiceOver (iOS) and TalkBack (Android)

- Test with screen readers enabled
- Ensure all interactive elements are labeled

### Semantic Labels & Roles

```js
// React Native
<TouchableOpacity
  accessible={true}
  accessibilityLabel="Delete item"
  accessibilityRole="button"
  accessibilityHint="Removes the item from the list"
>
  <Text>Delete</Text>
</TouchableOpacity>
```

### Touch Target Minimums

- **iOS**: 44pt × 44pt (minimum)
- **Android**: 48dp × 48dp (minimum)

### Dynamic Type / Font Scaling

Respect user's system font size preferences.

```js
// React Native: Use percentages or scale()
import { useWindowDimensions } from 'react-native';

const { fontScale } = useWindowDimensions();
const fontSize = 16 * fontScale;
```

### Color Contrast

Meet WCAG AA (4.5:1 for text). Use contrast checker tools (WebAIM, Stark).

### Testing Tools

- **iOS**: Xcode Accessibility Inspector, VoiceOver Rotor
- **Android**: Accessibility Scanner, TalkBack
- **Cross-platform**: axe DevTools mobile extension

---

## 6. App Store Deployment

### iOS: App Store Connect

1. Archive app in Xcode (`Product → Archive`)
2. Upload via Xcode (`Distribute App`)
3. Fill metadata, screenshots, privacy policy
4. Request app review (typically 24–48 hours)
5. Release to App Store or TestFlight
6. **Privacy Manifest**: Declare SDK data usage (`PrivacyInfo.xcprivacy`)
7. **SDK Requirements**: Specify iOS minimum version

### Android: Google Play Console

1. Build AAB (not APK): `./gradlew bundleRelease`
2. Upload to Google Play Console
3. Set **target API level** (required for all new apps)
4. Complete **Data Safety** questionnaire
5. Configure store listing and graphics
6. Staged rollout: 10% → 50% → 100%

### CI/CD Automation

**Fastlane** (iOS + Android):
```ruby
default_platform(:ios)

platform :ios do
  desc "Build and upload to TestFlight"
  lane :beta do
    build_app(workspace: "ios/App.xcworkspace", scheme: "App")
    upload_to_testflight
  end
end
```

**EAS Build** (Expo):
```bash
eas build --platform ios --auto-submit
```

**GitHub Actions:**
```yaml
- name: Build iOS app
  run: |
    fastlane ios beta
```

### Staged Rollout

- Day 1: 10% of users
- Day 3: 50% if no critical crashes
- Day 5: 100% rollout
- Monitor crash-free rate and ANR (Android Not Responding)

### OTA Updates

**React Native: CodePush** (Microsoft):
```js
import CodePush from 'react-native-code-push';

const MyApp = CodePush({ checkFrequency: CodePush.CheckFrequency.ON_APP_RESUME })(App);
```

**Flutter: Shorebird** (Shorebird.dev):
```bash
shorebird release ios
```

---

## 7. Analytics & Monitoring

### Firebase Analytics / Crashlytics

**React Native:**
```js
import analytics from '@react-native-firebase/analytics';
import crashlytics from '@react-native-firebase/crashlytics';

await analytics().logEvent('user_signup', { email: 'user@example.com' });

try {
  riskyOperation();
} catch (err) {
  crashlytics().recordError(err);
}
```

**Flutter:**
```dart
await FirebaseAnalytics.instance.logEvent(
  name: 'user_signup',
  parameters: {'email': 'user@example.com'},
);
```

### Sentry for Error Tracking

Comprehensive error reporting with source maps and breadcrumbs.

```js
import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: 'YOUR_DSN',
  environment: 'production',
  tracesSampleRate: 0.1,
});
```

### Performance Monitoring

**Firebase Performance Monitoring:**
```js
const trace = await performance().startTrace('custom_trace');
// ... operation
await trace.stop();
```

**Custom Traces:**
- Network request time
- Screen navigation time
- Database query time

### User Session Replay

**LogRocket** (session replay + error monitoring):
```js
import LogRocket from 'logrocket';

LogRocket.init('app-id');
LogRocket.captureException(error, { level: 'error' });
```

Helps reproduce bugs by watching exactly what the user did.

---

## Quick Checklist

- [ ] Image optimization (WebP, lazy loading, caching)
- [ ] List virtualization for long lists
- [ ] Offline sync queue implementation
- [ ] Biometric auth setup
- [ ] Secure token storage
- [ ] Push notification deep linking
- [ ] Accessibility labels and 44pt/48dp touch targets
- [ ] Analytics and error tracking
- [ ] CI/CD pipeline with staged rollout
- [ ] OTA update mechanism (CodePush/Shorebird)
