# iOS Native Development Reference

## 1. Swift 6 Overview

Swift 6 introduces compile-time data race safety, making multithreading safer by default. Key features:

- **Data Race Safety**: Compiler prevents shared mutable state across threads (strict concurrency checking)
- **Async/Await**: Structured concurrency replaces callback hell and GCD complexity
- **Actors**: Reference types that protect mutable state from concurrent access
- **@MainActor**: Enforces code execution on main thread (essential for UI updates)
- **Macros**: Code generation at compile time (@Observable, @Entry)
- **Move Semantics**: Ownership tracking prevents accidental copies of expensive types

### Async/Await Example

```swift
// Modern async/await (Swift 5.5+)
func fetchUser(id: String) async throws -> User {
    let url = URL(string: "https://api.example.com/users/\(id)")!
    let (data, _) = try await URLSession.shared.data(from: url)
    return try JSONDecoder().decode(User.self, from: data)
}

// Usage in SwiftUI
@main
struct ContentView: View {
    @State var user: User?
    
    var body: some View {
        VStack {
            if let user = user {
                Text(user.name)
            }
        }
        .task {
            do {
                user = try await fetchUser(id: "123")
            } catch {
                print("Error: \(error)")
            }
        }
    }
}
```

### Actor Example

```swift
// Thread-safe counter using actor
actor Counter {
    private var count = 0
    
    func increment() {
        count += 1
    }
    
    func value() -> Int {
        count
    }
}

// Usage
let counter = Counter()
await counter.increment()
let currentValue = await counter.value()
```

---

## 2. SwiftUI vs UIKit

### When to Use SwiftUI

- **New projects** targeting iOS 13+ (iOS 14+ recommended for stability)
- **Rapid prototyping** with live preview feedback
- **Cross-Apple-platform** apps (iOS, macOS, watchOS, tvOS same codebase)
- **Declarative** UI preferred over imperative
- **Modern language features** (property wrappers, macros)

### When to Use UIKit

- **Legacy codebases** (huge refactor cost for SwiftUI)
- **Complex custom animations** or views (SwiftUI limitations)
- **iOS 12 support** required
- **Deep customization** of system controls
- **Performance-critical** rendering (rare; SwiftUI usually faster)

### SwiftUI Basics

```swift
import SwiftUI

struct ContentView: View {
    @State var count = 0
    @Environment(\.colorScheme) var colorScheme
    
    var body: some View {
        VStack(spacing: 20) {
            Text("Count: \(count)")
                .font(.title)
                .foregroundColor(.blue)
            
            Button(action: { count += 1 }) {
                Label("Increment", systemImage: "plus")
                    .padding()
                    .background(Color.blue)
                    .foregroundColor(.white)
                    .cornerRadius(8)
            }
            
            List(1...count, id: \.self) { num in
                Text("Item \(num)")
            }
        }
        .padding()
        .background(colorScheme == .dark ? Color.black : Color.white)
    }
}

#Preview {
    ContentView()
}
```

### Property Wrappers

| Wrapper | Use Case | Scope |
|---------|----------|-------|
| `@State` | Local mutable state, simple types | View only |
| `@Binding` | Two-way binding to parent's state | Parameter passing |
| `@StateObject` | Owns observable object lifecycle | View ownership |
| `@ObservedObject` | References parent's observable object | View observes |
| `@EnvironmentObject` | Global app state (theme, auth, etc.) | Subtree access |
| `@Published` | Mark property that emits changes | ObservableObject |

---

## 3. Architecture

### MVVM (Model-View-ViewModel)

Most popular iOS pattern. ViewModel transforms Model data for View consumption.

```swift
// Model
struct User: Codable {
    let id: String
    let name: String
    let email: String
}

// ViewModel (Observable)
@MainActor
final class UserViewModel: ObservableObject {
    @Published var user: User?
    @Published var isLoading = false
    @Published var errorMessage: String?
    
    private let apiService: APIService
    
    init(apiService: APIService = .shared) {
        self.apiService = apiService
    }
    
    func loadUser(id: String) async {
        isLoading = true
        defer { isLoading = false }
        
        do {
            user = try await apiService.fetchUser(id: id)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
            user = nil
        }
    }
}

// View
struct UserView: View {
    @StateObject var viewModel = UserViewModel()
    let userId: String
    
    var body: some View {
        Group {
            if viewModel.isLoading {
                ProgressView()
            } else if let user = viewModel.user {
                VStack(alignment: .leading, spacing: 8) {
                    Text(user.name).font(.title2)
                    Text(user.email).foregroundColor(.gray)
                }
            } else if let error = viewModel.errorMessage {
                Text("Error: \(error)").foregroundColor(.red)
            }
        }
        .task {
            await viewModel.loadUser(id: userId)
        }
    }
}
```

