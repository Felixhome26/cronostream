use std::fs::File;
use std::io::BufReader;
use std::path::Path;

/// Reads the EXIF `DateTimeOriginal` tag from an image, if present, and
/// returns it as an RFC3339 string. This is the highest-priority source in
/// the timestamp resolution chain (see project concept): it's written at
/// capture time and survives copy operations, unlike filesystem dates.
pub fn read_datetime_original(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()?;

    let field = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY))?;

    let value = ascii_field_value(field)?;

    // EXIF 2.31 added an explicit UTC offset for the capture time. Cameras
    // that write it are the only case where the zone is actually known —
    // everything else falls back to this machine's zone below.
    let offset = exif
        .get_field(exif::Tag::OffsetTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::OffsetTime, exif::In::PRIMARY))
        .and_then(ascii_field_value);

    parse_exif_datetime(&value, offset.as_deref())
}

/// The field's raw ASCII contents, rather than its `display_value()`.
///
/// That display is deliberately human-readable and tag-aware: for DateTime
/// tags it rewrites the EXIF spelling "2023:06:15 14:23:01" into
/// "2023-06-15 14:23:01", and it quotes plain ASCII values. Parsing it as
/// if it were the stored value is what made *every* photo fall back to a
/// filesystem date — silently, since an unparseable date is indistinguishable
/// from a missing one here.
fn ascii_field_value(field: &exif::Field) -> Option<String> {
    match &field.value {
        exif::Value::Ascii(parts) => parts.first().map(|bytes| String::from_utf8_lossy(bytes).trim().to_string()),
        _ => None,
    }
}

/// Every date-bearing field of an EXIF block, exactly as the camera wrote
/// it — unconverted on purpose: these are handed to a reader (the AI check)
/// that should see the raw readings, not this app's interpretation of them.
/// The interpreted value lives in the item's own `embedded_metadata_at`.
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct ExifDateFields {
    /// DateTimeOriginal — when the shutter fired. The one that counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured: Option<String>,
    /// DateTimeDigitized — when it became a file. Identical to `captured`
    /// for a digital camera, but a scan of a paper photo carries the
    /// scanning date here, which is exactly the case where the two must
    /// not be confused.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digitized: Option<String>,
    /// DateTime — last modification, in camera or in software.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    /// OffsetTimeOriginal/OffsetTime — the UTC offset, on the rare cameras
    /// that record it. Without it the readings above are a bare wall clock
    /// with no zone, which is the root of most date confusion here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utc_offset: Option<String>,
    /// GPSDateStamp + GPSTimeStamp: UTC straight from the satellites, and
    /// therefore the only timestamp in the file that is independent of the
    /// camera's own clock. Where it disagrees with `captured`, the camera
    /// clock was wrong — which no other field can reveal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gps_utc: Option<String>,
}

impl ExifDateFields {
    fn is_empty(&self) -> bool {
        self.captured.is_none()
            && self.digitized.is_none()
            && self.modified.is_none()
            && self.utc_offset.is_none()
            && self.gps_utc.is_none()
    }
}

fn ascii_tag(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    let text = ascii_field_value(field)?;
    (!text.is_empty()).then_some(text)
}

/// GPSTimeStamp is three rationals (hour, minute, second) in UTC, paired
/// with GPSDateStamp ("2015:02:14"). Joined here into one readable UTC
/// reading; the date alone is still worth reporting if the time is absent.
fn gps_utc(exif: &exif::Exif) -> Option<String> {
    let date = ascii_tag(exif, exif::Tag::GPSDateStamp)?;
    let Some(field) = exif.get_field(exif::Tag::GPSTimeStamp, exif::In::PRIMARY) else {
        return Some(date);
    };
    match &field.value {
        exif::Value::Rational(parts) if parts.len() >= 3 => Some(format!(
            "{date} {:02}:{:02}:{:02} UTC",
            parts[0].to_f64() as u32,
            parts[1].to_f64() as u32,
            parts[2].to_f64() as u32
        )),
        _ => Some(date),
    }
}

/// Reads all of the above, or `None` when the file carries no EXIF dates.
pub fn read_date_fields(path: &Path) -> Option<ExifDateFields> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;

    let fields = ExifDateFields {
        captured: ascii_tag(&exif, exif::Tag::DateTimeOriginal),
        digitized: ascii_tag(&exif, exif::Tag::DateTimeDigitized),
        modified: ascii_tag(&exif, exif::Tag::DateTime),
        utc_offset: ascii_tag(&exif, exif::Tag::OffsetTimeOriginal).or_else(|| ascii_tag(&exif, exif::Tag::OffsetTime)),
        gps_utc: gps_utc(&exif),
    };
    (!fields.is_empty()).then_some(fields)
}

