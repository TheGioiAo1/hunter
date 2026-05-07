# Mobile Frameworks Reference

Comprehensive guide to supported mobile development frameworks: React Native, Flutter, Swift/SwiftUI, Kotlin/Jetpack Compose, and Java/Android.

---

## React Native (TypeScript)

### Architecture

**New Architecture (React Native 0.71+)**
- **Fabric**: New renderer replacing legacy renderer. Improves performance, simplifies synchronous layout.
- **TurboModules**: Replace old bridge with modern module system. Direct native method calls without serialization.
- **JSI (JavaScript Interface)**: Allow JS to hold references to native objects, enabling complex integrations.
- **Hermes**: Optimized JS engine (faster startup, lower memory than V8).

### Project Structure

- **Expo workflow**: Managed build, OTA updates, no native code required. Best for rapid development.
- **Bare workflow**: Full native control via Xcode/Android Studio. Required for custom native modules or native libraries.

### Navigation

React Navigation 7+ with TypeScript:

```typescript
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

type RootStackParamList = {
  Home: undefined;
  Details: { id: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Details" component={DetailsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

### State Management

- **Zustand**: Minimal, TypeScript-first. Best for simple-to-medium apps.
- **Redux Toolkit**: Enterprise standard. Predictable, time-travel debugging.
- **React Query**: Server state (API caching, synchronization).

```typescript
// Zustand example
import { create } from 'zustand';

interface AuthStore {
  user: User | null;
  setUser: (user: User | null) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));
```

### Styling

Use `StyleSheet.create()` for performance (styles compiled once):

```typescript
const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
  },
  text: {
    fontSize: 16,
    color: '#333',
  },
});

// Platform-specific
const boxShadow = Platform.select({
  ios: { shadowColor: '#000', shadowOpacity: 0.2 },
  android: { elevation: 4 },
});
```

### Native Modules

Use JSI for high-performance bridges. TurboModules for modern module definition:

```typescript
// NativeVideo.ts
import { TurboModuleRegistry } from 'react-native';

export interface Spec {
  play(path: string): Promise<void>;
  pause(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeVideo');
```

### Performance

- **Hermes**: Enable in `app.json` → `expo.plugins` or app-level `build.gradle`.
- **FlatList**: Always use `keyExtractor`, `removeClippedSubviews={true}` for large lists.
- **Memoization**: Use `useMemo()`, `useCallback()`, `React.memo()` to prevent re-renders.
- **Reanimated 3**: GPU-driven animations, 60fps.

```typescript
import Animated, { FadeInDown } from 'react-native-reanimated';

export function AnimatedList({ items }: Props) {
  return (
    <Animated.FlatList
      data={items}
      renderItem={({ item }) => (
        <Animated.View entering={FadeInDown}>
          <Text>{item.name}</Text>
        </Animated.View>
      )}
      keyExtractor={(item) => item.id}
    />
  );
}
```

### Testing

- **Jest**: Unit tests for business logic.
- **React Native Testing Library**: Component testing (render, fireEvent).
- **Detox**: E2E testing (real device/simulator interactions).

### MVVM Example

```typescript
// ViewModel
class UserViewModel {
  users$ = signal<User[]>([]);
  loading$ = signal(false);

  async loadUsers() {
    this.loading$.set(true);
    const data = await api.fetchUsers();
    this.users$.set(data);
    this.loading$.set(false);
  }
}

// View
export function UserListScreen() {
  const vm = useViewModel(() => new UserViewModel());
  
  useEffect(() => {
    vm.loadUsers();
  }, []);

  return (
    <FlatList
      data={vm.users$()}
      renderItem={({ item }) => <UserRow user={item} />}
    />
  );
}
```

---

## Flutter

### Architecture

- **Widget tree**: Everything is a widget (immutable, compositional).
- **Rendering pipeline**: Layout → Paint → Composite (deterministic, predictable).
- **Skia/Impeller**: Graphics engine (Impeller: modern, more performant on some platforms).

### Project Structure

Features-first organization:
```
lib/
├── main.dart
├── core/
│   ├── constants/
│   └── utils/
├── features/
│   ├── home/
│   │   ├── data/ (repositories, models)
│   │   ├── domain/ (entities, use cases)
│   │   └── presentation/ (pages, widgets)
│   └── profile/
│       └── [same structure]
└── di/ (dependency injection)
```

### Navigation

go_router 12+ with typed routes:

```dart
final router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomePage(),
      routes: [
        GoRoute(
          path: 'user/:id',
          builder: (context, state) {
            final id = state.pathParameters['id']!;
            return UserDetailPage(userId: id);
          },
        ),
      ],
    ),
  ],
);

