# Personal Native

Minimal Tauri shell for `https://personal.luka.software`. It embeds no web assets and grants no Tauri IPC capabilities to the remote page, so web deployments update the application without rebuilding the shell.

Build from the repository root:

```bash
bun run build:native:linux
bun run build:native:windows
bun run build:native:android
```

Outputs generated for this version are collected under `apps/native/dist`:

- `Personal_0.1.0_amd64.AppImage`
- `Personal_0.1.0_x64.exe`
- `Personal_0.1.0_arm64.apk`

Linux requires WebKitGTK 4.1 and AppImage tooling. Windows is cross-compiled as a portable executable with `cargo-xwin`. Android requires JDK 17, Android SDK/NDK and Rust's `aarch64-linux-android` target.

Google blocks OAuth inside embedded webviews. The shell loads the cloud app, but Google sign-in still requires a future system-browser return flow.
