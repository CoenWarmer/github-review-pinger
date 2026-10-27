//! Elapsed time that skips weekends, measured on the user's local calendar.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc, Weekday};

/// Time between `start` and `end` that falls on Monday through Friday in `tz`.
/// Weekdays count in full (not just office hours), so "24 business hours" is
/// one working day.
pub fn weekday_time<Tz: TimeZone>(start: DateTime<Utc>, end: DateTime<Utc>, tz: &Tz) -> Duration {
    let mut total = Duration::zero();
    if end <= start {
        return total;
    }

    let mut day = start.with_timezone(tz).date_naive();
    let last = end.with_timezone(tz).date_naive();
    while day <= last {
        let next = day.succ_opt().expect("date in range");
        if !matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
            let from = local_midnight(tz, day).max(start);
            let to = local_midnight(tz, next).min(end);
            if to > from {
                total += to - from;
            }
        }
        day = next;
    }
    total
}

/// The first instant of `date` in `tz`. In zones where DST starts at midnight,
/// local midnight doesn't exist and the day starts at the end of the gap.
fn local_midnight<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> DateTime<Utc> {
    let mut local = date.and_hms_opt(0, 0, 0).expect("midnight is valid");
    loop {
        match tz.from_local_datetime(&local) {
            LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => return t.with_timezone(&Utc),
            LocalResult::None => local += Duration::minutes(15),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::America::Sao_Paulo;
    use chrono_tz::Europe::Amsterdam;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn counts_weekday_time_in_full() {
        // Tue 10:00 → Wed 16:00 in Amsterdam (CEST).
        let elapsed = weekday_time(
            at("2026-10-06T08:00:00Z"),
            at("2026-10-07T14:00:00Z"),
            &Amsterdam,
        );
        assert_eq!(elapsed, Duration::hours(30));
    }

    #[test]
    fn skips_the_weekend() {
        // Fri 17:00 → Mon 17:00 local is one business day.
        let elapsed = weekday_time(
            at("2026-10-09T15:00:00Z"),
            at("2026-10-12T15:00:00Z"),
            &Amsterdam,
        );
        assert_eq!(elapsed, Duration::hours(24));
    }

    #[test]
    fn weekend_only_counts_nothing() {
        let elapsed = weekday_time(
            at("2026-10-10T08:00:00Z"),
            at("2026-10-11T20:00:00Z"),
            &Amsterdam,
        );
        assert_eq!(elapsed, Duration::zero());
    }

    #[test]
    fn weekend_boundaries_follow_local_time_across_dst() {
        // Fri 2026-10-23 12:00 CEST → Mon 2026-10-26 12:00 CET. DST ends on
        // the Sunday, so 73 wall-clock hours hold 12 + 12 weekday hours.
        let elapsed = weekday_time(
            at("2026-10-23T10:00:00Z"),
            at("2026-10-26T11:00:00Z"),
            &Amsterdam,
        );
        assert_eq!(elapsed, Duration::hours(24));
    }

    #[test]
    fn days_starting_inside_a_dst_gap_begin_after_it() {
        // Brazil started DST at midnight on 2018-11-04, so that day began at 01:00.
        let date = NaiveDate::from_ymd_opt(2018, 11, 4).unwrap();
        assert_eq!(local_midnight(&Sao_Paulo, date), at("2018-11-04T03:00:00Z"));
    }

    #[test]
    fn reversed_range_is_empty() {
        let elapsed = weekday_time(
            at("2026-10-07T00:00:00Z"),
            at("2026-10-06T00:00:00Z"),
            &Amsterdam,
        );
        assert_eq!(elapsed, Duration::zero());
    }
}
