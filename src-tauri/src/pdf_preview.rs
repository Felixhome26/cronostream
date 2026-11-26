//! PDF previews and text through PDFium — Chrome's PDF engine, BSD/Apache
//! licensed — loaded from the shared library that ships with the app
//! (`scripts/fetch-pdfium.mjs` puts it into `src-tauri/pdfium/`, Tauri
//! bundles that folder as a resource). It replaced the Poppler tools
//! (`pdftoppm`/`pdftotext`), whose GPL doesn't fit a commercial app and
//! which Windows and macOS don't have anyway.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use pdfium_render::prelude::*;

/// Set at startup to the bundled resource folder (see `lib.rs`), so the
/// library is found wherever the installer put the app.
static LIBRARY_DIR: OnceLock<PathBuf> = OnceLock::new();
static PDFIUM: OnceLock<Pdfium> = OnceLock::new();
static BINDING: Mutex<()> = Mutex::new(());

pub fn set_library_dir(dir: PathBuf) {
    let _ = LIBRARY_DIR.set(dir);
}

/// Where to look for the library, in order: the bundled resource folder,
/// the checkout's `src-tauri/pdfium/` (dev runs and the maintenance
/// binaries in `src/bin`), next to the executable.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = LIBRARY_DIR.get().cloned().into_iter().collect();
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("pdfium"));
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        dirs.push(exe_dir.join("pdfium"));
        dirs.push(exe_dir);
    }
    dirs
}

/// The process-wide PDFium instance. PDFium can only be initialized once
/// per process, hence one shared instance (the crate's `thread_safe`
/// feature serializes access to it). A failed load is not cached, so a
/// library that turns up later is still picked up.
fn pdfium() -> Result<&'static Pdfium, String> {
    if let Some(pdfium) = PDFIUM.get() {
        return Ok(pdfium);
    }
    let _guard = BINDING.lock().map_err(|_| crate::i18n::tr("PDF-Bibliothek ist in einem ungültigen Zustand.").to_string())?;
    if let Some(pdfium) = PDFIUM.get() {
        return Ok(pdfium);
    }

    let bindings = candidate_dirs()
        .into_iter()
        .map(|dir| Pdfium::pdfium_platform_library_name_at_path(&dir))
        .filter(|path| path.is_file())
        .find_map(|path| Pdfium::bind_to_library(&path).ok())
        .or_else(|| Pdfium::bind_to_system_library().ok())
        .ok_or(crate::i18n::tr("Die PDF-Bibliothek (PDFium) wurde nicht gefunden."))?;

    Ok(PDFIUM.get_or_init(|| Pdfium::new(bindings)))
}

/// Renders the first page of a PDF to a JPEG whose longer side is 640 px.
/// `dest_without_ext` is the desired output path *without* an extension;
/// the file written is `{dest_without_ext}.jpg`, whose full path is
/// returned.
pub fn render_first_page(source: &Path, dest_without_ext: &Path) -> Result<PathBuf, String> {
    if let Some(parent) = dest_without_ext.parent() {
        std::fs::create_dir_all(parent).map_err(|e| crate::trf!("Konnte Vorschau-Ordner nicht anlegen: {e}", e = e))?;
    }

    let document = pdfium()?
        .load_pdf_from_file(source, None)
        .map_err(|e| crate::trf!("PDF konnte nicht geöffnet werden: {e}", e = e))?;
    let page = document.pages().first().map_err(|e| crate::trf!("PDF hat keine Seite: {e}", e = e))?;
    let config = PdfRenderConfig::new().set_target_width(640).set_maximum_height(640);
    let image = page
        .render_with_config(&config)
        .and_then(|bitmap| bitmap.as_image())
        .map_err(|e| crate::trf!("Konnte keine PDF-Vorschau erzeugen: {e}", e = e))?;

    let produced = dest_without_ext.with_extension("jpg");
    // JPEG has no alpha channel; PDFium renders onto white already.
    image
        .into_rgb8()
        .save_with_format(&produced, image::ImageFormat::Jpeg)
        .map_err(|e| crate::trf!("Konnte PDF-Vorschau nicht speichern: {e}", e = e))?;
    Ok(produced)
}

/// Extracts the plain text content of a PDF, page by page.
pub fn extract_text(source: &Path) -> Result<String, String> {
    let document = pdfium()?
        .load_pdf_from_file(source, None)
        .map_err(|e| crate::trf!("PDF konnte nicht geöffnet werden: {e}", e = e))?;
    let pages: Vec<String> = document
        .pages()
        .iter()
        .filter_map(|page| page.text().ok().map(|text| text.all()))
        .collect();
    Ok(pages.join("\n\n").trim().to_string())
}
