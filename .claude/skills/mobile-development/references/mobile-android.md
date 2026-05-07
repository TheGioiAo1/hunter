# Android Native Development Reference

## 1. Kotlin Modern Patterns

### Kotlin 2.x Key Features

Kotlin 2.x brings powerful abstractions for Android development:

- **Null Safety**: Type system prevents null pointer exceptions at compile time
- **Coroutines**: Lightweight threads for async operations without callback hell
- **Extension Functions**: Add methods to existing classes without inheritance
- **Sealed Classes**: Type-safe enums for restricted class hierarchies
- **Data Classes**: Auto-generate `equals()`, `hashCode()`, `toString()`, `copy()`

### Coroutines Example

```kotlin
class UserViewModel : ViewModel() {
    private val _userState = MutableStateFlow<User?>(null)
    val userState: StateFlow<User?> = _userState.asStateFlow()

    fun fetchUser(userId: String) {
        viewModelScope.launch {
            try {
                val user = withContext(Dispatchers.IO) {
                    userRepository.getUser(userId)
                }
                _userState.value = user
            } catch (e: Exception) {
                // Handle error
            }
        }
    }
}
```

### Flow (Reactive Streams) Example

```kotlin
class UserRepository @Inject constructor(
    private val userDao: UserDao
) {
    fun observeUsers(): Flow<List<User>> = userDao.getAllUsers()
        .map { users -> users.filter { it.isActive } }
        .catch { e -> emit(emptyList()) }
        .flowOn(Dispatchers.IO)
}

// Usage in ViewModel
val users: StateFlow<List<User>> = userRepository.observeUsers()
    .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
```

### Sealed Classes for State Management

```kotlin
sealed class LoginState {
    data object Loading : LoginState()
    data class Success(val user: User) : LoginState()
    data class Error(val message: String) : LoginState()
}

class LoginViewModel : ViewModel() {
    private val _state = MutableStateFlow<LoginState>(LoginState.Loading)
    val state: StateFlow<LoginState> = _state.asStateFlow()

    fun login(email: String, password: String) {
        viewModelScope.launch {
            _state.value = LoginState.Loading
            _state.value = try {
                val user = authRepository.login(email, password)
                LoginState.Success(user)
            } catch (e: Exception) {
                LoginState.Error(e.message ?: "Unknown error")
            }
        }
    }
}
```

---

## 2. Java Android Patterns

### When Java Makes Sense

- **Legacy Codebases**: Existing Java projects with large teams
- **Enterprise Environments**: Organizations requiring Java skills standardization
- **Java-Fluent Teams**: Developers comfortable with traditional Java patterns
- **Gradle Plugin Compatibility**: Some legacy Gradle plugins work better with Java

### ViewModel + LiveData in Java

```java
public class UserViewModel extends ViewModel {
    private final UserRepository userRepository;
    private final MutableLiveData<User> userLiveData = new MutableLiveData<>();
    public LiveData<User> getUser() {
        return userLiveData;
    }

    public UserViewModel(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    public void fetchUser(String userId) {
        new Thread(() -> {
            try {
                User user = userRepository.getUser(userId);
                userLiveData.postValue(user);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }).start();
    }
}
```

### Dagger 2 DI Setup in Java

```java
@Module
public class RepositoryModule {
    @Provides
    @Singleton
    public UserRepository provideUserRepository(UserDao userDao) {
        return new UserRepository(userDao);
    }
}

@Component(modules = {RepositoryModule.class, DatabaseModule.class})
@Singleton
public interface AppComponent {
    void inject(MainActivity activity);
}

// In Application class
public class MyApp extends Application {
    public static AppComponent appComponent;

    @Override
    public void onCreate() {
        super.onCreate();
        appComponent = DaggerAppComponent.create();
    }
}
```

### Java ↔ Kotlin Interoperability

```java
// Java calling Kotlin suspend function
public class JavaViewModel {
    private final KotlinRepository repo;

    public void loadData() {
        // Wrap suspend function with coroutines
        CoroutineScope scope = new MainScope();
        scope.launch(() -> {
            try {
                User user = repo.getUser("123");
                updateUI(user);
            } catch (Exception e) {
                handleError(e);
            }
            return Unit.INSTANCE;
        });
    }
}

// Kotlin annotations for Java compatibility
public class JavaRepository {
    @Nullable
    public User getUser(String id) { return null; }

    @NonNull
    public List<String> getNames() { return Collections.emptyList(); }

    @JvmStatic
    public String formatName(String first, String last) {
        return first + " " + last;
    }

    @JvmOverloads
    public void fetchData(String id, int timeout = 5000) { }
}
```

