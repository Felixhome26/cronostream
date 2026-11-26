//! The windows' drop target on Windows, in place of the webview's own.
//!
//! wry (0.57, `src/webview2/drag_drop.rs`) registers an OLE drop target on
//! the WebView2 child windows that asks the dragged data for `CF_HDROP`
//! (real file paths) and nothing else; anything without it is ignored
//! without a word. Classic Outlook drags messages (`.msg`) and attachments
//! as *virtual files*: a `FileGroupDescriptorW` with the names and one
//! `FileContents` per file (an `IStorage` for a message, a stream or memory
//! block for an attachment), no `CF_HDROP` at all — so a mail dragged from
//! Outlook never arrived. Thunderbird and other programs that hand over
//! files without paths use the same formats.
//!
//! This target replaces wry's on the same child windows and handles both:
//! paths are passed on as they are, virtual files are written into the
//! lasting store of `dropped_files.rs` (the drop box keeps only paths, and
//! across restarts). The data object is only valid during `Drop`, so they
//! are written right there. Its events go to the frontend as
//! `native-file-drop` (`src/utils/fileDrop.ts`); Tauri's own drag-and-drop
//! events no longer fire on Windows once this is installed.
//!
//! The effect reported back is always "copy", never "move": a mail program
//! may delete the original after a move.

use std::cell::Cell;
use std::ffi::{c_void, OsString};
use std::fs;
use std::io::Write;
use std::mem::size_of;
use std::os::windows::ffi::OsStringExt;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, Ref, BOOL, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{DRAGDROP_E_INVALIDHWND, HWND, LPARAM, POINTL, S_OK};
use windows::Win32::Globalization::{MultiByteToWideChar, CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};
use windows::Win32::System::Com::StructuredStorage::{IStorage, StgCreateDocfile};
use windows::Win32::System::Com::{
    IDataObject, IStream, DVASPECT_CONTENT, FORMATETC, STGM_CREATE, STGM_READWRITE, STGM_SHARE_EXCLUSIVE,
    STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTORAGE, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT,
    DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{
    DragQueryFileW, CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORA, CFSTR_FILEDESCRIPTORW, FD_ATTRIBUTES, FD_FILESIZE,
    FILEDESCRIPTORA, FILEDESCRIPTORW, HDROP,
};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

use crate::dropped_files;

const EVENT: &str = "native-file-drop";
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
/// Name for a virtual file that comes without one.
const FALLBACK_NAME: &str = "dropped-file";

#[derive(Serialize, Clone)]
struct Payload {
    /// The webview the drop happened on; every window hears the event.
    label: String,
    #[serde(rename = "type")]
    kind: &'static str,
    paths: Vec<String>,
    /// Names of dropped virtual files that could not be written.
    failed: Vec<String>,
}

/// Puts the drop target on the webview's child windows. Called after every
/// page load (a reload must not bring wry's back); runs on the main thread,
/// where OLE expects drop targets to be registered.
pub fn install(webview: &tauri::Webview) {
    let Ok(hwnd) = webview.window().hwnd() else { return };
    let parent = hwnd.0 as isize;
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    let _ = webview.run_on_main_thread(move || unsafe { register(parent, app, label) });
}

unsafe fn register(parent: isize, app: AppHandle, label: String) {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
        list.push(hwnd.0 as isize);
        true.into()
    }
    let mut children: Vec<isize> = Vec::new();
    let _ = unsafe {
        EnumChildWindows(Some(HWND(parent as *mut c_void)), Some(collect), LPARAM(&mut children as *mut _ as isize))
    };
    for child in children {
        let hwnd = HWND(child as *mut c_void);
        let target: IDropTarget = DropTarget {
            app: app.clone(),
            label: label.clone(),
            kind: Cell::new(Kind::None),
        }
        .into();
        // Same test as wry's: a window that can't take a drop target says so
        // on revoking; any other answer (none registered yet) is fine.
        if unsafe { RevokeDragDrop(hwnd) } != Err(DRAGDROP_E_INVALIDHWND.into()) {
            let _ = unsafe { RegisterDragDrop(hwnd, &target) };
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// Nothing this app can take (text, a link, …).
    None,
    /// Files with real paths.
    Paths,
    /// Virtual files (Outlook and the like).
    Virtual,
}

#[implement(IDropTarget)]
struct DropTarget {
    app: AppHandle,
    label: String,
    kind: Cell<Kind>,
}

impl DropTarget {
    fn emit(&self, kind: &'static str, paths: Vec<String>, failed: Vec<String>) {
        let _ = self.app.emit(
            EVENT,
            Payload {
                label: self.label.clone(),
                kind,
                paths,
                failed,
            },
        );
    }
}

fn clipboard_format(name: PCWSTR) -> u16 {
    unsafe { RegisterClipboardFormatW(name) as u16 }
}

fn format(cf: u16, lindex: i32, tymed: u32) -> FORMATETC {
    FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex,
        tymed,
    }
}

fn has_format(data: &IDataObject, cf: u16) -> bool {
    let hr: HRESULT = unsafe { data.QueryGetData(&format(cf, -1, TYMED_HGLOBAL.0 as u32)) };
    hr == S_OK
}

fn classify(data: &IDataObject) -> Kind {
    if has_format(data, CF_HDROP.0) {
        Kind::Paths
    } else if has_format(data, clipboard_format(CFSTR_FILEDESCRIPTORW))
        || has_format(data, clipboard_format(CFSTR_FILEDESCRIPTORA))
    {
        Kind::Virtual
    } else {
        Kind::None
    }
}

/// "Copy" if the source allows it, else nothing — never "move".
fn effect(kind: Kind, allowed: DROPEFFECT) -> DROPEFFECT {
    if kind != Kind::None && allowed.0 & DROPEFFECT_COPY.0 != 0 {
        DROPEFFECT_COPY
    } else {
        DROPEFFECT_NONE
    }
}

unsafe fn dropped_paths(data: &IDataObject) -> Vec<String> {
    let Ok(mut medium) = (unsafe { data.GetData(&format(CF_HDROP.0, -1, TYMED_HGLOBAL.0 as u32)) }) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    unsafe {
        let hdrop = HDROP(medium.u.hGlobal.0);
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, None) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(hdrop, i, Some(&mut buf));
            paths.push(OsString::from_wide(&buf[..len]).to_string_lossy().into_owned());
        }
        ReleaseStgMedium(&mut medium);
    }
    paths
}