### The Composable Architecture (TCA)

Redux-like pattern with unidirectional data flow. Popular for complex state management.

**When to use:**
- Multiple interconnected features with shared state
- Predictable state mutations (testability)
- Time-travel debugging needs

**Trade-offs:**
- Steeper learning curve
- More boilerplate initially
- Excellent for large teams and complex apps

---

## 4. Performance Optimization

### Compiler Optimizations

```swift
// Use 'final' on classes that won't be subclassed
final class APIService {
    // Compiler can inline all methods
    func fetchData() async throws -> Data { ... }
}

// Mark private methods (enables inline optimization)
private func processData(_ data: Data) -> [User] { ... }

// Build settings: Optimization Level = `-Osize` (balanced) or `-O` (aggressive)
// Whole Module Optimization = ON (improves cross-function inlining)
```

### ARC & Retain Cycles

```swift
// Prevent retain cycle in closures
final class ViewController: UIViewController {
    private let dataService = DataService()
    
    func fetchData() {
        dataService.fetchAsync { [weak self] result in
            // [weak self] prevents self from being retained by closure
            guard let self = self else { return }
            self.handleResult(result)
        }
    }
}

// @escaping closures can capture 'self' strongly; use [weak self] with .task/.onReceive
@MainActor
class ViewModel: ObservableObject {
    func loadData() {
        Task {
            // Task automatically captures self weakly, safe in SwiftUI
            let data = try await fetchData()
            self.data = data
        }
    }
}
```

### SwiftUI Performance

```swift
// INEFFICIENT: Recomputes entire list on every state change
struct ListView: View {
    @State var items: [Item] = []
    
    var body: some View {
        List(items) { item in
            ExpensiveRowView(item: item)
        }
    }
}

// EFFICIENT: Extract static/memoized components
struct ListView: View {
    @State var items: [Item] = []
    
    var body: some View {
        List(items) { item in
            RowContent(item: item)  // Extracted, reuses Identity
        }
    }
}

struct RowContent: View {
    let item: Item
    
    var body: some View {
        // Only recomputes when 'item' changes
        ExpensiveRowView(item: item)
    }
}

// Use .equatable() to prevent unnecessary redraws
struct DetailsView: View {
    let user: User
    
    var body: some View {
        Text(user.name)
            .font(.title)
    }
}
.equatable()  // Only redraws if 'user' changes (Equatable required)
```

---

## 5. Testing

### XCTest Unit Testing

```swift
import XCTest
@testable import MyApp

final class UserViewModelTests: XCTestCase {
    var sut: UserViewModel!  // System Under Test
    var mockAPI: MockAPIService!
    
    override func setUp() {
        super.setUp()
        mockAPI = MockAPIService()
        sut = UserViewModel(apiService: mockAPI)
    }
    
    override func tearDown() {
        sut = nil
        mockAPI = nil
        super.tearDown()
    }
    
    @MainActor
    func testLoadUserSuccess() async throws {
        // Arrange
        let expectedUser = User(id: "1", name: "John", email: "john@example.com")
        mockAPI.mockUser = expectedUser
        
        // Act
        await sut.loadUser(id: "1")
        
        // Assert
        XCTAssertEqual(sut.user, expectedUser)
        XCTAssertNil(sut.errorMessage)
        XCTAssertFalse(sut.isLoading)
    }
    
    @MainActor
    func testLoadUserFailure() async {
        // Arrange
        mockAPI.mockError = APIError.networkError
        
        // Act
        await sut.loadUser(id: "invalid")
        
        // Assert
        XCTAssertNil(sut.user)
        XCTAssertNotNil(sut.errorMessage)
    }
}

// Mock Service
class MockAPIService: APIService {
    var mockUser: User?
    var mockError: Error?
    
    override func fetchUser(id: String) async throws -> User {
        if let error = mockError {
            throw error
        }
        return mockUser ?? User(id: "", name: "", email: "")
    }
}
```

### XCUITest UI Testing