### Migration Strategy

1. **Keep Java and Kotlin in Same Project**: Gradle handles interop automatically
2. **New Features in Kotlin**: Write all new code in Kotlin for modern benefits
3. **Interop Layer**: Create interfaces for Java-Kotlin communication
4. **File-by-File Migration**: Convert legacy Java gradually, prioritize high-usage files
5. **Test-Driven**: Write tests first, migrate implementations, ensure tests pass

---

## 3. Jetpack Compose

### Why Compose

- **Declarative UI**: Describe what UI should look like, not how to build it
- **Modern Adoption**: 60%+ of new Android projects use Compose (2024 survey)
- **Less Boilerplate**: 50-70% fewer lines vs XML + ViewModel
- **Material 3**: Built-in Material Design 3 support with dynamic colors

### Basic Composables Example

```kotlin
@Composable
fun UserListScreen(
    users: List<User> = emptyList(),
    onUserClick: (User) -> Unit = {}
) {
    var searchQuery by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxSize()) {
        SearchBar(
            value = searchQuery,
            onValueChange = { searchQuery = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp)
        )

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp)
        ) {
            items(
                items = users.filter { it.name.contains(searchQuery) },
                key = { it.id }
            ) { user ->
                UserCard(
                    user = user,
                    onClick = { onUserClick(user) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp)
                )
            }
        }
    }
}

@Composable
fun UserCard(user: User, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.clickable(onClick = onClick),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            AsyncImage(model = user.avatarUrl, contentDescription = null)
            Column(modifier = Modifier.weight(1f).padding(start = 16.dp)) {
                Text(user.name, style = MaterialTheme.typography.titleMedium)
                Text(user.email, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
```

### Key Composables Reference

| Composable | Purpose | Notes |
|-----------|---------|-------|
| `Column` / `Row` | Layout containers | Use for linear layouts |
| `LazyColumn` / `LazyRow` | Scrollable lists | Lazy loads items (like RecyclerView) |
| `Box` | Layering composables | Overlapping content |
| `Card` | Elevated surface | Material 3 card with elevation |
| `TextField` / `OutlinedTextField` | Text input | State managed via `mutableStateOf` |
| `Button` / `FilledButton` | Interactive buttons | Material 3 variants |
| `AsyncImage` | Image loading | From Coil library |
| `LazyGrid` | Grid layout | Multi-column lists |

### XML to Compose Migration Notes

- **State Management**: Replace `findViewById` + manual updates with `remember { mutableStateOf() }`
- **Themes**: XML themes → `MaterialTheme` Composable
- **Fragments**: Replace Fragment + XML layout with Composable screens
- **ConstraintLayout**: Use `Column`, `Row`, `Box`, or `Modifier` alignments
- **RecyclerView**: Replace with `LazyColumn` / `LazyGrid`

---

## 4. Architecture Patterns

### MVVM with Clean Architecture

```kotlin
// Layer 1: Domain (Use Cases)
class GetUserUseCase @Inject constructor(
    private val userRepository: UserRepository
) {
    suspend operator fun invoke(userId: String): User = 
        userRepository.fetchUser(userId)
}

// Layer 2: Data (Repository)
class UserRepository @Inject constructor(
    private val userApi: UserApi,
    private val userDao: UserDao
) {
    suspend fun fetchUser(userId: String): User {
        return try {
            val user = userApi.getUser(userId)
            userDao.insert(user)
            user
        } catch (e: Exception) {
            userDao.getUserById(userId) // Return cached version
        }
    }
}

// Layer 3: Presentation (ViewModel)
@HiltViewModel
class UserViewModel @Inject constructor(
    private val getUserUseCase: GetUserUseCase
) : ViewModel() {
    private val _uiState = MutableStateFlow<UiState>(UiState.Loading)
    val uiState: StateFlow<UiState> = _uiState.asStateFlow()

    fun loadUser(userId: String) {
        viewModelScope.launch {
            try {
                _uiState.value = UiState.Loading
                val user = getUserUseCase(userId)
                _uiState.value = UiState.Success(user)
            } catch (e: Exception) {
                _uiState.value = UiState.Error(e.message ?: "Unknown error")
            }
        }
    }
}

// UI State
sealed class UiState {
    data object Loading : UiState()
    data class Success(val user: User) : UiState()
    data class Error(val message: String) : UiState()
}

// Layer 4: UI (Composable)
@Composable
fun UserScreen(viewModel: UserViewModel = hiltViewModel()) {
    val uiState by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.loadUser("user123")
    }

    when (val state = uiState) {
        is UiState.Loading -> LoadingScreen()
        is UiState.Success -> UserDetailScreen(state.user)
        is UiState.Error -> ErrorScreen(state.message)
    }
}
```

