//! Start menu, desktop and autostart entries, the same four switches on
//! Linux and Windows.
//!
//! An AppImage is a single file with no installer, so nothing would ever put
//! it into the start menu. The app offers that itself on its first start
//! (`WelcomeDialog.tsx`) and in the settings. `$APPIMAGE`, set by the AppImage
//! runtime, is the file's real path — everywhere else (`tauri dev`, macOS) it
//! is absent and all of this reports itself as unavailable.
//!
//! Program and drop box entries come with a third one, "CronoStream
//! deinstallieren" (`UNINSTALL_ARG`), and the three sit together in a
//! "CronoStream" folder of the menu: an XDG menu file merged into the
//! desktop's menu, with a `.directory` file for the folder's name and icon.
//! Desktops that don't read merged menus show the entries under Utility.
//!
//! The desktop shortcut is a copy of the program's entry in the desktop
//! folder, marked executable and trusted so file managers start it.
//!
//! On Windows the installer makes the shortcuts, and the app switches them
//! like the Linux entries (`windows_links.rs`); the autostart is a value
//! under the user's `Run` key (`run_key`). A debug build leaves all of it
//! alone, like `tauri dev` on Linux.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::uninstall::UNINSTALL_ARG;
use crate::windows_links::Link;
use crate::DROPZONE_ARG;

/// Every file name below starts with it. The entries the app made under its
/// former name, LifeStream, carry `former_name::LEGACY_IDENTIFIER` instead.
const ENTRY_ID: &str = "com.felixheck.cronostream";

/// The icon name the entries carry for the current theme. The light theme's
/// tile has a name of its own rather than a new picture under the old name:
/// Cinnamon caches icons by name, but rereads an entry whose `Icon=` line
/// changed.
fn icon_name() -> String {
    if crate::ui_theme::is_light() {
        format!("{ENTRY_ID}.light")
    } else {
        ENTRY_ID.to_string()
    }
}

/// Which entries exist. `autostart` is the drop box, as a circle; `desktop`
/// the program on the desktop.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopEntries {
    pub app: bool,
    pub dropzone: bool,
    pub autostart: bool,
    #[serde(default)]
    pub desktop: bool,
}

const NO_ENTRIES: DesktopEntries = DesktopEntries { app: false, dropzone: false, autostart: false, desktop: false };

#[derive(Serialize)]
pub struct DesktopIntegrationStatus {
    pub available: bool,
    /// Which of the entries this system offers at all.
    pub supported: DesktopEntries,
    pub entries: DesktopEntries,
}

const ALL_ENTRIES: DesktopEntries = DesktopEntries { app: true, dropzone: true, autostart: true, desktop: true };

/// The drop box at login, as the value `CronoStream Ablage` under
/// `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Per user, so it
/// needs no administrator rights. Elsewhere the stubs report it as absent.
#[cfg(windows)]
mod run_key {
    use windows::core::w;
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    const ERROR_SUCCESS: u32 = 0;
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    pub fn is_set() -> bool {
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
                w!("CronoStream Ablage"),
                RRF_RT_REG_SZ,
                None,
                None,
                None,
            )
        };
        status.0 == ERROR_SUCCESS
    }

    /// Writing it again on every start keeps it pointing at the current
    /// program file, should the installation have moved.
    pub fn set(on: bool) -> Result<(), String> {
        let status = if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let command = format!("\"{}\" {}", exe.display(), crate::DROPZONE_ARG);
            let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
                    w!("CronoStream Ablage"),
                    REG_SZ.0,
                    Some(wide.as_ptr().cast()),
                    (wide.len() * std::mem::size_of::<u16>()) as u32,
                )
            }
        } else {
            let status = unsafe {
                RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"),
                    w!("CronoStream Ablage"),
                )
            };
            if status.0 == ERROR_FILE_NOT_FOUND {
                return Ok(());
            }
            status
        };
        if status.0 == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("registry error {}", status.0))
        }
    }
}

#[cfg(not(windows))]
mod run_key {
    pub fn is_set() -> bool {
        false
    }

    pub fn set(_on: bool) -> Result<(), String> {
        Err("no Run key outside Windows".into())
    }
}

/// Takes the drop box's autostart away before the program is uninstalled,
/// so nothing at the next login points at a program that is gone. The
/// uninstaller's hook removes it as well (`installer-hooks.nsh`), for an
/// uninstall started from the Windows settings.
pub(crate) fn windows_autostart_set() -> bool {
    windows_run_key_available() && run_key::is_set()
}

