use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

const CLOUD_APP_URL: &str = "https://personal.luka.software/";
const LOCAL_APP_URL: &str = "http://localhost:5173/";
const PERSONAL_APP_MARKER: &str = include_str!("../../../web/public/.well-known/personal-app.json");

#[cfg(target_os = "linux")]
fn configure_linux_backend() {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "wayland,x11");
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_backend() {}

fn is_personal_app_response(response: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let is_success = headers
        .lines()
        .next()
        .and_then(|status| status.split_whitespace().nth(1))
        == Some("200");

    is_success && body == PERSONAL_APP_MARKER
}

fn probe_personal_app(address: SocketAddr) -> bool {
    let timeout = Duration::from_millis(350);
    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
        || stream
            .write_all(
                concat!(
                    "GET /.well-known/personal-app.json HTTP/1.1\r\n",
                    "Host: localhost:5173\r\n",
                    "Accept: application/json\r\n",
                    "Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .is_err()
    {
        return false;
    }

    let mut response = String::new();
    stream.take(4096).read_to_string(&mut response).is_ok() && is_personal_app_response(&response)
}

fn select_app_url(use_local: bool) -> tauri::Url {
    if use_local {
        LOCAL_APP_URL.parse().expect("valid local app URL")
    } else {
        CLOUD_APP_URL.parse().expect("valid cloud app URL")
    }
}

fn set_main_window_url(config: &mut tauri::Config, url: tauri::Url) {
    let main_window = config
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
        .expect("main window configuration");
    main_window.url = tauri::WebviewUrl::External(url);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_linux_backend();

    let use_local = probe_personal_app(SocketAddr::from(([127, 0, 0, 1], 5173)));
    let mut context = tauri::generate_context!();
    set_main_window_url(context.config_mut(), select_app_url(use_local));

    tauri::Builder::default()
        .run(context)
        .expect("error while running the native shell");
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn local_personal_app_requires_the_exact_marker() {
        let response = format!(
            concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: application/json\r\n\r\n",
                "{}"
            ),
            super::PERSONAL_APP_MARKER
        );

        assert!(super::is_personal_app_response(&response));
        assert!(!super::is_personal_app_response(
            "HTTP/1.1 200 OK\r\n\r\n<!doctype html><title>Another Vite app</title>"
        ));
    }

    #[test]
    fn app_url_falls_back_to_cloud_without_the_local_marker() {
        assert_eq!(
            super::select_app_url(false).as_str(),
            "https://personal.luka.software/"
        );
        assert_eq!(
            super::select_app_url(true).as_str(),
            "http://localhost:5173/"
        );
    }

    #[test]
    fn selected_url_is_applied_to_the_main_window() {
        let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let local_url = super::select_app_url(true);

        super::set_main_window_url(context.config_mut(), local_url.clone());

        assert_eq!(
            context.config().app.windows[0].url,
            tauri::WebviewUrl::External(local_url)
        );
    }

    #[test]
    fn local_probe_requests_the_personal_app_marker() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            let bytes_read = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..bytes_read])
                .starts_with("GET /.well-known/personal-app.json HTTP/1.1\r\n"));
            let response = format!(
                concat!(
                    "HTTP/1.1 200 OK\r\n",
                    "Content-Type: application/json\r\n",
                    "Connection: close\r\n\r\n",
                    "{}"
                ),
                super::PERSONAL_APP_MARKER
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        assert!(super::probe_personal_app(address));
        server.join().unwrap();
    }

    #[test]
    fn linux_prefers_wayland_with_an_x11_fallback() {
        std::env::set_var("WAYLAND_DISPLAY", "wayland-0");
        std::env::set_var("GDK_BACKEND", "x11");
        super::configure_linux_backend();

        assert_eq!(std::env::var("GDK_BACKEND").as_deref(), Ok("wayland,x11"));

        std::env::remove_var("WAYLAND_DISPLAY");
        std::env::remove_var("GDK_BACKEND");
    }

    #[test]
    fn linux_window_has_no_native_decorations() {
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();

        assert!(!context.config().app.windows[0].decorations);
    }

    #[test]
    fn native_window_starts_with_a_black_background() {
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();

        assert_eq!(
            context.config().app.windows[0].background_color,
            Some(tauri::utils::config::Color(0, 0, 0, 255))
        );
    }

    #[test]
    fn desktop_webview_enables_browser_zoom_shortcuts() {
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();

        assert!(context.config().app.windows[0].zoom_hotkeys_enabled);
    }
}