struct Descriptor {
    name: String,
    size: Option<u64>,
    is_dir: bool,
}

fn wide_until_nul(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn ansi_until_nul(buf: &[i8]) -> String {
    let bytes: Vec<u8> = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    if bytes.is_empty() {
        return String::new();
    }
    let mut wide = vec![0u16; bytes.len() * 2 + 1];
    let n = unsafe { MultiByteToWideChar(CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0), &bytes, Some(&mut wide)) };
    if n <= 0 {
        return String::from_utf8_lossy(&bytes).into_owned();
    }
    String::from_utf16_lossy(&wide[..n as usize])
}

fn describe(flags: u32, attributes: u32, size_high: u32, size_low: u32, name: String) -> Descriptor {
    Descriptor {
        name,
        size: (flags & FD_FILESIZE.0 as u32 != 0).then(|| ((size_high as u64) << 32) | size_low as u64),
        is_dir: flags & FD_ATTRIBUTES.0 as u32 != 0 && attributes & FILE_ATTRIBUTE_DIRECTORY != 0,
    }
}

/// The file list of a virtual-file drag. The memory block holds a count and
/// that many descriptors; the count is checked against the block's size,
/// so a sender that lies about it can't make this read past its end.
unsafe fn descriptors(data: &IDataObject) -> Vec<Descriptor> {
    for wide in [true, false] {
        let cf = clipboard_format(if wide { CFSTR_FILEDESCRIPTORW } else { CFSTR_FILEDESCRIPTORA });
        let Ok(mut medium) = (unsafe { data.GetData(&format(cf, -1, TYMED_HGLOBAL.0 as u32)) }) else { continue };
        let mut out = Vec::new();
        unsafe {
            let hglobal = medium.u.hGlobal;
            let base = GlobalLock(hglobal) as *const u8;
            if !base.is_null() {
                let size = GlobalSize(hglobal);
                let item = if wide { size_of::<FILEDESCRIPTORW>() } else { size_of::<FILEDESCRIPTORA>() };
                if size >= 4 {
                    let count = (std::ptr::read_unaligned(base as *const u32) as usize).min((size - 4) / item);
                    for i in 0..count {
                        let at = base.add(4 + i * item);
                        out.push(if wide {
                            let fd = std::ptr::read_unaligned(at as *const FILEDESCRIPTORW);
                            let name = fd.cFileName;
                            describe(fd.dwFlags, fd.dwFileAttributes, fd.nFileSizeHigh, fd.nFileSizeLow, wide_until_nul(&name))
                        } else {
                            let fd = std::ptr::read_unaligned(at as *const FILEDESCRIPTORA);
                            let name = fd.cFileName;
                            describe(fd.dwFlags, fd.dwFileAttributes, fd.nFileSizeHigh, fd.nFileSizeLow, ansi_until_nul(&name))
                        });
                    }
                }
                let _ = GlobalUnlock(hglobal);
            }
            ReleaseStgMedium(&mut medium);
        }
        if !out.is_empty() {
            return out;
        }
    }
    Vec::new()
}