pub(crate) fn remove_windows_autostart() {
    if windows_run_key_available() && run_key::is_set() {
        let _ = run_key::set(false);
    }
}

/// `cfg!` rather than `#[cfg]` at the call sites, so the Linux code below is
/// compiled (and checked) on every system.
fn windows_run_key_available() -> bool {
    cfg!(windows) && !cfg!(debug_assertions)
}

fn windows_status(app: &AppHandle) -> DesktopIntegrationStatus {
    let available = windows_run_key_available();
    let places = if available { crate::windows_links::places(app) } else { None };
    let shown = |link| places.as_ref().is_some_and(|p| p.is_shown(link));
    let links = places.is_some();
    DesktopIntegrationStatus {
        available,
        supported: DesktopEntries { app: links, dropzone: links, autostart: true, desktop: links },
        entries: DesktopEntries {
            app: shown(Link::App),
            dropzone: shown(Link::Dropzone),
            autostart: available && run_key::is_set(),
            desktop: shown(Link::Desktop),
        },
    }
}

/// As on Linux, the uninstall entry stays as long as the program's or the
/// drop box's does.
fn apply_windows(app: &AppHandle, entries: DesktopEntries) -> Result<(), String> {
    if let Some(places) = crate::windows_links::places(app) {
        for (link, on) in [
            (Link::App, entries.app),
            (Link::Dropzone, entries.dropzone),
            (Link::Uninstall, entries.app || entries.dropzone),
            (Link::Desktop, entries.desktop),
        ] {
            places.set_shown(link, on).map_err(|e| e.to_string())?;
        }
    }
    run_key::set(entries.autostart)
}

struct Locations {
    app_entry: PathBuf,
    dropzone_entry: PathBuf,
    autostart_entry: PathBuf,
    uninstall_entry: PathBuf,
    /// `None` where the system has no desktop folder.
    desktop_entry: Option<PathBuf>,
    icon: PathBuf,
    light_icon: PathBuf,
    /// The menu folder's name and icon.
    directory: PathBuf,
    /// The menu file that makes the folder, once per merge folder the
    /// desktop may read (`menu_merge_dirs`).
    menus: Vec<PathBuf>,
}

impl Locations {
    fn all_files(&self) -> Vec<PathBuf> {
        let mut files = vec![
            self.app_entry.clone(),
            self.dropzone_entry.clone(),
            self.autostart_entry.clone(),
            self.uninstall_entry.clone(),
            self.icon.clone(),
            self.light_icon.clone(),
            self.directory.clone(),
        ];
        files.extend(self.menus.iter().cloned());
        files.extend(self.desktop_entry.iter().cloned());
        files
    }
}

pub(crate) fn appimage_path() -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|path| path.is_file())
}

fn locations(app: &AppHandle) -> Result<Locations, String> {
    locations_for(app, ENTRY_ID)
}

fn locations_for(app: &AppHandle, id: &str) -> Result<Locations, String> {
    let data = app.path().data_dir().map_err(|e| e.to_string())?;
    let config = app.path().config_dir().map_err(|e| e.to_string())?;
    let applications = data.join("applications");
    let icons = data.join("icons/hicolor/256x256/apps");
    Ok(Locations {
        app_entry: applications.join(format!("{id}.desktop")),
        dropzone_entry: applications.join(format!("{id}.ablage.desktop")),
        autostart_entry: config.join("autostart").join(format!("{id}.ablage.desktop")),
        uninstall_entry: applications.join(format!("{id}.deinstallieren.desktop")),
        desktop_entry: desktop_dir().map(|dir| dir.join(format!("{id}.desktop"))),
        icon: icons.join(format!("{id}.png")),
        light_icon: icons.join(format!("{id}.light.png")),
        directory: data.join("desktop-directories").join(format!("{id}.directory")),
        menus: menu_merge_dirs(&config).into_iter().map(|dir| dir.join(format!("{id}.menu"))).collect(),
    })
}

/// The desktop folder from `user-dirs.dirs`, else `~/Desktop` if there is
/// one.
fn desktop_dir() -> Option<PathBuf> {
    dirs::desktop_dir().or_else(|| dirs::home_dir().map(|home| home.join("Desktop"))).filter(|dir| dir.is_dir())
}

