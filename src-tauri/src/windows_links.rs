//! The Windows start menu and desktop shortcuts, switched on and off in the
//! app like the Linux entries (`desktop_integration.rs`).
//!
//! The installer makes them (Tauri's template and `installer-hooks.nsh`):
//! the program, the drop box and "uninstall" in the start menu folder, the
//! program on the desktop if ticked on its last page. Switching one off
//! moves it into a folder of the app's own (`hidden_shortcuts` in the local
//! app data) instead of deleting it, and switching it on moves it back: the
//! installer's shortcut keeps everything it was made with, the taskbar's app
//! id among it. Only a shortcut gone altogether is made anew (`create`),
//! named in the app's language, and without that id.
//!
//! Compiled everywhere, so the logic is checked on Linux too; only
//! `create` and the registry read need Windows.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::uninstall::UNINSTALL_ARG;
use crate::DROPZONE_ARG;

/// `startMenuFolder` in tauri.windows.conf.json, for an installation that
/// predates `installer-hooks.nsh` writing the folder down.
const DEFAULT_FOLDER: &str = "CronoStream";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Link {
    App,
    Dropzone,
    Uninstall,
    Desktop,
}

pub(crate) const ALL_LINKS: [Link; 4] = [Link::App, Link::Dropzone, Link::Uninstall, Link::Desktop];

impl Link {
    /// German, English, Spanish, as `i18n::language_index` counts them, and
    /// as `installer-hooks.nsh` names them. The program's own carries the
    /// product name, like the one the installer makes.
    fn names(self) -> [&'static str; 3] {
        match self {
            Link::App | Link::Desktop => ["CronoStream"; 3],
            Link::Dropzone => ["CronoStream Ablage", "CronoStream Drop Box", "CronoStream Bandeja"],
            Link::Uninstall => ["CronoStream deinstallieren", "Uninstall CronoStream", "Desinstalar CronoStream"],
        }
    }

    fn argument(self) -> Option<&'static str> {
        match self {
            Link::Dropzone => Some(DROPZONE_ARG),
            Link::Uninstall => Some(UNINSTALL_ARG),
            Link::App | Link::Desktop => None,
        }
    }

    /// App and desktop shortcut share their name, so each place has its own
    /// folder among the hidden ones.
    fn hidden_subdir(self) -> &'static str {
        match self {
            Link::Desktop => "desktop",
            _ => "startmenu",
        }
    }
}

pub(crate) struct Places {
    start_menu: PathBuf,
    desktop: PathBuf,
    hidden: PathBuf,
    exe: PathBuf,
}

/// For a per-user installation, the installer's default. `None` where a
/// folder can't be determined.
pub(crate) fn places(app: &AppHandle) -> Option<Places> {
    let programs = dirs::data_dir()?.join("Microsoft").join("Windows").join("Start Menu").join("Programs");
    let folder = registry::start_menu_folder()
        .filter(|folder| is_plain_folder_name(folder))
        .unwrap_or_else(|| DEFAULT_FOLDER.to_string());
    Some(Places {
        start_menu: programs.join(folder),
        desktop: dirs::desktop_dir()?,
        hidden: app.path().app_local_data_dir().ok()?.join("hidden_shortcuts"),
        exe: std::env::current_exe().ok()?,
    })
}

/// What the installer's start menu page allows: a folder (or folders)
/// below the start menu, never a way out of it.
/// Split by hand on both separators, so the check is the same on every
/// system.
fn is_plain_folder_name(folder: &str) -> bool {
    !folder.contains(':') && folder.split(['/', '\\']).all(|part| !part.is_empty() && part != "." && part != "..")
}

impl Places {
    fn dir(&self, link: Link) -> &Path {
        match link {
            Link::Desktop => &self.desktop,
            _ => &self.start_menu,
        }
    }

    fn candidates(dir: &Path, link: Link) -> Vec<PathBuf> {
        let mut names = link.names().to_vec();
        names.dedup();
        names.into_iter().map(|name| dir.join(format!("{name}.lnk"))).collect()
    }

    fn visible(&self, link: Link) -> Vec<PathBuf> {
        Self::candidates(self.dir(link), link).into_iter().filter(|path| path.is_file()).collect()
    }

    fn hidden(&self, link: Link) -> Option<PathBuf> {
        Self::candidates(&self.hidden.join(link.hidden_subdir()), link).into_iter().find(|path| path.is_file())
    }

    pub(crate) fn is_shown(&self, link: Link) -> bool {
        !self.visible(link).is_empty()
    }

