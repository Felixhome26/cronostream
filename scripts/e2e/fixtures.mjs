// Generated stand-in files for the end-to-end checks: one of each kind the
// timeline shows. Made fresh on every run, so no real photo, video or mail
// ever ends up in a test.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function ffmpeg(...args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

function pdf(text) {
  const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

function docx(dir, path) {
  const work = join(dir, "docx-work");
  mkdirSync(join(work, "word"), { recursive: true });
  mkdirSync(join(work, "_rels"), { recursive: true });
  writeFileSync(
    join(work, "[Content_Types].xml"),
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  writeFileSync(
    join(work, "_rels", ".rels"),
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  writeFileSync(
    join(work, "word", "document.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>CSP-Test Dokument &amp; Text</w:t></w:r></w:p></w:body></w:document>`,
  );
  execFileSync("zip", ["-q", "-r", path, "[Content_Types].xml", "_rels", "word"], { cwd: work });
  rmSync(work, { recursive: true, force: true });
}

// One picture straight in the HTML, one attached and referenced by `cid:`
// the way mail programs embed them.
function eml(pngBase64) {
  return [
    "From: Test Absender <absender@example.com>",
    "To: empfaenger@example.com",
    "Subject: CSP-Test Mail",
    "Date: Mon, 12 Oct 2026 13:12:22 +0200",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="r1"',
    "",
    "--r1",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "CSP-Test Text",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<html><body><h1>CSP-Test HTML</h1><p>Eingebettete Bilder:</p><img src="data:image/png;base64,${pngBase64}" width="40" height="40"> <img src="cid:bild1@csp-test" width="40" height="40"></body></html>`,
    "--b1--",
    "--r1",
    "Content-Type: image/png",
    "Content-ID: <bild1@csp-test>",
    "Content-Disposition: inline",
    "Content-Transfer-Encoding: base64",
    "",
    pngBase64,
    "--r1--",
    "",
  ].join("\r\n");
}

/// For the timeline check: a burst of six photos within a few minutes (one
/// stack at every zoom short of the day), single photos years apart, and a
/// PDF for the document lane. File names say what each one is, and the
/// dates come from the modification time, like the fixtures above.
export function makeTimelineFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const dated = [];
  const colors = ["red", "green", "blue", "yellow", "purple", "orange"];
  colors.forEach((color, i) => {
    const path = join(dir, `serie-${i + 1}.jpg`);
    ffmpeg("-f", "lavfi", "-i", `color=${color}:size=320x240`, "-frames:v", "1", path);
    dated.push([path, new Date(Date.UTC(2020, 4, 10, 8, i * 3))]);
  });
  for (const [name, date] of [
    ["einzel-2015.jpg", new Date(Date.UTC(2015, 2, 1, 12))],
    ["zebra-2018.jpg", new Date(Date.UTC(2018, 7, 20, 12))],
    ["einzel-2023.jpg", new Date(Date.UTC(2023, 10, 11, 12))],
  ]) {
    const path = join(dir, name);
    ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", path);
    dated.push([path, date]);
  }
  const pdfPath = join(dir, "notizen-2021.pdf");
  writeFileSync(pdfPath, pdf("Timeline-Test PDF"), "latin1");
  dated.push([pdfPath, new Date(Date.UTC(2021, 5, 1, 12))]);
  for (const [path, date] of dated) utimesSync(path, date, date);
  return dated.map(([path]) => path);
}

/** Writes the files into `dir` and returns their paths by kind. */
export function makeFixtures(dir) {
  mkdirSync(dir, { recursive: true });
  const files = {
    image: join(dir, "foto.jpg"),
    video: join(dir, "video.mp4"),
    audio: join(dir, "ton.mp3"),
    pdf: join(dir, "dokument.pdf"),
    docx: join(dir, "brief.docx"),
    email: join(dir, "mail.eml"),
  };
  ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1", files.image);
  ffmpeg(
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", files.video,
  );
  ffmpeg("-f", "lavfi", "-i", "sine=frequency=660", "-t", "3", "-c:a", "libmp3lame", files.audio);
  writeFileSync(files.pdf, pdf("CSP-Test PDF"), "latin1");
  docx(dir, files.docx);
  // A red square, embedded in the mail as a data: image.
  const png = join(dir, "pixel.png");
  ffmpeg("-f", "lavfi", "-i", "color=red:size=40x40", "-frames:v", "1", png);
  writeFileSync(files.email, eml(readFileSync(png).toString("base64")));
  rmSync(png);
  // A year apart each, so the timeline shows single tiles rather than one
  // stack of everything made in the same second.
  Object.values(files).forEach((path, i) => {
    const date = new Date(Date.UTC(2019 + i, 5, 15, 12));
    utimesSync(path, date, date);
  });
  return files;
}