/// Where a desktop picks up menu files merged into its own. The spec names
/// the folder after the menu file, which carries `$XDG_MENU_PREFIX`
/// (Cinnamon: `cinnamon-applications.menu`), while menus from other tools
/// sit in the plain `applications-merged`. Writing to both is harmless: two
/// submenus of the same name are merged into one.
fn menu_merge_dirs(config: &Path) -> Vec<PathBuf> {
    let menus = config.join("menus");
    let mut dirs = vec![menus.join("applications-merged")];
    if let Some(prefix) = std::env::var("XDG_MENU_PREFIX").ok().filter(|p| !p.is_empty() && !p.contains('/')) {
        dirs.push(menus.join(format!("{prefix}applications-merged")));
    }
    dirs
}

/// Every file this module may have put on the system, under the current
/// name and the former one, for the uninstall. Whether each one exists is
/// the caller's to check.
pub(crate) fn linux_entry_files(app: &AppHandle) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for id in [ENTRY_ID, crate::former_name::LEGACY_IDENTIFIER] {
        if let Ok(locations) = locations_for(app, id) {
            files.extend(locations.all_files());
        }
    }
    files
}

/// The program path as one quoted argument of an `Exec=` line. The desktop
/// entry spec layers two escapes: the quoting rule (a backslash before
/// `"`, `` ` ``, `$` and `\`), then the string rule, which doubles every
/// backslash. Hence two backslashes per special character, four for `\`
/// itself. `%` would start a field code, and is doubled instead.
fn quote_exec_path(path: &Path) -> String {
    let mut quoted = String::from("\"");
    for ch in path.to_string_lossy().chars() {
        match ch {
            '"' | '`' | '$' => {
                quoted.push_str("\\\\");
                quoted.push(ch);
            }
            '\\' => quoted.push_str("\\\\\\\\"),
            '%' => quoted.push_str("%%"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

fn app_entry_text(appimage: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=CronoStream\n\
         Comment=Fotos, Videos, Audio und Dokumente auf einer Zeitleiste\n\
         Comment[en]=Photos, videos, audio and documents on one timeline\n\
         Comment[es]=Fotos, vídeos, audio y documentos en una línea de tiempo\n\
         Exec={}\n\
         Icon={}\n\
         Terminal=false\n\
         Categories=Utility;\n\
         StartupWMClass=cronostream\n",
        quote_exec_path(appimage),
        icon_name(),
    )
}

/// Without `StartupWMClass`, unlike the main entry: both windows belong to
/// one process with one WM_CLASS, and with the same class in two entries
/// Cinnamon grouped the running app under the drop box's entry, so a pinned
/// CronoStream launcher got a second icon beside it for the running app.
fn dropzone_entry_text(appimage: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=CronoStream Ablage\n\
         Name[en]=CronoStream Drop Box\n\
         Name[es]=CronoStream Bandeja\n\
         Comment=Dateien sammeln, ohne das Hauptfenster zu öffnen\n\
         Comment[en]=Collect files without opening the main window\n\
         Comment[es]=Reunir archivos sin abrir la ventana principal\n\
         Exec={} {DROPZONE_ARG}\n\
         Icon={}\n\
         Terminal=false\n\
         Categories=Utility;\n",
        quote_exec_path(appimage),
        icon_name(),
    )
}

/// Opens the main window with the uninstall dialog. Without
/// `StartupWMClass`, for the same reason as the drop box's entry.
fn uninstall_entry_text(appimage: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=CronoStream deinstallieren\n\
         Name[en]=Uninstall CronoStream\n\
         Name[es]=Desinstalar CronoStream\n\
         Comment=CronoStream mit allen Einstellungen vom Computer entfernen\n\
         Comment[en]=Remove CronoStream and all its settings from the computer\n\
         Comment[es]=Quitar CronoStream y todos sus ajustes del ordenador\n\
         Exec={} {UNINSTALL_ARG}\n\
         Icon={}\n\
         Terminal=false\n\
         Categories=Utility;\n",
        quote_exec_path(appimage),
        icon_name(),
    )
}

fn directory_text() -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Directory\n\
         Name=CronoStream\n\
         Icon={}\n",
        icon_name(),
    )
}