// Navigation
context.go('/user/123');
context.push('/user/123'); // stack-based
```

### State Management

**Riverpod** (modern, testable):

```dart
final userProvider = FutureProvider<User>((ref) async {
  final api = ref.watch(apiProvider);
  return api.getUser();
});

// In widget
@override
Widget build(BuildContext context, WidgetRef ref) {
  final userAsync = ref.watch(userProvider);
  
  return userAsync.when(
    data: (user) => UserCard(user: user),
    loading: () => const LoadingSpinner(),
    error: (err, stack) => ErrorWidget(error: err),
  );
}
```

**BLoC** (enterprise-scale):

```dart
class UserBloc extends Bloc<UserEvent, UserState> {
  UserBloc(this._repository) : super(UserInitial()) {
    on<FetchUserEvent>(_onFetchUser);
  }

  final UserRepository _repository;

  Future<void> _onFetchUser(
    FetchUserEvent event,
    Emitter<UserState> emit,
  ) async {
    emit(UserLoading());
    try {
      final user = await _repository.getUser(event.userId);
      emit(UserLoaded(user));
    } catch (e) {
      emit(UserError(e.toString()));
    }
  }
}
```

### Theming

Material 3 with custom theme:

```dart
final theme = ThemeData(
  useMaterial3: true,
  colorScheme: ColorScheme.fromSeed(seedColor: Colors.blue),
  textTheme: TextTheme(
    displayLarge: TextStyle(fontSize: 32, fontWeight: FontWeight.bold),
  ),
);

// Apply
MaterialApp(
  theme: theme,
  home: HomePage(),
)
```

### Platform Channels

Call native code (iOS/Android):

```dart
const platform = MethodChannel('com.example.app/native');

Future<void> callNativeFunction() async {
  try {
    final result = await platform.invokeMethod('getDeviceInfo');
    print(result);
  } catch (e) {
    print('Native error: $e');
  }
}
```

### Performance

- **const widgets**: Compile-time constant (zero rebuilds).
- **RepaintBoundary**: Isolate expensive paint operations.
- **DevTools**: Profile performance, inspect widget tree.

```dart
class MyListItem extends StatelessWidget {
  const MyListItem(this.item, {Key? key}) : super(key: key);
  
  final Item item;

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: Card(
        child: ListTile(title: Text(item.name)),
      ),
    );
  }
}
```

### Testing

```dart
// Widget test
testWidgets('User list displays items', (WidgetTester tester) async {
  await tester.pumpWidget(const MyApp());
  expect(find.byType(ListView), findsOneWidget);
  expect(find.byType(UserCard), findsWidgets);
});

// Unit test
test('UserRepository fetches user', () async {
  final repo = UserRepository(mockHttp);
  final user = await repo.getUser('123');
  expect(user.id, '123');
});
```

### BLoC/Riverpod Example

```dart
// Riverpod notifier
class UserNotifier extends StateNotifier<AsyncValue<User>> {
  UserNotifier(this._repository) : super(const AsyncValue.loading());

  final UserRepository _repository;

  Future<void> loadUser(String id) async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() => _repository.getUser(id));
  }
}

final userProvider = StateNotifierProvider<UserNotifier, AsyncValue<User>>(
  (ref) => UserNotifier(ref.watch(repositoryProvider)),
);
```

---

## Swift / SwiftUI

### Swift 6 Features

- **Data Race Safety**: Compiler enforces thread-safe code (no unsafe shared state).
- **async/await**: Structured concurrency, no callback hell.
- **Actors**: Thread-safe isolated state.
- **Macros**: Reduce boilerplate (e.g., `@Observable`).

```swift
@Observable
final class UserViewModel {
  var user: User?
  var isLoading = false
  