### MVI Pattern (State + Events + ViewModel)

```kotlin
// Intent (User Actions)
sealed class UserIntent {
    data class LoadUser(val userId: String) : UserIntent()
    data class UpdateName(val newName: String) : UserIntent()
    data object Logout : UserIntent()
}

// State
data class UserMviState(
    val isLoading: Boolean = false,
    val user: User? = null,
    val error: String? = null
)

// ViewModel
@HiltViewModel
class UserMviViewModel @Inject constructor(
    private val getUserUseCase: GetUserUseCase
) : ViewModel() {
    private val _state = MutableStateFlow(UserMviState())
    val state: StateFlow<UserMviState> = _state.asStateFlow()

    fun handleIntent(intent: UserIntent) {
        when (intent) {
            is UserIntent.LoadUser -> loadUser(intent.userId)
            is UserIntent.UpdateName -> updateName(intent.newName)
            is UserIntent.Logout -> logout()
        }
    }

    private fun loadUser(userId: String) {
        viewModelScope.launch {
            _state.update { it.copy(isLoading = true) }
            try {
                val user = getUserUseCase(userId)
                _state.update { it.copy(user = user, isLoading = false) }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message, isLoading = false) }
            }
        }
    }

    private fun updateName(newName: String) {
        _state.update { it.copy(user = it.user?.copy(name = newName)) }
    }

    private fun logout() {
        _state.value = UserMviState()
    }
}

// Usage in Composable
@Composable
fun UserMviScreen(viewModel: UserMviViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()

    if (state.isLoading) {
        LoadingScreen()
    } else if (state.error != null) {
        ErrorScreen(state.error!!)
    } else if (state.user != null) {
        UserDisplay(state.user!!) {
            viewModel.handleIntent(UserIntent.UpdateName(it))
        }
    }
}
```

---

## 5. Dependency Injection

### Hilt (Recommended for Large Apps)

```kotlin
// Application class
@HiltAndroidApp
class MyApplication : Application()

// Module
@Module
@InstallIn(SingletonComponent::class)
object RepositoryModule {
    @Provides
    @Singleton
    fun provideUserRepository(
        userApi: UserApi,
        userDao: UserDao
    ): UserRepository = UserRepository(userApi, userDao)

    @Provides
    @Singleton
    fun provideUserApi(): UserApi = Retrofit.Builder()
        .baseUrl("https://api.example.com/")
        .build()
        .create(UserApi::class.java)
}

// ViewModel with Hilt
@HiltViewModel
class UserViewModel @Inject constructor(
    private val userRepository: UserRepository
) : ViewModel()

// Activity/Fragment with Hilt
@AndroidEntryPoint
class MainActivity : AppCompatActivity() {
    private val viewModel: UserViewModel by viewModels()
}
```

### Koin (Lightweight Alternative)

```kotlin
// Modules
val repositoryModule = module {
    single { UserRepository(get(), get()) }
    single { provideUserApi() }
}

val viewModelModule = module {
    viewModel { UserViewModel(get()) }
}

// Application setup
class MyApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        startKoin {
            androidLogger()
            androidContext(this@MyApplication)
            modules(repositoryModule, viewModelModule)
        }
    }
}

// Usage in ViewModel
class UserViewModel(
    private val userRepository: UserRepository
) : ViewModel()

// Usage in Activity
class MainActivity : AppCompatActivity() {
    private val viewModel: UserViewModel by viewModel()
}
```