/// The "CronoStream" folder with the three entries, merged into the
/// desktop's menu. The entries keep `Categories=Utility` for desktops
/// without merged menus, so where the merge works they are taken out of the
/// utilities menu again — under the names Cinnamon, MATE and Xfce
/// ("Accessories") and GNOME and KDE ("Utilities") give it.
fn menu_text() -> String {
    let files: String = [
        format!("{ENTRY_ID}.desktop"),
        format!("{ENTRY_ID}.ablage.desktop"),
        format!("{ENTRY_ID}.deinstallieren.desktop"),
    ]
    .iter()
    .map(|name| format!("      <Filename>{name}</Filename>\n"))
    .collect();
    let exclude = |menu: &str| format!("  <Menu>\n    <Name>{menu}</Name>\n    <Exclude>\n{files}    </Exclude>\n  </Menu>\n");
    format!(
        "<!DOCTYPE Menu PUBLIC \"-//freedesktop//DTD Menu 1.0//EN\"\n \"http://www.freedesktop.org/standards/menu-spec/1.0/menu.dtd\">\n\
         <Menu>\n\
         \x20 <Name>Applications</Name>\n\
         \x20 <Menu>\n\
         \x20   <Name>CronoStream</Name>\n\
         \x20   <Directory>{ENTRY_ID}.directory</Directory>\n\
         \x20   <Include>\n{files}    </Include>\n\
         \x20 </Menu>\n\
         {}{}</Menu>\n",
        exclude("Accessories"),
        exclude("Utilities"),
    )
}

