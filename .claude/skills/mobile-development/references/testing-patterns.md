# Mobile Testing Patterns (React Native / Flutter / Native iOS / Native Android)

Mobile testing spans 4 flavors depending on stack. Pick the subsection matching yours.

---

## React Native — Jest + RNTL + Detox / Maestro

### File layout

```
src/
  screens/
    LoginScreen.tsx
    __tests__/
      LoginScreen.test.tsx
  hooks/
    useAuth.ts
    useAuth.test.ts
e2e/
  login.e2e.ts               # Detox or Maestro flow
```

### Config (Jest)

```json
// package.json
{
  "jest": {
    "preset": "react-native",
    "setupFilesAfterEach": ["@testing-library/jest-native/extend-expect"],
    "transformIgnorePatterns": [
      "node_modules/(?!(react-native|@react-native|@react-navigation|react-native-reanimated)/)"
    ]
  }
}
```

### React Native Testing Library

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native'

it('logs in on button press', async () => {
  const onLogin = jest.fn().mockResolvedValue({ token: 'x' })
  render(<LoginScreen onLogin={onLogin} />)

  fireEvent.changeText(screen.getByLabelText(/email/i), 'a@b.com')
  fireEvent.changeText(screen.getByLabelText(/password/i), 'secret')
  fireEvent.press(screen.getByRole('button', { name: /log in/i }))

  await waitFor(() => expect(onLogin).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret' }))
})
```

Query priority on RN: `getByRole`, `getByLabelText`, `getByText`, `getByTestId` (RN doesn't have true HTML semantics — `accessibilityLabel` drives `getByLabelText`).

### Mocking native modules

```ts
// __mocks__/@react-native-async-storage/async-storage.js
export default {
  setItem: jest.fn().mockResolvedValue(undefined),
  getItem: jest.fn().mockResolvedValue(null),
  removeItem: jest.fn().mockResolvedValue(undefined),
  clear: jest.fn().mockResolvedValue(undefined),
}

// jest.setup.js
jest.mock('react-native-keychain', () => ({
  setGenericPassword: jest.fn().mockResolvedValue(true),
  getGenericPassword: jest.fn().mockResolvedValue(false),
}))
jest.mock('@react-native-firebase/analytics', () => () => ({ logEvent: jest.fn() }))
```

### Navigation testing

Wrap with `NavigationContainer` + `createStackNavigator` stub or mock the navigator:

```tsx
import { NavigationContainer } from '@react-navigation/native'
const wrapper = ({ children }) => <NavigationContainer>{children}</NavigationContainer>
render(<SomeScreen />, { wrapper })

// Or mock navigation prop directly
const navigation = { navigate: jest.fn(), goBack: jest.fn() }
render(<LoginScreen navigation={navigation as any} />)
```

### E2E — Detox vs Maestro

**Detox** (JS-based, deeper integration):
```ts
// e2e/login.e2e.ts
describe('Login', () => {
  beforeEach(async () => { await device.reloadReactNative() })
  it('logs in', async () => {
    await element(by.id('email-input')).typeText('a@b.com')
    await element(by.id('password-input')).typeText('secret')
    await element(by.id('login-btn')).tap()
    await expect(element(by.text('Welcome'))).toBeVisible()
  })
})
```

**Maestro** (YAML flows, faster to write, recommended for most):
```yaml
# .maestro/login.yaml
appId: com.myapp
---
- launchApp
- tapOn: "Email"
- inputText: "a@b.com"
- tapOn: "Password"
- inputText: "secret"
- tapOn: "Log In"
- assertVisible: "Welcome"
```

Use Detox for complex state manipulation (deep linking, notifications). Use Maestro for fast happy-path coverage.

---

## Flutter — flutter_test + integration_test

### File layout

```
lib/
  features/
    auth/
      login_screen.dart
test/
  features/
    auth/
      login_screen_test.dart      # widget + unit
integration_test/
  login_flow_test.dart            # real device/simulator
```

### Widget testing

```dart
void main() {
  testWidgets('login button calls onSubmit', (tester) async {
    var submitted = false;
    await tester.pumpWidget(MaterialApp(
      home: LoginScreen(onSubmit: (_) => submitted = true),
    ));

    await tester.enterText(find.bySemanticsLabel('Email'), 'a@b.com');
    await tester.enterText(find.bySemanticsLabel('Password'), 'secret');
    await tester.tap(find.byType(ElevatedButton));
    await tester.pump();

    expect(submitted, isTrue);
  });
}
```

### Mocking (mocktail)

```dart
class MockAuthRepo extends Mock implements AuthRepo {}

test('bloc emits Authenticated on success', () async {
  final repo = MockAuthRepo();
  when(() => repo.login(any(), any())).thenAnswer((_) async => const User('u1'));

  final bloc = LoginBloc(repo);
  bloc.add(LoginSubmitted('a@b.com', 'secret'));

  await expectLater(
    bloc.stream,
    emitsInOrder([isA<LoginLoading>(), isA<LoginAuthenticated>()]),
  );
});
```

### Golden tests

```dart
testWidgets('LoginScreen renders correctly', (tester) async {
  await tester.pumpWidget(MaterialApp(home: LoginScreen()));
  await expectLater(find.byType(LoginScreen), matchesGoldenFile('login.png'));
});
```

Run `flutter test --update-goldens` to regenerate.

### Integration tests (real device)

```dart
// integration_test/login_flow_test.dart
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('full login', (tester) async {
    app.main();
    await tester.pumpAndSettle();
    // ... same API as widget tests but runs on device
  });
}
```

Run: `flutter test integration_test/`.

---

## Native iOS — XCTest + XCUITest

### File layout (Swift)

```
MyApp/
  Sources/
    Auth/
      LoginViewModel.swift