```swift
import XCTest

final class LoginFlowUITests: XCTestCase {
    let app = XCUIApplication()
    
    override func setUp() {
        super.setUp()
        app.launch()
    }
    
    func testSuccessfulLogin() {
        let emailField = app.textFields["emailField"]
        let passwordField = app.secureTextFields["passwordField"]
        let loginButton = app.buttons["loginButton"]
        
        emailField.tap()
        emailField.typeText("user@example.com")
        
        passwordField.tap()
        passwordField.typeText("password123")
        
        loginButton.tap()
        
        // Wait for navigation
        let homeScreen = app.staticTexts["Welcome"]
        XCTAssertTrue(homeScreen.waitForExistence(timeout: 5))
    }
    
    func testErrorHandling() {
        let emailField = app.textFields["emailField"]
        let loginButton = app.buttons["loginButton"]
        
        emailField.tap()
        emailField.typeText("invalid@email")
        loginButton.tap()
        
        let errorAlert = app.alerts["Error"]
        XCTAssertTrue(errorAlert.exists)
    }
}
```

### Coverage Targets

- **Aim for 70%+ code coverage** on core business logic
- **100% on critical paths** (auth, payments, data validation)
- **Skip testing**: UI layout, trivial getters, Apple framework calls

---

## 6. iOS Features

### WidgetKit (Home Screen Widget)

```swift
import WidgetKit
import SwiftUI

// Widget Data Model
struct WidgetEntry: TimelineEntry {
    let date: Date
    let currentUser: User?
    let unreadCount: Int
}

// Provider (Timeline Generation)
struct UserWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> WidgetEntry {
        WidgetEntry(date: Date(), currentUser: nil, unreadCount: 0)
    }
    
    func getSnapshot(in context: Context, completion: @escaping (WidgetEntry) -> ()) {
        let entry = WidgetEntry(date: Date(), currentUser: nil, unreadCount: 0)
        completion(entry)
    }
    
    func getTimeline(in context: Context, completion: @escaping (Timeline<WidgetEntry>) -> ()) {
        Task {
            do {
                let user = try await APIService.shared.fetchCurrentUser()
                let unread = try await APIService.shared.fetchUnreadCount()
                
                let entry = WidgetEntry(date: Date(), currentUser: user, unreadCount: unread)
                let timeline = Timeline(entries: [entry], policy: .after(Date(timeIntervalSinceNow: 300)))
                completion(timeline)
            } catch {
                completion(Timeline(entries: [], policy: .never))
            }
        }
    }
}

// Widget View
struct UserWidgetEntryView: View {
    var entry: UserWidgetProvider.Entry
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let user = entry.currentUser {
                Text(user.name).font(.headline)
                HStack {
                    Image(systemName: "envelope.fill")
                    Text("\(entry.unreadCount) messages")
                }
                .font(.caption)
                .foregroundColor(.gray)
            } else {
                Text("Loading...").redacted(reason: .placeholder)
            }
        }
        .padding()
    }
}

@main
struct UserWidget: Widget {
    let kind: String = "UserWidget"
    
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: UserWidgetProvider()) { entry in
            UserWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("My User Widget")
        .description("Shows current user info and unread messages")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
```

### Live Activities (Lock Screen)

```swift
import ActivityKit

// Activity Attributes
struct OrderTrackingAttributes: ActivityAttributes {
    public typealias OrderStatus = ContentState
    
    struct ContentState: Codable, Hashable {
        var status: String  // "preparing", "shipped", "delivered"
        var estimatedTime: Date
    }
    
    var orderId: String
    var storeName: String
}

// Start Live Activity
func startOrderTracking(orderId: String) {
    let attributes = OrderTrackingAttributes(orderId: orderId, storeName: "MyStore")
    let contentState = OrderTrackingAttributes.ContentState(status: "preparing", estimatedTime: Date().addingTimeInterval(3600))
    
    do {
        let activity = try Activity<OrderTrackingAttributes>.request(
            attributes: attributes,
            contentState: contentState,
            pushType: .token
        )
        print("Activity started: \(activity.id)")
    } catch {
        print("Failed to start activity: \(error)")
    }
}

// Update Live Activity
func updateOrderStatus(to status: String, activityId: String) {
    Task {
        for activity in Activity<OrderTrackingAttributes>.all {
            if activity.id == activityId {
                var contentState = activity.contentState
                contentState.status = status
                await activity.update(using: contentState)
            }
        }
    }
}
```

### App Clips Overview

- **Small app bundles** (~10 MB) launched from NFC, QR codes, links, or App Clip codes
- **User experience**: Instant access without full app install (link → clip → full app)
- **Use cases**: Parking meters, restaurant menus, event tickets
- **Implementation**: Share code via frameworks; clip and full app target both link to shared code
- **Testing**: Use App Clip debug mode in Xcode to preview without full installation

---

## 7. Human Interface Guidelines (HIG)

### Navigation Patterns

