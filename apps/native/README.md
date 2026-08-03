# Luka Native

Minimal Tauri shell for `https://personal.luka.software`. It embeds no web assets and grants no Tauri IPC capabilities to the remote page, so web deployments update the application without rebuilding the shell.

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

On Linux, the shell prefers the native Wayland backend when `WAYLAND_DISPLAY` is available and keeps X11 as fallback.

Google blocks OAuth inside embedded webviews. The shell loads the cloud app, but Google sign-in still requires a future system-browser return flow.