MyAppTests/                  # XCTest (unit)
  LoginViewModelTests.swift
MyAppUITests/                # XCUITest (E2E)
  LoginUITests.swift
```

### Unit (XCTest)

```swift
final class LoginViewModelTests: XCTestCase {
    func test_login_callsAuthServiceWithCredentials() async throws {
        let service = MockAuthService()
        let sut = LoginViewModel(auth: service)

        await sut.login(email: "a@b.com", password: "secret")

        XCTAssertEqual(service.loginCalls.count, 1)
        XCTAssertEqual(service.loginCalls.first?.email, "a@b.com")
    }

    func test_login_setsErrorOnFailure() async throws {
        let service = MockAuthService()
        service.stubbedError = AuthError.invalidCredentials
        let sut = LoginViewModel(auth: service)

        await sut.login(email: "a@b.com", password: "wrong")

        XCTAssertEqual(sut.errorMessage, "Invalid credentials")
    }
}
```

### UI (XCUITest)

```swift
final class LoginUITests: XCTestCase {
    func test_loginFlow() {
        let app = XCUIApplication()
        app.launch()

        app.textFields["Email"].tap()
        app.textFields["Email"].typeText("a@b.com")
        app.secureTextFields["Password"].tap()
        app.secureTextFields["Password"].typeText("secret")
        app.buttons["Log In"].tap()

        XCTAssertTrue(app.staticTexts["Welcome"].waitForExistence(timeout: 5))
    }
}
```

Accessibility identifiers drive queries — set via SwiftUI `.accessibilityIdentifier("Email")`.

---

## Native Android — JUnit + Espresso + Compose

### File layout (Kotlin)

```
app/src/
  test/                       # unit (JVM, fast)
    java/com/myapp/
      LoginViewModelTest.kt
  androidTest/                # on-device (Espresso)
    java/com/myapp/
      LoginScreenTest.kt
```

### Unit (JUnit 5 + MockK + Turbine)

```kotlin
class LoginViewModelTest {
    private val auth: AuthRepo = mockk()
    private val sut = LoginViewModel(auth)

    @Test
    fun `login emits Success on valid creds`() = runTest {
        coEvery { auth.login("a@b.com", "secret") } returns User("u1")

        sut.state.test {
            sut.login("a@b.com", "secret")
            assertEquals(LoginState.Idle, awaitItem())
            assertEquals(LoginState.Loading, awaitItem())
            assertEquals(LoginState.Success, awaitItem())
        }
    }
}
```

### Compose UI tests

```kotlin
class LoginScreenTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun loginButton_submits() {
        var submitted = false
        composeRule.setContent {
            LoginScreen(onSubmit = { _, _ -> submitted = true })
        }

        composeRule.onNodeWithText("Email").performTextInput("a@b.com")
        composeRule.onNodeWithText("Password").performTextInput("secret")
        composeRule.onNodeWithText("Log In").performClick()

        assertTrue(submitted)
    }
}
```

### Espresso (View-based)

```kotlin
@Test fun loginFlow() {
    onView(withId(R.id.email)).perform(typeText("a@b.com"))
    onView(withId(R.id.password)).perform(typeText("secret"))
    onView(withId(R.id.login)).perform(click())
    onView(withText("Welcome")).check(matches(isDisplayed()))
}
```

---

## Cross-cutting concerns

### Device matrix

E2E must run on both iOS and Android for cross-platform apps. Budget for CI time: Detox/XCUITest are SLOW (3-10 min per run). Maestro is faster. Consider running E2E only on main branch + PRs touching UI.

### Permissions (camera, location, notifications)

Always inject a `PermissionService` interface. Tests fake "granted" or "denied" — never trigger real system dialogs.

### Network (offline, retry, timeout)

- Mock at the boundary (HTTP client fakes)
- Test offline banner shows when `NetInfo.isConnected = false`
- Test retry/backoff with controllable clock

### Push notifications

Fake the notification payload; don't wait for real APNs/FCM delivery in tests.

### Deep linking

Test the URL → route resolver as a pure function. E2E can verify `xcrun simctl openurl` / `adb shell am start -d`.

## Coverage priorities

1. **View models / state holders** (BLoC, ViewModel, Redux slice) → 85%+
2. **Repositories / API clients** → happy + 2-3 error paths
3. **Navigation logic** → route guards, deep links
4. **UI components** → happy render + 2-3 interaction states per screen
5. **Native modules** → smoke only (trust platform)

## Common pitfalls

- RN: forgetting `jest.useFakeTimers()` before animation-dependent tests
- Flutter: `pumpAndSettle()` hanging forever with infinite animations → use `pump(Duration)` explicitly
- iOS XCUITest: flakes on animations → `UIView.setAnimationsEnabled(false)` in test target
- Android: missing `AndroidManifest.xml` permissions in `androidTest` → duplicate from main
- All stacks: hitting real API in tests → enforce network mocking via interceptors / lint rules
- All stacks: emulator speed flakes → bump CI timeout, don't add arbitrary sleeps