    pub(crate) fn set_shown(&self, link: Link, on: bool) -> io::Result<()> {
        if on {
            if self.is_shown(link) {
                return Ok(());
            }
            let dir = self.dir(link);
            fs::create_dir_all(dir)?;
            if let Some(hidden) = self.hidden(link) {
                let name = hidden.file_name().map(|n| n.to_os_string()).unwrap_or_default();
                return move_file(&hidden, &dir.join(name));
            }
            let name = link.names()[crate::i18n::language_index().min(2)];
            create(&dir.join(format!("{name}.lnk")), &self.exe, link.argument())
        } else {
            for path in self.visible(link) {
                let name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
                move_file(&path, &self.hidden.join(link.hidden_subdir()).join(name))?;
            }
            if link != Link::Desktop {
                // Only succeeds once the folder is empty.
                let _ = fs::remove_dir(&self.start_menu);
            }
            Ok(())
        }
    }

    /// The shortcuts there are right now, for the uninstall dialog.
    pub(crate) fn existing(&self) -> Vec<PathBuf> {
        ALL_LINKS.iter().flat_map(|&link| self.visible(link)).collect()
    }

    pub(crate) fn start_menu_dir(&self) -> &Path {
        &self.start_menu
    }
}

/// A rename where it can, a copy across drives where it can't.
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_file(to);
    fs::rename(from, to).or_else(|_| {
        fs::copy(from, to)?;
        fs::remove_file(from)
    })
}

/// A `.lnk` through the shell's own `ShellLink` object. COM is set up for
/// this thread and torn down again, like `native_thumb.rs` does it; if the
/// thread already has it in another mode, that one is used as it is.
#[cfg(windows)]
fn create(path: &Path, exe: &Path, argument: Option<&str>) -> io::Result<()> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let result = (|| -> windows::core::Result<()> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.as_os_str()))?;
            if let Some(argument) = argument {
                link.SetArguments(&HSTRING::from(argument))?;
            }
            link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0)?;
            if let Some(dir) = exe.parent() {
                link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
            }
            let file: IPersistFile = link.cast()?;
            file.Save(&HSTRING::from(path.as_os_str()), true)
        })();
        if com.is_ok() {
            CoUninitialize();
        }
        result.map_err(|e| io::Error::other(e.to_string()))
    }
}

#[cfg(not(windows))]
fn create(_path: &Path, _exe: &Path, _argument: Option<&str>) -> io::Result<()> {
    Err(io::Error::other("shortcuts are made on Windows only"))
}

/// The start menu folder chosen during installation, which
/// `installer-hooks.nsh` keeps in the program's uninstall key (removed with
/// the program).
#[cfg(windows)]
mod registry {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

    pub fn start_menu_folder() -> Option<String> {
        let key = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CronoStream");
        let value = w!("CronoStreamStartMenuFolder");
        let mut size: u32 = 0;
        let status = unsafe { RegGetValueW(HKEY_CURRENT_USER, key, value, RRF_RT_REG_SZ, None, None, Some(&mut size)) };
        if status.0 != 0 || size < 2 {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key,
                value,
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status.0 != 0 {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }
}

#[cfg(not(windows))]
mod registry {
    pub fn start_menu_folder() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn places(root: &Path) -> Places {
        Places {
            start_menu: root.join("Programs").join("CronoStream"),
            desktop: root.join("Desktop"),
            hidden: root.join("hidden"),
            exe: root.join("CronoStream.exe"),
        }
    }

    #[test]
    fn switching_off_and_on_moves_the_installers_shortcut_back() {
        let root = std::env::temp_dir().join(format!("cronostream-links-{}", uuid::Uuid::new_v4()));
        let places = places(&root);
        fs::create_dir_all(&places.start_menu).unwrap();
        fs::create_dir_all(&places.desktop).unwrap();
        let dropzone = places.start_menu.join("CronoStream Drop Box.lnk");
        let desktop = places.desktop.join("CronoStream.lnk");
        fs::write(&dropzone, b"installer").unwrap();
        fs::write(&desktop, b"desktop").unwrap();

        places.set_shown(Link::Dropzone, false).unwrap();
        places.set_shown(Link::Desktop, false).unwrap();
        assert!(!places.is_shown(Link::Dropzone) && !places.is_shown(Link::Desktop));
        // The emptied start menu folder goes with the last entry.
        assert!(!places.start_menu.exists());

        places.set_shown(Link::Dropzone, true).unwrap();
        places.set_shown(Link::Desktop, true).unwrap();
        assert_eq!(fs::read(&dropzone).unwrap(), b"installer");
        assert_eq!(fs::read(&desktop).unwrap(), b"desktop");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_from_the_registry_cannot_leave_the_start_menu() {
        assert!(is_plain_folder_name("CronoStream"));
        assert!(is_plain_folder_name("Felix\\CronoStream"));
        assert!(!is_plain_folder_name(""));
        assert!(!is_plain_folder_name("..\\..\\Desktop"));
        assert!(!is_plain_folder_name("/etc"));
    }
}