/// EXIF datetimes look like "2023:06:15 14:23:01" — convert to RFC3339.
///
/// The clock reading carries no zone of its own, so it is interpreted in
/// the *system* timezone (or in `OffsetTimeOriginal`, when the camera wrote
/// one). It used to be stamped `and_utc()`, which kept the digits but moved
/// the instant: a photo taken at 14:23 CEST became 14:23Z and was then
/// displayed as 16:23 — two hours late everywhere, and on the wrong day for
/// anything shot late in the evening.
fn parse_exif_datetime(raw: &str, offset: Option<&str>) -> Option<String> {
    let cleaned = raw.trim().trim_matches('"').trim();
    // Both spellings are accepted on purpose: the EXIF one that the stored
    // bytes actually use, and the dash-separated one the exif crate's
    // display formatting produces — so routing a value through the wrong
    // one of those can never again turn into a silently missing date.
    let naive = chrono::NaiveDateTime::parse_from_str(cleaned, "%Y:%m:%d %H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(cleaned, "%Y-%m-%d %H:%M:%S"))
        .ok()?;
    // A year no photo can have been taken in (before the first photograph,
    // or past next year) is a broken or unset camera clock, not a date —
    // left to the fallback sources rather than put on the timeline.
    use chrono::Datelike;
    if !(1826..=chrono::Local::now().year() + 1).contains(&naive.year()) {
        return None;
    }

    if let Some(offset) = offset {
        let cleaned = offset.trim().trim_matches('"').trim();
        // "+02:00" / "-05:00" — appended to the naive reading makes a
        // complete RFC3339 timestamp. An unknown offset (cameras write
        // "   :  " when the field is unset) just falls through.
        if let Ok(parsed) =
            chrono::DateTime::parse_from_rfc3339(&format!("{}{}", naive.format("%Y-%m-%dT%H:%M:%S"), cleaned))
        {
            return Some(parsed.to_rfc3339());
        }
    }

    Some(local_to_rfc3339(naive))
}

/// Interprets a naive clock reading in the system timezone. The two awkward
/// DST cases are resolved rather than dropped: in the repeated hour the
/// earlier of the two instants wins, and a reading inside the skipped hour
/// (a clock time that never existed locally) is nudged forward by an hour
/// so the file still lands on the right day at roughly the right time.
pub(crate) fn local_to_rfc3339(naive: chrono::NaiveDateTime) -> String {
    use chrono::TimeZone;
    if let Some(dt) = chrono::Local.from_local_datetime(&naive).earliest() {
        return dt.to_rfc3339();
    }
    let shifted = naive + chrono::Duration::hours(1);
    chrono::Local
        .from_local_datetime(&shifted)
        .earliest()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| naive.and_utc().to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_implausible_camera_year_is_no_date() {
        assert_eq!(parse_exif_datetime("0001:01:01 00:00:00", None), None);
        assert_eq!(parse_exif_datetime("2100:06:15 14:23:01", None), None);
        assert!(parse_exif_datetime("1999:06:15 14:23:01", None).is_some());
    }

    #[test]
    fn explicit_offset_wins() {
        let out = parse_exif_datetime("2023:06:15 14:23:01", Some("+02:00")).unwrap();
        assert_eq!(out, "2023-06-15T14:23:01+02:00");
    }

    #[test]
    fn unset_offset_falls_back_to_system_zone() {
        use chrono::TimeZone;
        let naive = chrono::NaiveDateTime::parse_from_str("2023:06:15 14:23:01", "%Y:%m:%d %H:%M:%S").unwrap();
        let expected = chrono::Local.from_local_datetime(&naive).earliest().unwrap().to_rfc3339();
        assert_eq!(parse_exif_datetime("2023:06:15 14:23:01", Some("   :  ")).unwrap(), expected);
        assert_eq!(parse_exif_datetime("2023:06:15 14:23:01", None).unwrap(), expected);
    }

    #[test]
    fn accepts_the_crates_display_spelling_too() {
        // The regression that made every photo fall back to a filesystem
        // date: `display_value()` hands out dashes, not the EXIF colons.
        let out = parse_exif_datetime("2023-06-15 14:23:01", Some("+02:00")).unwrap();
        assert_eq!(out, "2023-06-15T14:23:01+02:00");
    }

    #[test]
    fn quoted_values_are_accepted() {
        let out = parse_exif_datetime("\"2023:06:15 14:23:01\"", Some("+02:00")).unwrap();
        assert_eq!(out, "2023-06-15T14:23:01+02:00");
    }

    #[test]
    fn keeps_the_wall_clock_reading_of_the_local_zone() {
        // The regression this replaced: the digits must survive, i.e. the
        // stored instant must *show* 14:23 again in local time.
        use chrono::TimeZone;
        let out = parse_exif_datetime("2023:06:15 14:23:01", None).unwrap();
        let parsed = chrono::DateTime::parse_from_rfc3339(&out).unwrap().with_timezone(&chrono::Local);
        assert_eq!(parsed.format("%Y-%m-%d %H:%M:%S").to_string(), "2023-06-15 14:23:01");
        let _ = chrono::Local.timestamp_opt(0, 0);
    }
}