### Dagger 2 (Enterprise Java Standard)

Already shown in Java patterns section. Comparison below.

### DI Framework Comparison

| Framework | Language | Use Case | Learning Curve | Performance |
|-----------|----------|----------|-----------------|-------------|
| **Hilt** | Kotlin | Modern large apps | Easy | Excellent |
| **Koin** | Kotlin | Small-medium apps | Very Easy | Good |
| **Dagger 2** | Java/Kotlin | Enterprise legacy | Hard | Excellent |

---

## 6. Performance Optimization

### R8/ProGuard Configuration

```gradle
android {
    buildTypes {
        release {
            minifyEnabled true
            shrinkResources true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}

// proguard-rules.pro
-keep public class * extends android.app.Activity
-keep public class * extends androidx.lifecycle.ViewModel
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
```

### Baseline Profiles

Create `src/main/baseline-prof.txt` to pre-compile critical code paths:

```
Hhot/Lcomo/example/UserViewModel;->loadUser(Ljava/lang/String;)V
Hhot/Lcomo/example/UserRepository;->fetchUser(Ljava/lang/String;)Ljava/lang/Object;
```

### Compose Recomposition Avoidance

```kotlin
@Composable
fun ExpensiveComposable(
    data: User,
    modifier: Modifier = Modifier
) {
    // Expensive computation memoized
    val processedData by remember(data) {
        derivedStateOf { 
            expensiveTransformation(data) 
        }
    }

    Text(processedData)
}

// Use @Stable to prevent recomposition
@Stable
data class User(
    val id: String,
    val name: String,
    val email: String
)
```

---

## 7. Testing

### JUnit + MockK (Kotlin)

```kotlin
class UserViewModelTest {
    @get:Rule
    val instantExecutorRule = InstantTaskExecutorRule()

    private lateinit var viewModel: UserViewModel
    private val userRepository: UserRepository = mockk()

    @Before
    fun setup() {
        viewModel = UserViewModel(userRepository)
    }

    @Test
    fun testLoadUserSuccess() = runTest {
        val testUser = User(id = "1", name = "John", email = "john@example.com")
        coEvery { userRepository.fetchUser("1") } returns testUser

        viewModel.loadUser("1")
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assert(state is UiState.Success)
        assertEquals(testUser, (state as UiState.Success).user)
    }

    @Test
    fun testLoadUserError() = runTest {
        coEvery { userRepository.fetchUser("1") } throws Exception("Network error")

        viewModel.loadUser("1")
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assert(state is UiState.Error)
    }
}
```

### JUnit + Mockito (Java)

```java
public class UserViewModelJavaTest {
    private UserViewModel viewModel;
    @Mock private UserRepository userRepository;

    @Before
    public void setup() {
        MockitoAnnotations.openMocks(this);
        viewModel = new UserViewModel(userRepository);
    }

    @Test
    public void testLoadUserSuccess() {
        User testUser = new User("1", "John", "john@example.com");
        when(userRepository.getUser("1")).thenReturn(testUser);

        viewModel.fetchUser("1");

        assertEquals(testUser.getName(), "John");
        verify(userRepository).getUser("1");
    }
}
```

### Compose Testing

```kotlin
class UserScreenTest {
    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun testUserListDisplay() {
        val users = listOf(
            User("1", "Alice", "alice@example.com"),
            User("2", "Bob", "bob@example.com")
        )

        composeTestRule.setContent {
            UserListScreen(users = users)
        }

        composeTestRule.onNodeWithText("Alice").assertIsDisplayed()
        composeTestRule.onNodeWithText("Bob").assertIsDisplayed()
    }

    @Test
    fun testUserCardClickable() {
        var clickedUser: User? = null
        val user = User("1", "Alice", "alice@example.com")

        composeTestRule.setContent {
            UserCard(user = user) { clickedUser = user }
        }

        composeTestRule.onNodeWithText("Alice").performClick()
        assertEquals(user, clickedUser)
    }
}
```

### Espresso (Instrumented Testing)