```swift
// Tab Bar Navigation
@main
struct TabBarApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                HomeView()
                    .tabItem {
                        Label("Home", systemImage: "house.fill")
                    }
                
                SearchView()
                    .tabItem {
                        Label("Search", systemImage: "magnifyingglass")
                    }
                
                SettingsView()
                    .tabItem {
                        Label("Settings", systemImage: "gear")
                    }
            }
        }
    }
}

// Navigation Stack (iOS 16+)
struct DetailView: View {
    @State var path: [String] = []
    
    var body: some View {
        NavigationStack(path: $path) {
            VStack {
                NavigationLink("Go to Detail", value: "detail1")
            }
            .navigationDestination(for: String.self) { id in
                Text("Detail: \(id)")
                    .navigationTitle("Details")
            }
        }
    }
}

// Modal Presentation
struct ModalView: View {
    @State var showSettings = false
    
    var body: some View {
        VStack {
            Button("Show Settings") { showSettings = true }
        }
        .sheet(isPresented: $showSettings) {
            SettingsModal()
        }
    }
}
```

### Design Principles

1. **Clarity**: Text is legible; icons are clear; functionality is obvious
2. **Deference**: Content takes focus; UI supports without intrusion
3. **Depth**: Visual hierarchy via scale, color, spacing; subtle shadows/blur

### Colors & Dark Mode

```swift
// System colors (auto-adapt to light/dark)
Text("Hello")
    .foregroundColor(.blue)
    .background(Color(uiColor: .systemBackground))

// Custom colors with dark mode
Color(red: 0.2, green: 0.8, blue: 0.5)  // RGB

// Asset catalog: define light & dark variants
// Use Color("AppPrimary") in code

// Environment detection
@Environment(\.colorScheme) var colorScheme

if colorScheme == .dark {
    // Dark mode UI
}
```

### SF Symbols

```swift
// 5,000+ system icons; part of app bundle
Image(systemName: "heart.fill")
    .font(.title)
    .foregroundColor(.red)

// Common symbols
Label("Save", systemImage: "square.and.arrow.down")
Image(systemName: "star.fill")  // 1-3 fills per symbol
Image(systemName: "wifi")
Image(systemName: "location.fill")
```

---

## 8. App Store Requirements

### SDK & Xcode

- **Minimum iOS version**: iOS 12 (2024 requirement); iOS 13+ recommended
- **Xcode**: 15.4+ (2024); 16+ strongly recommended
- **Swift**: 5.9+ (Xcode 15), Swift 6 available in Xcode 16

### Privacy

- **Privacy Manifest** (`PrivacyInfo.xcprivacy`): Declare data collection (location, contacts, etc.)
- **App Tracking Transparency (ATT)**: Request user consent before tracking across apps (`SKAdNetwork`)
- **Nutrition Labels**: Describe data practices (user contact info, health data, etc.) before submission
- **Account Deletion**: If app has login, provide in-app account deletion within 30 days of request

### Submission Checklist

- [ ] Build signed with valid Apple developer certificate
- [ ] All required privacy declarations in PrivacyInfo.xcprivacy
- [ ] No hardcoded API keys or secrets
- [ ] Screenshots & preview text for all supported devices
- [ ] Privacy policy URL (required if collecting user data)
- [ ] Compliance with HIG (safe areas, orientation, accessibility)
- [ ] Test on actual device (simulator can miss memory/rendering issues)
- [ ] No external payment systems (use IAP or Apple Pay)
- [ ] Encryption: Report if using encryption (most stdlib crypto auto-reported)

---

## 9. Common Pitfalls

1. **Memory Leak in `.task` modifier**: `.task` automatically captures `self` weakly in SwiftUI, but `.onReceive` does not — use `[weak self]` in `.onReceive`

2. **Excessive State in View**: Every `@State` property triggers re-renders; move computation to `@StateObject` (ViewModel)

3. **Blocking Main Thread**: Network requests, file I/O must use `async/await` or GCD; blocking causes UI freeze and watchdog crash

4. **Not Testing on Device**: Simulator hides memory leaks, rendering artifacts, and battery drain; always test final build on real hardware

5. **Weak Self Nil Checks**: After `[weak self]`, always check `guard let self = self else { return }` before using

6. **Mixing SwiftUI & UIKit**: `UIViewControllerRepresentable` / `UIViewRepresentable` have overhead; minimize interop; prefer pure SwiftUI when possible

7. **Forgetting `@MainActor`**: ObservableObject updates must happen on main thread; mark `class` or methods with `@MainActor` to enforce compile-time

8. **Over-Engineering Architecture**: Simple MVVM is sufficient for most apps; only adopt TCA if truly managing complex state; avoid premature abstraction
