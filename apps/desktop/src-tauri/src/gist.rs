//! The requests behind sync: GitHub's REST gist API, with errors as the text
//! to show. What goes in the gist and how copies merge is in the core crate.

use reqwest::{Client, Response, StatusCode};
use review_pinger_core::sync;

const API: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
/// Gists are listed 100 at a time, newest update first.
const MAX_LIST_PAGES: u32 = 5;

fn request(
    http: &Client,
    method: reqwest::Method,
    url: &str,
    token: &str,
) -> reqwest::RequestBuilder {
    http.request(method, url)
        .bearer_auth(token)
        .header("accept", "application/vnd.github+json")
        .header("content-type", "application/json")
        .header("x-github-api-version", API_VERSION)
}

async fn send(request: reqwest::RequestBuilder) -> Result<Response, String> {
    request
        .send()
        .await
        .map_err(|e| format!("Can't reach GitHub: {e}"))
}

fn failed(status: StatusCode) -> String {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => {
            "GitHub wouldn't let this token use gists. Check that it has the gist scope.".into()
        }
        status => format!("GitHub returned HTTP {status} for the sync gist."),
    }
}

/// Whether the token can use gists, which GitHub reports in a header on
/// every response.
pub async fn can_sync(http: &Client, token: &str) -> Result<bool, String> {
    let response = send(request(
        http,
        reqwest::Method::GET,
        &format!("{API}/user"),
        token,
    ))
    .await?;
    if !response.status().is_success() {
        return Err(format!("GitHub returned HTTP {}.", response.status()));
    }
    let scopes = response
        .headers()
        .get("x-oauth-scopes")
        .and_then(|value| value.to_str().ok());
    Ok(sync::can_sync(scopes))
}

/// The id of the user's sync gist, if they have one.
pub async fn find(http: &Client, token: &str) -> Result<Option<String>, String> {
    for page in 1..=MAX_LIST_PAGES {
        let url = format!("{API}/gists?per_page=100&page={page}");
        let response = send(request(http, reqwest::Method::GET, &url, token)).await?;
        if !response.status().is_success() {
            return Err(failed(response.status()));
        }
        let list = response.text().await.map_err(|e| e.to_string())?;
        if let Some(id) = sync::find_gist(&list) {
            return Ok(Some(id));
        }
        // A short page was the last.
        let count = serde_json::from_str::<Vec<serde_json::Value>>(&list).map_or(0, |l| l.len());
        if count < 100 {
            break;
        }
    }
    Ok(None)
}

/// The gist as GitHub returns it, or `None` when it's gone.
pub async fn read(http: &Client, token: &str, id: &str) -> Result<Option<String>, String> {
    let url = format!("{API}/gists/{id}");
    let response = send(request(http, reqwest::Method::GET, &url, token)).await?;
    match response.status() {
        StatusCode::NOT_FOUND => Ok(None),
        status if status.is_success() => response.text().await.map(Some).map_err(|e| e.to_string()),
        status => Err(failed(status)),
    }
}

/// Creates the gist and returns its id.
pub async fn create(http: &Client, token: &str, body: String) -> Result<String, String> {
    let url = format!("{API}/gists");
    let response = send(request(http, reqwest::Method::POST, &url, token).body(body)).await?;
    if !response.status().is_success() {
        return Err(failed(response.status()));
    }
    let created: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    created["id"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "GitHub's reply had no gist id.".to_string())
}

pub async fn update(http: &Client, token: &str, id: &str, body: String) -> Result<(), String> {
    let url = format!("{API}/gists/{id}");
    let response = send(request(http, reqwest::Method::PATCH, &url, token).body(body)).await?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(failed(response.status()))
    }
}