```kotlin
class UserActivityTest {
    @get:Rule
    val activityRule = ActivityScenarioRule(MainActivity::class.java)

    @Test
    fun testUserListDisplayed() {
        onView(withId(R.id.user_list))
            .check(matches(isDisplayed()))

        onView(withText("John Doe"))
            .check(matches(isDisplayed()))
    }

    @Test
    fun testUserClickNavigation() {
        onView(withText("John Doe")).perform(click())

        onView(withText("john@example.com"))
            .check(matches(isDisplayed()))
    }
}
```

---

## 8. Material Design 3

### Theme Setup with Dynamic Colors

```kotlin
// colors.xml (optional, for non-dynamic baseline)
<color name="md3_primary">#6750A4</color>
<color name="md3_secondary">#625B71</color>

// Theme.kt (Modern approach)
@Composable
fun MyAppTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context)
            else dynamicLightColorScheme(context)
        }
        darkTheme -> darkColorScheme()
        else -> lightColorScheme()
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography(),
        content = content
    )
}

// Usage
@Composable
fun MyApp() {
    MyAppTheme {
        Surface(color = MaterialTheme.colorScheme.background) {
            MainScreen()
        }
    }
}
```

### Key Components

| Component | Purpose | Example |
|-----------|---------|---------|
| **Card** | Surface container | `Card { Text("Content") }` |
| **FAB** | Floating action button | `FloatingActionButton { Icon(...) }` |
| **NavigationBar** | Bottom navigation | `NavigationBar { NavigationBarItem(...) }` |
| **TopAppBar** | Header bar | `TopAppBar { Text("Title") }` |
| **Snackbar** | Toast alternative | `Snackbar { Text("Message") }` |
| **Dialog** | Modal dialogs | `AlertDialog { ... }` |

---

## 9. Google Play Requirements

### Target API Level

- **Minimum**: API 24 (Android 7.0)
- **Target**: API 35+ (mandatory as of August 2025)
- **Check Current**: Visit [Google Play Console Policies](https://support.google.com/googleplay)

```gradle
android {
    compileSdk 35
    defaultConfig {
        targetSdkVersion 35
        minSdkVersion 24
    }
}
```

### Privacy & Data Safety

- Declare all data types collected (location, contacts, calendar, etc.)
- Implement privacy policies accessible from app
- Use encrypted storage for sensitive data (EncryptedSharedPreferences, TINK)
- Request permissions via new Permission model (Android 6.0+)
- Disclose third-party SDKs and data sharing

### App Bundle (AAB) Distribution

```gradle
android {
    bundle {
        language {
            enableSplit = true
        }
        density {
            enableSplit = true
        }
        abi {
            enableSplit = true
        }
    }
}
```

Benefits: 35% smaller downloads, optimized per device, automatic Play Store signing.

---

## 10. Common Pitfalls

1. **Memory Leaks via Context**: Never pass Activity context to long-lived objects. Use `applicationContext` or weak references.

2. **Blocking Main Thread**: Network calls, database queries, or heavy computation on main thread crashes app. Use coroutines + `Dispatchers.IO`.

3. **Not Handling Lifecycle**: ViewModels survive configuration changes, but Activities don't. Observe lifecycle-aware components in `onStart()`, clear in `onStop()`.

4. **Fragment State Loss**: Committing transactions after `onSaveInstanceState()` causes crashes. Use `commitNow()` or `executeAllowingStateLoss()` carefully.

5. **Excessive Recomposition in Compose**: Passing unstable state to Composables causes unnecessary recomposition. Use `@Stable` annotations and `remember` for expensive computations.

6. **Not Testing Edge Cases**: Offline scenarios, network timeouts, null safety, and state restoration are common crash sources.

7. **Resource Leaks**: Listeners, observers, and subscriptions must be unsubscribed. Use `viewLifecycleOwner` scope in Fragments to auto-cleanup.

8. **Incorrect Coroutine Scope**: Using `GlobalScope` or wrong scope leads to leaks. Always use `viewModelScope`, `lifecycleScope`, or launch from bound scope.

9. **Mixing Java and Kotlin Null Semantics**: Kotlin `!= null` doesn't guarantee Java types. Use `@Nullable`/`@NonNull` annotations for interop.

10. **Ignoring Signed APK Requirements**: Development APKs differ from release APKs (minification, signing key). Always test release builds before Play Store upload.