/// Whether the file was (re)written.
fn write_file(path: &Path, contents: &[u8]) -> io::Result<bool> {
    // Rewriting an unchanged file would only wake every watcher of the
    // applications folder, on each start of the app.
    if fs::read(path).is_ok_and(|current| current == contents) {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(true)
}

/// A launcher on the desktop only starts once it is executable, and in
/// Nemo and Nautilus once it is marked trusted (`gio set`, without the
/// AppImage's libraries, like `browse_commands::reveal_path`).
fn write_desktop_launcher(path: &Path, contents: &[u8]) -> io::Result<()> {
    let changed = write_file(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    if changed {
        let mut gio = std::process::Command::new("gio");
        for var in ["LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GSETTINGS_SCHEMA_DIR", "GDK_PIXBUF_MODULE_FILE", "APPDIR", "APPIMAGE"] {
            gio.env_remove(var);
        }
        let _ = gio
            .args(["set"])
            .arg(path)
            .args(["metadata::trusted", "true"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    Ok(())
}

fn remove_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn apply(locations: &Locations, appimage: &Path, entries: DesktopEntries) -> io::Result<()> {
    let app_text = app_entry_text(appimage);
    let dropzone_text = dropzone_entry_text(appimage);
    for (wanted, path, text) in [
        (entries.app, &locations.app_entry, &app_text),
        (entries.dropzone, &locations.dropzone_entry, &dropzone_text),
        (entries.autostart, &locations.autostart_entry, &dropzone_text),
    ] {
        if wanted {
            write_file(path, text.as_bytes())?;
        } else {
            remove_file(path)?;
        }
    }
    if let Some(path) = &locations.desktop_entry {
        if entries.desktop {
            write_desktop_launcher(path, app_text.as_bytes())?;
        } else {
            remove_file(path)?;
        }
    }
    // The uninstall entry and the folder belong to the menu entries; the
    // autostart alone doesn't make a menu.
    if entries.app || entries.dropzone {
        write_file(&locations.uninstall_entry, uninstall_entry_text(appimage).as_bytes())?;
        write_file(&locations.directory, directory_text().as_bytes())?;
        let menu = menu_text();
        for path in &locations.menus {
            write_file(path, menu.as_bytes())?;
        }
    } else {
        remove_file(&locations.uninstall_entry)?;
        remove_file(&locations.directory)?;
        for path in &locations.menus {
            remove_file(path)?;
        }
    }
    if entries.app || entries.dropzone || entries.autostart || entries.desktop {
        write_file(&locations.icon, crate::ui_theme::DARK_ICON)?;
        write_file(&locations.light_icon, crate::ui_theme::LIGHT_ICON).map(|_| ())
    } else {
        remove_file(&locations.icon)?;
        remove_file(&locations.light_icon)
    }
}

/// Points the existing entries at the current theme's icon. Unlike
/// `refresh` this needs no AppImage path: only the `Icon=` line changes,
/// so it also works for entries a `tauri dev` window is matched against.
pub fn refresh_icon(app: &AppHandle) {
    let Ok(locations) = locations(app) else { return };
    let entries = existing_entries(&locations);
    if entries == NO_ENTRIES {
        return;
    }
    let _ = write_file(&locations.icon, crate::ui_theme::DARK_ICON);
    let _ = write_file(&locations.light_icon, crate::ui_theme::LIGHT_ICON);
    for path in [
        &locations.app_entry,
        &locations.dropzone_entry,
        &locations.autostart_entry,
        &locations.uninstall_entry,
        &locations.directory,
    ]
    .into_iter()
    .chain(locations.desktop_entry.as_ref())
    {
        let Ok(text) = fs::read_to_string(path) else { continue };
        let updated: String = text
            .lines()
            .map(|line| if line.starts_with("Icon=") { format!("Icon={}\n", icon_name()) } else { format!("{line}\n") })
            .collect();
        let _ = write_file(path, updated.as_bytes());
    }
}

fn existing_entries(locations: &Locations) -> DesktopEntries {
    DesktopEntries {
        app: locations.app_entry.is_file(),
        dropzone: locations.dropzone_entry.is_file(),
        autostart: locations.autostart_entry.is_file(),
        desktop: locations.desktop_entry.as_ref().is_some_and(|path| path.is_file()),
    }
}

fn linux_supported(locations: &Locations) -> DesktopEntries {
    DesktopEntries { desktop: locations.desktop_entry.is_some(), ..ALL_ENTRIES }
}

/// Run at every start: an AppImage that was moved leaves its entries pointing
/// at nothing, so the ones that exist are rewritten with the current path.
/// The entries of a LifeStream AppImage, the app's former name, give way to
/// the same entries under the new one.
pub fn refresh(app: &AppHandle) {
    if cfg!(windows) {
        if windows_run_key_available() && run_key::is_set() {
            let _ = run_key::set(true);
        }
        return;
    }
    let Some(appimage) = appimage_path() else { return };
    let Ok(locations) = locations(app) else { return };
    let mut entries = existing_entries(&locations);
    if let Ok(legacy) = locations_for(app, crate::former_name::LEGACY_IDENTIFIER) {
        let legacy_entries = existing_entries(&legacy);
        if legacy_entries != NO_ENTRIES && apply(&legacy, &appimage, NO_ENTRIES).is_ok() {
            entries.app |= legacy_entries.app;
            entries.dropzone |= legacy_entries.dropzone;
            entries.autostart |= legacy_entries.autostart;
            entries.desktop |= legacy_entries.desktop;
        }
    }
    let _ = apply(&locations, &appimage, entries);
}

#[tauri::command(async)]
pub fn get_desktop_integration(app: AppHandle) -> Result<DesktopIntegrationStatus, String> {
    if cfg!(windows) {
        return Ok(windows_status(&app));
    }
    let locations = locations(&app)?;
    Ok(DesktopIntegrationStatus {
        available: appimage_path().is_some(),
        supported: linux_supported(&locations),
        entries: existing_entries(&locations),
    })
}

#[tauri::command(async)]
pub fn set_desktop_integration(
    app: AppHandle,
    entries: DesktopEntries,
) -> Result<DesktopIntegrationStatus, String> {
    if cfg!(windows) {
        if !windows_run_key_available() {
            return Err("debug build".into());
        }
        apply_windows(&app, entries)?;
        return Ok(windows_status(&app));
    }
    let appimage = appimage_path().ok_or("not running from an AppImage")?;
    let locations = locations(&app)?;
    apply(&locations, &appimage, entries).map_err(|e| e.to_string())?;
    Ok(DesktopIntegrationStatus {
        available: true,
        supported: linux_supported(&locations),
        entries: existing_entries(&locations),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_paths_survive_both_escape_layers() {
        assert_eq!(
            quote_exec_path(Path::new("/home/a b/CronoStream.AppImage")),
            "\"/home/a b/CronoStream.AppImage\""
        );
        assert_eq!(quote_exec_path(Path::new("/x/100%")), "\"/x/100%%\"");
        assert_eq!(quote_exec_path(Path::new("/x/$y")), "\"/x/\\\\$y\"");
        assert_eq!(quote_exec_path(Path::new("/x/a\\b")), "\"/x/a\\\\\\\\b\"");
    }

    #[test]
    fn only_the_drop_box_entry_carries_the_start_argument() {
        let path = Path::new("/apps/CronoStream.AppImage");
        assert!(dropzone_entry_text(path).contains("Exec=\"/apps/CronoStream.AppImage\" --ablage\n"));
        assert!(app_entry_text(path).contains("Exec=\"/apps/CronoStream.AppImage\"\n"));
        assert!(uninstall_entry_text(path).contains("Exec=\"/apps/CronoStream.AppImage\" --deinstallieren\n"));
    }

    #[test]
    fn the_menu_folder_holds_all_three_entries() {
        let menu = menu_text();
        assert!(menu.contains("<Name>CronoStream</Name>"));
        assert!(menu.contains("<Directory>com.felixheck.cronostream.directory</Directory>"));
        for name in ["", ".ablage", ".deinstallieren"] {
            assert!(menu.contains(&format!("<Filename>com.felixheck.cronostream{name}.desktop</Filename>")));
        }
    }
}
