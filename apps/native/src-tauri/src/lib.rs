#[cfg(target_os = "linux")]
fn configure_linux_backend() {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "wayland,x11");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_backend() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_backend();

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the native shell");
}

#[cfg(test)]
mod tests {
    #[test]
    fn linux_prefers_wayland_with_an_x11_fallback() {
        std::env::set_var("WAYLAND_DISPLAY", "wayland-0");
        std::env::set_var("GDK_BACKEND", "x11");
        super::configure_linux_backend();

        assert_eq!(std::env::var("GDK_BACKEND").as_deref(), Ok("wayland,x11"));

        std::env::remove_var("WAYLAND_DISPLAY");
        std::env::remove_var("GDK_BACKEND");
    }
}