  func loadUser(id: String) async {
    isLoading = true
    user = await apiClient.fetchUser(id)
    isLoading = false
  }
}

actor APIClient {
  nonisolated let session: URLSession
  
  func fetchUser(_ id: String) async throws -> User {
    let url = URL(string: "https://api.example.com/users/\(id)")!
    let (data, _) = try await session.data(from: url)
    return try JSONDecoder().decode(User.self, from: data)
  }
}
```

### SwiftUI vs UIKit

| Factor | SwiftUI | UIKit |
|--------|---------|-------|
| Syntax | Declarative | Imperative |
| Learning Curve | Shallow | Steep |
| Performance | Good (90%+ parity) | Mature |
| Legacy Support | iOS 13+ | iOS 8+ |
| **Best For** | New apps, rapid dev | Legacy codebases |

### Property Wrappers

```swift
@State private var count = 0 // Local mutable state
@Binding var isActive: Bool   // Reference to parent state
@StateObject var vm = ViewModel() // Lifecycle-managed state
@Environment(\.colorScheme) var colorScheme // Environment access
```

### Architecture

**MVVM with SwiftUI**:

```swift
@Observable
final class UserListViewModel {
  var users: [User] = []
  var errorMessage: String?
  
  @MainActor
  func loadUsers() async {
    do {
      users = try await APIClient.shared.fetchUsers()
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

struct UserListView: View {
  @State var viewModel = UserListViewModel()
  
  var body: some View {
    NavigationStack {
      List(viewModel.users) { user in
        NavigationLink(value: user) {
          UserRow(user: user)
        }
      }
      .navigationDestination(for: User.self) { user in
        UserDetailView(userId: user.id)
      }
    }
    .task {
      await viewModel.loadUsers()
    }
  }
}
```

**The Composable Architecture (TCA)**: Redux-like with reducer composition:

```swift
@Reducer
struct UserFeature {
  @ObservableState struct State {
    var users: [User] = []
    var isLoading = false
  }
  
  enum Action {
    case loadUsers
    case usersLoaded([User])
  }
  
  var body: some ReducerOf<Self> {
    Reduce { state, action in
      switch action {
      case .loadUsers:
        state.isLoading = true
        return .run { send in
          let users = try await APIClient.shared.fetchUsers()
          await send(.usersLoaded(users))
        }
      case let .usersLoaded(users):
        state.isLoading = false
        state.users = users
        return .none
      }
    }
  }
}
```

### Combine Framework

Reactive streams:

```swift
let publisher = URLSession.shared
  .dataTaskPublisher(for: url)
  .map(\.data)
  .decode(type: [User].self, decoder: JSONDecoder())
  .replaceError(with: [])
  .eraseToAnyPublisher()

// In view model
@Published var users: [User] = []

init() {
  publisher
    .assign(to: &$users)
}
```

### Testing

```swift
@Test func userListViewModel_loadsUsers() async {
  let mockAPI = MockAPIClient()
  let vm = UserListViewModel(api: mockAPI)
  
  await vm.loadUsers()
  
  #expect(vm.users.count == 2)
  #expect(vm.errorMessage == nil)
}

// UI Testing
@MainActor
struct UserListView_Tests {
  @Test func displaysUserList() {
    let app = XCUIApplication()
    app.launch()
    
    XCTAssertTrue(app.tables.firstMatch.waitForExistence(timeout: 5))
  }
}
```

---

## Kotlin / Jetpack Compose

### Kotlin 2.x Features

- **Coroutines**: Lightweight async/await. `suspend` functions, `Flow` for reactive streams.
- **Sealed classes**: Type-safe state representation.
- **Extension functions**: Add methods to existing classes.

```kotlin
sealed class Result<T> {
  data class Success<T>(val data: T) : Result<T>()
  data class Error<T>(val exception: Exception) : Result<T>()
  object Loading : Result<Nothing>()
}

fun <T> Flow<Result<T>>.filterSuccess(): Flow<T> = 
  filterIsInstance<Result.Success<T>>()
    .map { it.data }

// Usage
viewModel.users.filterSuccess().collect { users ->
  println(users)
}
```

### Compose Basics

```kotlin
@Composable
fun UserCard(user: User, onEdit: () -> Unit) {
  Card(modifier = Modifier.fillMaxWidth()) {
    Column(modifier = Modifier.padding(16.dp)) {
      Text(user.name, style = MaterialTheme.typography.titleMedium)
      Text(user.email, style = MaterialTheme.typography.bodySmall)
      Button(onClick = onEdit) {
        Text("Edit")
      }
    }
  }
}

// State hoisting
@Composable
fun UserListScreen() {
  var selectedUser by remember { mutableStateOf<User?>(null) }
  
  LazyColumn {
    items(users, key = { it.id }) { user ->
      UserCard(
        user = user,
        onEdit = { selectedUser = user },
      )
    }
  }
}
```

### Architecture

**MVI (Model-View-Intent)**:

```kotlin
// Intent (user actions)
sealed class UserIntent {
  data class LoadUsers(val page: Int) : UserIntent()
  object RefreshUsers : UserIntent()
}

// State
data class UserState(
  val users: List<User> = emptyList(),
  val isLoading: Boolean = false,
  val error: String? = null,
)

// ViewModel
@HiltViewModel
class UserViewModel @Inject constructor(
  private val getUsersUseCase: GetUsersUseCase,
) : ViewModel() {
  private val intent = MutableSharedFlow<UserIntent>()
  val state: StateFlow<UserState> = intent
    .flatMapLatest { intent ->
      when (intent) {
        is UserIntent.LoadUsers -> 
          getUsersUseCase(intent.page).map { UserState(users = it) }
        is UserIntent.RefreshUsers -> 
          getUsersUseCase(1).map { UserState(users = it) }
      }
    }
    .stateIn(viewModelScope, SharingStarted.Eagerly, UserState())

  fun handleIntent(intent: UserIntent) {
    viewModelScope.launch {
      this@UserViewModel.intent.emit(intent)
    }
  }
}

// UI
@Composable
fun UserListScreen(viewModel: UserViewModel = hiltViewModel()) {
  val state by viewModel.state.collectAsStateWithLifecycle()
  
  LazyColumn {
    items(state.users) { user ->
      UserCard(user)
    }
  }
  
  LaunchedEffect(Unit) {
    viewModel.handleIntent(UserIntent.LoadUsers(1))
  }
}
```

### Dependency Injection

**Hilt** (recommended):

```kotlin
@HiltViewModel
class UserViewModel @Inject constructor(
  private val repository: UserRepository,
) : ViewModel()

@Module
@InstallIn(SingletonComponent::class)
object DataModule {
  @Provides
  @Singleton
  fun provideUserRepository(api: ApiService): UserRepository =
    UserRepositoryImpl(api)
}
```

### Room Database

```kotlin
@Entity(tableName = "users")
data class UserEntity(
  @PrimaryKey val id: String,
  val name: String,
  val email: String,
)

@Dao
interface UserDao {
  @Query("SELECT * FROM users")
  fun getAllUsers(): Flow<List<UserEntity>>
  
  @Insert(onConflict = OnConflictStrategy.REPLACE)
  suspend fun insertUser(user: UserEntity)
}
```

### Testing

```kotlin
// JUnit + MockK
@Test
fun loadUsers_emitsData() = runTest {
  val mockUsers = listOf(User("1", "Alice"), User("2", "Bob"))
  coEvery { useCase(any()) } returns flowOf(mockUsers)
  
  val result = mutableListOf<List<User>>()
  viewModel.users.onEach { result.add(it) }.launchIn(backgroundScope)
  
  assertEquals(1, result.size)
  assertEquals(mockUsers, result.first())
}

// Compose Testing
@Composable fun testUserCard() {
  composeTestRule.setContent {
    UserCard(User("1", "Alice"))
  }
  composeTestRule.onNodeWithText("Alice").assertExists()
}
```

---

## Java / Android (Legacy & Enterprise)

### When Java Makes Sense

- **Legacy codebases**: Millions of lines of Java.
- **Enterprise teams**: Standardized Java expertise.
- **Cross-platform JVM backends**: Shared Java libraries.

### Java ↔ Kotlin Interop

```java
// Java class
public class UserRepository {
  public User getUser(String id) throws IOException {
    // ...
  }
}

// Kotlin call
val repo = UserRepository()
val user = repo.getUser("123") // Works seamlessly
```

```kotlin
// Kotlin suspend function
suspend fun fetchUser(id: String): User = withContext(Dispatchers.IO) {
  // ...
}

// Java call (from executor or callback)
UserViewModel vm = new UserViewModel();
// or wrap in callback adapter
```

### ViewModel + LiveData (Java)

```java
public class UserViewModel extends ViewModel {
  private final MutableLiveData<List<User>> usersLiveData = 
    new MutableLiveData<>();
  private final UserRepository repository;

  public UserViewModel(UserRepository repo) {
    this.repository = repo;
  }

  public LiveData<List<User>> getUsers() {
    return usersLiveData;
  }

  public void loadUsers() {
    ExecutorService executor = Executors.newSingleThreadExecutor();
    executor.execute(() -> {
      try {
        List<User> users = repository.getUsers();
        usersLiveData.postValue(users);
      } catch (Exception e) {
        e.printStackTrace();
      }
    });
  }
}

// Activity
public class UserListActivity extends AppCompatActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_user_list);
    
    UserViewModel vm = new ViewModelProvider(this)
      .get(UserViewModel.class);
    
    vm.getUsers().observe(this, users -> {
      // Update UI
      adapter.setUsers(users);
    });
    
    vm.loadUsers();
  }
}
```

### Dagger 2 DI

```java
@Singleton
@Component(modules = { ApiModule.class, RepositoryModule.class })
public interface AppComponent {
  void inject(UserListActivity activity);
}

