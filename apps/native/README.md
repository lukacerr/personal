# Luka Native

Minimal Tauri shell for `https://personal.luka.software`. It embeds no web assets and grants no general Tauri IPC capabilities to the remote page, so web deployments update the application without rebuilding the shell. Linux grants only the WebView zoom command to `main`; Tauri's injected hotkey polyfill requires its local execution context plus the exact remote origin.

Desktop windows and WebViews start with an opaque black background, avoiding a white flash while the remote page loads.

Desktop builds support browser-style zoom with `Ctrl` + `+`, `Ctrl` + `-`, `Ctrl` + `0` and `Ctrl` + mouse wheel. Tauri uses WebKitGTK on Linux and the installed WebView2 runtime on Windows; it does not bundle Chromium.

The deployed web app installs a Workbox Service Worker that precaches its app shell. After one successful online launch, the shell can start offline; API data is never cached and unavailable requests still fail normally.

`apps/web/public/favicon.svg` is the single icon source. Regenerate desktop and Android assets after changing it:

```bash
bun --filter @personal/native icons
```

Build from the repository root:

```bash
bun run build:native:linux
bun run build:native:windows
bun run build:native:android
```

Outputs generated for this version are collected under `apps/native/dist`:

- `Luka_0.1.0_amd64.AppImage`
- `Luka_0.1.0_x64.exe`
- `Luka_0.1.0_arm64.apk`

Linux requires WebKitGTK 4.1 and AppImage tooling. Windows is cross-compiled as a portable executable with `cargo-xwin`. Android requires JDK 17, Android SDK/NDK and Rust's `aarch64-linux-android` target.

Android targets SDK 36 and therefore uses enforced edge-to-edge layout. `MainActivity.kt` applies status bar, navigation bar and display cutout insets to Tauri's content container so the WebView stays inside the usable screen area.

On Linux, the shell prefers the native Wayland backend when `WAYLAND_DISPLAY` is available and keeps X11 as fallback.

Google blocks OAuth inside embedded webviews. The shell loads the cloud app, but Google sign-in still requires a future system-browser return flow.
