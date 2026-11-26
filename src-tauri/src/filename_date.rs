//! Capture time read out of the file's own name.
//!
//! Phone cameras name their files after the device clock at the moment of
//! capture ("20150207_150541.avi", "IMG_20191026_121849.jpg"), which makes
//! the name an independent witness of the same instant the metadata should
//! carry — and a surviving one: it is copied along with the file, while
//! filesystem dates are rewritten by every copy. Measured against 309
//! photos that carry both, the name agreed with the EXIF capture time in
//! every single case.
//!
//! It is used where there is nothing better: after embedded metadata, but
//! ahead of the filesystem dates.

use std::path::Path;

use chrono::{Datelike, NaiveDate, NaiveDateTime};

/// No digital camera wrote files before this, so a "date" older than it is
/// a number that merely looks like one.
const MIN_YEAR: i32 = 1990;
/// Clock skew allowance — a capture time slightly in the future is a
/// mis-set device clock, further ahead than this is not a capture time.
const MAX_DAYS_AHEAD: i64 = 2;

/// Separators seen between the parts of a timestamp in a filename.
fn is_separator(byte: u8) -> bool {
    matches!(byte, b'-' | b'_' | b'.' | b':' | b' ')
}

/// Reads `count` digits at `index`, advancing it. Returns `None` unless
/// exactly that many digits are there.
fn take_digits(bytes: &[u8], index: &mut usize, count: usize) -> Option<u32> {
    let end = index.checked_add(count)?;
    if end > bytes.len() {
        return None;
    }
    let slice = &bytes[*index..end];
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *index = end;
    std::str::from_utf8(slice).ok()?.parse().ok()
}

/// Steps over one optional separator. Reports whether it found one.
fn skip_separator(bytes: &[u8], index: &mut usize) -> bool {
    if bytes.get(*index).is_some_and(|b| is_separator(*b)) {
        *index += 1;
        return true;
    }
    false
}

fn parse_at(bytes: &[u8], start: usize) -> Option<NaiveDateTime> {
    // A timestamp never starts in the middle of a longer number — without
    // this, "060220132315.jpg" would offer "2013" as a year.
    if start > 0 && bytes[start - 1].is_ascii_digit() {
        return None;
    }

    let mut index = start;
    let year = take_digits(bytes, &mut index, 4)? as i32;
    skip_separator(bytes, &mut index);
    let month = take_digits(bytes, &mut index, 2)?;
    skip_separator(bytes, &mut index);
    let day = take_digits(bytes, &mut index, 2)?;
    // The date and the time *must* be separated. Otherwise any eight-digit
    // run followed by six more digits — a scanner's counter, an account
    // number — would read as a timestamp.
    if !skip_separator(bytes, &mut index) {
        return None;
    }
    let hour = take_digits(bytes, &mut index, 2)?;
    skip_separator(bytes, &mut index);
    let minute = take_digits(bytes, &mut index, 2)?;
    skip_separator(bytes, &mut index);
    let second = take_digits(bytes, &mut index, 2)?;
    // Still more digits behind it: this was a longer number that happened
    // to begin like a timestamp.
    if bytes.get(index).is_some_and(u8::is_ascii_digit) {
        return None;
    }

    if !(MIN_YEAR..=chrono::Local::now().year() + 1).contains(&year) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(hour, minute, second)
}

/// WhatsApp names its media `IMG-20210213-WA0002.jpg`: type, send date
/// (YYYYMMDD), the fixed marker `WA` and a per-day counter. The date is the
/// day the file was sent or received — WhatsApp strips the EXIF data, so no
/// capture time survives and the name is the only witness there is.
///
/// A name carries no time of day, so the file is placed at noon local time
/// (far from midnight, which keeps the day stable across time zones), plus
/// one second per counter step so same-day files keep their send order.
pub fn read_whatsapp_date(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let (kind, rest) = stem.split_once('-')?;
    if !matches!(kind.to_ascii_uppercase().as_str(), "IMG" | "VID" | "AUD" | "PTT" | "DOC") {
        return None;
    }
    let (date, counter) = rest.split_once('-')?;
    let counter = counter.get(..2).filter(|m| m.eq_ignore_ascii_case("WA")).and_then(|_| counter.get(2..))?;
    // Duplicates get a suffix like "WA0002 (1)" — only the leading digits count.
    let digits: String = counter.chars().take_while(char::is_ascii_digit).collect();
    if date.len() != 8 || !date.bytes().all(|b| b.is_ascii_digit()) || digits.len() < 4 {
        return None;
    }
    let year: i32 = date[0..4].parse().ok()?;
    if !(MIN_YEAR..=chrono::Local::now().year() + 1).contains(&year) {
        return None;
    }
    let day = NaiveDate::from_ymd_opt(year, date[4..6].parse().ok()?, date[6..8].parse().ok()?)?;
    let seconds = digits.parse::<u32>().ok()?.min(86_399 / 2);
    let naive = day.and_hms_opt(12, 0, 0)? + chrono::Duration::seconds(i64::from(seconds));
    Some(crate::exif_date::local_to_rfc3339(naive))
}