/// Writes a memory block, at most the size the descriptor gives: the block
/// may be rounded up.
unsafe fn write_hglobal(medium: &windows::Win32::System::Com::STGMEDIUM, size: Option<u64>, file: &Path) -> Result<(), String> {
    unsafe {
        let hglobal = medium.u.hGlobal;
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            return Err("GlobalLock".into());
        }
        let mut len = GlobalSize(hglobal);
        if let Some(size) = size {
            len = len.min(size as usize);
        }
        let result = fs::write(file, std::slice::from_raw_parts(ptr, len)).map_err(|e| e.to_string());
        let _ = GlobalUnlock(hglobal);
        result
    }
}

/// Copies a stream piece by piece, so a large attachment never has to fit
/// in memory.
unsafe fn write_stream(stream: &IStream, file: &Path) -> Result<(), String> {
    unsafe {
        // Some senders hand over a stream that was already read from.
        let _ = stream.Seek(0, STREAM_SEEK_SET, None);
        let mut out = fs::File::create(file).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let mut read = 0u32;
            let hr = stream.Read(buf.as_mut_ptr() as *mut c_void, buf.len() as u32, Some(&mut read as *mut u32));
            if hr.is_err() {
                return Err(hr.message());
            }
            if read == 0 {
                break;
            }
            out.write_all(&buf[..read as usize]).map_err(|e| e.to_string())?;
        }
        out.sync_all().map_err(|e| e.to_string())
    }
}

/// An Outlook message comes as a structured storage; copied into a new
/// compound file, that is exactly a `.msg` file.
unsafe fn write_storage(storage: &IStorage, file: &Path) -> Result<(), String> {
    unsafe {
        let name = HSTRING::from(file.as_os_str());
        let dest = StgCreateDocfile(&name, STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE, None)
            .map_err(|e| e.message())?;
        storage.CopyTo(None, None, &dest).map_err(|e| e.message())?;
        dest.Commit(0).map_err(|e| e.message())?;
        Ok(())
    }
}

