//! What Review Pinger knows about pull requests, independent of where it runs:
//! the response types, the derivation of lists, notifications, check timing,
//! and the state kept between polls. No I/O beyond reading and writing the
//! state file, so it also compiles for the browser.

pub mod auth;
pub mod calendar;
pub mod checks;
pub mod directory;
pub mod engine;
pub mod github;
pub mod memory;
pub mod merged;
pub mod notify;
pub mod prs;
pub mod reviews;
pub mod sections;
pub mod settings;
pub mod slack;
pub mod sync;