/// The timestamp a filename carries, as RFC3339 — or `None` if the name
/// holds nothing that can be trusted to be one.
pub fn read_from_filename(path: &Path) -> Option<String> {
    if let Some(whatsapp) = read_whatsapp_date(path) {
        return Some(whatsapp);
    }
    let stem = path.file_stem()?.to_str()?;
    let bytes = stem.as_bytes();

    let naive = (0..bytes.len()).find_map(|start| parse_at(bytes, start))?;

    // Read as a wall clock in this machine's zone, exactly like an EXIF
    // capture time: the device wrote its own local time, with no zone.
    let rfc3339 = crate::exif_date::local_to_rfc3339(naive);
    let parsed = chrono::DateTime::parse_from_rfc3339(&rfc3339).ok()?;
    if parsed.timestamp() > (chrono::Local::now() + chrono::Duration::days(MAX_DAYS_AHEAD)).timestamp() {
        return None;
    }
    Some(rfc3339)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn local_time_of(name: &str) -> Option<String> {
        read_from_filename(&PathBuf::from(name)).map(|rfc| {
            chrono::DateTime::parse_from_rfc3339(&rfc)
                .unwrap()
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
    }

    #[test]
    fn reads_the_common_phone_spellings() {
        assert_eq!(local_time_of("20150207_150541.avi").unwrap(), "2015-02-07 15:05:41");
        assert_eq!(local_time_of("IMG_20191026_121849.jpg").unwrap(), "2019-10-26 12:18:49");
        assert_eq!(local_time_of("VID_20141115_231023.mp4").unwrap(), "2014-11-15 23:10:23");
        assert_eq!(local_time_of("2015-02-07 15.05.41.jpg").unwrap(), "2015-02-07 15:05:41");
        assert_eq!(local_time_of("Signal-2021-03-04-18-22-07.jpg").unwrap(), "2021-03-04 18:22:07");
    }

    #[test]
    fn refuses_numbers_that_merely_look_like_dates() {
        // A twelve-digit run with a year hiding inside it — a real name from
        // the library this was built for.
        assert_eq!(local_time_of("060220132315.jpg"), None);
        // Date and time run together, so where one ends is a guess.
        assert_eq!(local_time_of("20141115231023.mp4"), None);
        // A longer number that merely starts like a timestamp.
        assert_eq!(local_time_of("20141115_2310234.mp4"), None);
        assert_eq!(local_time_of("Urlaub 2015 032.jpg"), None);
        assert_eq!(local_time_of("DSC_0042.JPG"), None);
        assert_eq!(local_time_of("Rechnung 2019-10-26.pdf"), None);
    }

    #[test]
    fn reads_whatsapp_send_dates() {
        assert_eq!(local_time_of("IMG-20210213-WA0002.jpg").unwrap(), "2021-02-13 12:00:02");
        assert_eq!(local_time_of("VID-20210213-WA0010.mp4").unwrap(), "2021-02-13 12:00:10");
        assert_eq!(local_time_of("PTT-20210213-WA0001.opus").unwrap(), "2021-02-13 12:00:01");
        assert_eq!(local_time_of("IMG-20210213-WA0002 (1).jpg").unwrap(), "2021-02-13 12:00:02");
        assert_eq!(local_time_of("IMG-20211345-WA0002.jpg"), None);
        assert_eq!(local_time_of("IMG-20210213-XY0002.jpg"), None);
    }

    #[test]
    fn refuses_impossible_and_future_readings() {
        assert_eq!(local_time_of("20151345_250000.jpg"), None); // Monat 13, Stunde 25
        assert_eq!(local_time_of("19800101_120000.jpg"), None); // vor MIN_YEAR
        let far_future = format!("{}0101_120000.jpg", chrono::Local::now().year() + 3);
        assert_eq!(local_time_of(&far_future), None);
    }
}