@Module
public class ApiModule {
  @Provides
  @Singleton
  ApiService provideApiService() {
    return new Retrofit.Builder()
      .baseUrl("https://api.example.com")
      .addConverterFactory(GsonConverterFactory.create())
      .build()
      .create(ApiService.class);
  }
}

@Module
public class RepositoryModule {
  @Provides
  @Singleton
  UserRepository provideUserRepository(ApiService api) {
    return new UserRepository(api);
  }
}
```

### XML Layouts + Compose Interop

```xml
<!-- activity_user_list.xml -->
<LinearLayout ...>
  <TextView android:id="@+id/title" ... />
  <ComposeView android:id="@+id/compose_view" ... />
</LinearLayout>
```

```java
// Activity
ComposeView composeView = findViewById(R.id.compose_view);
composeView.setContent(() -> 
  new ComposeUserListKt.UserListScreen()
);
```

### Migration Path (Java → Kotlin)

1. **Incrementally convert**: File-by-file, not big-bang rewrite.
2. **Start with data classes**: Kotlin reduces boilerplate.
3. **Use coroutines**: Replace ExecutorService/callbacks.
4. **Adopt sealed classes**: Better than Java enums.

---

## Comparison Matrix

| Aspect | React Native | Flutter | SwiftUI | Compose | Java Android |
|--------|--------------|---------|---------|---------|--------------|
| Language | TypeScript/JS | Dart | Swift | Kotlin | Java |
| Learning Curve | Medium | Medium | Steep | Medium | Steep |
| Performance | Good (Hermes) | Excellent | Excellent | Excellent | Excellent |
| UI Flexibility | High | Very High | High | Very High | Medium |
| Community | Very Large | Large | Large | Large | Huge |
| Cross-Platform | iOS/Android | iOS/Android/Web | iOS only | Android only | Android only |
| Hot Reload | Yes | Yes | Yes | Yes | No |
| Native Modules | Complex | Platform channels | Swift/ObjC | Kotlin/JNI | Java/JNI |

---

## Decision Framework

**Choose React Native if:**
- Team knows JavaScript/TypeScript
- Need rapid cross-platform release
- Can live with 85–95% code reuse

**Choose Flutter if:**
- Need maximum UI customization
- Want single codebase (iOS/Android/Web/Desktop)
- Team comfortable learning Dart

**Choose SwiftUI if:**
- iOS-first product
- Want native performance + idioms
- Team is iOS-experienced

**Choose Compose if:**
- Android-first product
- Want modern reactive UI
- Team knows Kotlin/JVM

**Choose Java Android if:**
- Maintaining legacy Java codebase
- Enterprise team standardization required
- Deep JVM library ecosystem needed

