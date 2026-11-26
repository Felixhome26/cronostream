use std::path::{Path, PathBuf};

use serde::Serialize;
use sysinfo::Disks;

/// A shortcut shown at the top of the file browser's folder tree, so the
/// user never has to start navigation from the raw filesystem root (which
/// is mostly OS-internal clutter — see `list_quick_access`).
#[derive(Serialize, Clone, Debug)]
pub struct QuickAccessEntry {
    /// "home" | "desktop" | "pictures" | "documents" | "downloads" | "drive"
    /// — anything but "drive" is a well-known folder the frontend
    /// translates by this kind; a drive's `label` is its actual name
    /// (there's nothing to translate).
    pub kind: String,
    pub label: Option<String>,
    pub path: String,
}

/// Real, user-relevant storage filesystem types only — deliberately an
/// allowlist rather than a blocklist of pseudo-filesystems (tmpfs, overlay,
/// squashfs for every installed snap, proc, sysfs, ...): an unknown fs type
/// is far more likely to be another pseudo-filesystem we haven't thought of
/// than a real drive, so excluding by default is the safer direction.
const REAL_FILESYSTEMS: &[&str] = &[
    "ext4", "ext3", "ext2", "btrfs", "xfs", "ntfs", "ntfs3", "vfat", "fat32", "exfat", "apfs",
    "hfs", "hfsplus", "zfs", "f2fs", "reiserfs",
];

/// Filters out small boot/EFI/recovery partitions — real but not something
/// anyone browses for photos/documents. A `vfat` EFI partition is
/// typically a few hundred MB; any actual data drive is comfortably above
/// this.
const MIN_DRIVE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

fn drive_label(mount: &Path) -> String {
    let full = mount.to_string_lossy();
    let trimmed = full.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.rsplit(['/', '\\']).next().unwrap_or(&full).to_string()
    }
}

#[tauri::command(async)]
pub fn list_quick_access() -> Vec<QuickAccessEntry> {
    let mut entries = Vec::new();

    let mut add_place = |kind: &str, dir: Option<PathBuf>| {
        if let Some(path) = dir {
            if path.is_dir() {
                entries.push(QuickAccessEntry { kind: kind.to_string(), label: None, path: path.to_string_lossy().to_string() });
            }
        }
    };
    add_place("home", dirs::home_dir());
    add_place("desktop", dirs::desktop_dir());
    add_place("pictures", dirs::picture_dir());
    add_place("documents", dirs::document_dir());
    add_place("downloads", dirs::download_dir());

    let disks = Disks::new_with_refreshed_list();
    for disk in disks.list() {
        if disk.total_space() < MIN_DRIVE_BYTES {
            continue;
        }
        let fs_type = disk.file_system().to_string_lossy().to_lowercase();
        if !REAL_FILESYSTEMS.contains(&fs_type.as_str()) {
            continue;
        }
        let path = disk.mount_point().to_string_lossy().to_string();
        // Skip a drive that coincides with a "place" already listed above
        // (e.g. the home partition itself) — a second entry for it adds
        // nothing.
        if entries.iter().any(|e| e.path == path) {
            continue;
        }
        entries.push(QuickAccessEntry { kind: "drive".to_string(), label: Some(drive_label(disk.mount_point())), path });
    }

    entries
}