unsafe fn save_one(data: &IDataObject, cf_contents: u16, index: i32, descriptor: &Descriptor, file: &Path) -> Result<(), String> {
    let tymed = (TYMED_HGLOBAL.0 | TYMED_ISTREAM.0 | TYMED_ISTORAGE.0) as u32;
    let mut medium = unsafe { data.GetData(&format(cf_contents, index, tymed)) }.map_err(|e| e.message())?;
    let result = unsafe {
        match medium.tymed as i32 {
            t if t == TYMED_HGLOBAL.0 => write_hglobal(&medium, descriptor.size, file),
            t if t == TYMED_ISTREAM.0 => match (*medium.u.pstm).as_ref() {
                Some(stream) => write_stream(stream, file),
                None => Err("no stream".into()),
            },
            t if t == TYMED_ISTORAGE.0 => match (*medium.u.pstg).as_ref() {
                Some(storage) => write_storage(storage, file),
                None => Err("no storage".into()),
            },
            other => Err(format!("medium {other}")),
        }
    };
    unsafe { ReleaseStgMedium(&mut medium) };
    result?;
    // An empty result for a file that isn't empty means the sender gave up.
    let len = fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    if len == 0 && descriptor.size != Some(0) {
        return Err("empty".into());
    }
    Ok(())
}

/// Writes all virtual files of a drop into the lasting store. Returns the
/// new paths and the names of the files that failed. Folders are skipped:
/// their files come as entries of their own.
unsafe fn save_virtual(data: &IDataObject, app: &AppHandle) -> (Vec<String>, Vec<String>) {
    let store = dropped_files::store_dir(app);
    let list = unsafe { descriptors(data) };
    let names = || -> Vec<String> {
        list.iter().filter(|d| !d.is_dir).map(|d| dropped_files::sanitize_file_name(&d.name, FALLBACK_NAME)).collect()
    };
    let Some(store) = store else { return (Vec::new(), names()) };
    let cf_contents = clipboard_format(CFSTR_FILECONTENTS);
    let (mut paths, mut failed) = (Vec::new(), Vec::new());
    for (index, descriptor) in list.iter().enumerate() {
        if descriptor.is_dir {
            continue;
        }
        let name = dropped_files::sanitize_file_name(&descriptor.name, FALLBACK_NAME);
        let saved = dropped_files::new_slot(&store, &name)
            .map_err(|e| e.to_string())
            .and_then(|file| match unsafe { save_one(data, cf_contents, index as i32, descriptor, &file) } {
                Ok(()) => Ok(file),
                Err(e) => {
                    dropped_files::remove_slot(&store, &file);
                    Err(e)
                }
            });
        match saved {
            Ok(file) => paths.push(file.to_string_lossy().into_owned()),
            Err(e) => {
                crate::debug_log::append(app, &format!("virtual drop of {name} failed: {e}"));
                failed.push(name);
            }
        }
    }
    (paths, failed)
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for DropTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let kind = pdataobj.ok().map(classify).unwrap_or(Kind::None);
        self.kind.set(kind);
        unsafe { *pdweffect = effect(kind, *pdweffect) };
        if kind != Kind::None {
            self.emit("enter", Vec::new(), Vec::new());
        }
        Ok(())
    }

    fn DragOver(&self, _grfkeystate: MODIFIERKEYS_FLAGS, _pt: &POINTL, pdweffect: *mut DROPEFFECT) -> windows::core::Result<()> {
        let kind = self.kind.get();
        unsafe { *pdweffect = effect(kind, *pdweffect) };
        if kind != Kind::None {
            self.emit("over", Vec::new(), Vec::new());
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        if self.kind.replace(Kind::None) != Kind::None {
            self.emit("leave", Vec::new(), Vec::new());
        }
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let kind = self.kind.replace(Kind::None);
        unsafe { *pdweffect = effect(kind, *pdweffect) };
        let Ok(data) = pdataobj.ok() else { return Ok(()) };
        let (paths, failed) = match kind {
            Kind::None => return Ok(()),
            Kind::Paths => (unsafe { dropped_paths(data) }, Vec::new()),
            Kind::Virtual => unsafe { save_virtual(data, &self.app) },
        };
        if paths.is_empty() {
            unsafe { *pdweffect = DROPEFFECT_NONE };
        }
        self.emit("drop", paths, failed);
        Ok(())
    }
}
