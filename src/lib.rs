use crate::values::Depth;
use base64;
use dav::{DavErrResponse, DavResponse, DavResponseType, DavStreamResponse};
use r2::R2;
use values::Overwrite;
use worker::*;

mod dav;
mod r2;
mod values;
mod xml;

#[event(fetch)]
async fn main(mut req: Request, env: Env, _: Context) -> Result<Response> {
    let username = env.var("USERNAME").unwrap().to_string();
    let password = env.var("PASSWORD").unwrap().to_string();
    let protocol = env.var("PROTOCOL").unwrap().to_string();
    let bucket_name = env.var("BUCKET_NAME").unwrap().to_string();

    if let Some(r) = basic_authorization(
        req.headers().get("authorization").unwrap(),
        username,
        password,
    ) {
        return r;
    }

    let dav = dav::Dav::new(match protocol.as_str() {
        "r2" => R2::new(env.bucket(bucket_name.as_str()).unwrap()),
        _ => panic!("PROTOCOL {} not supported", protocol),
    });

    let mut response = match match req.inner().method().as_str() {
        "PROPFIND" => {
            let request_body = req.text().await?;
            console_debug!("request_body {:?}", request_body);
            dav.handle_propfind(req.path(), parse_depth(&req), request_body)
                .await
                .into()
        }
        "PROPPATCH" => {
            let request_body = req.text().await?;
            console_debug!("request_body {:?}", request_body);
            dav.handle_proppatch(req.path(), request_body).await.into()
        }
        "OPTIONS" => dav.handle_options().await.into(),
        "MKCOL" => dav.handle_mkcol(req.path(), req.text().await?).await.into(),
        "GET" => {
            if req.path().ends_with("/") {
                dav.handle_get_dir(req.path()).await.into()
            } else {
                dav.handle_get_obj(req.path(), parse_range(&req))
                    .await
                    .into()
            }
        }
        "HEAD" => {
            if req.path().ends_with("/") {
                dav.handle_head_dir(req.path()).await.into()
            } else {
                dav.handle_head_obj(req.path(), parse_range(&req))
                    .await
                    .into()
            }
        }
        "DELETE" => dav.handle_delete(req.path()).await.into(),
        "PUT" => dav
            .handle_put(
                req.path(),
                req.stream().unwrap(),
                req.headers()
                    .get("content-length")
                    .unwrap()
                    .map_or(0, |v| v.parse::<u64>().unwrap()),
            )
            .await
            .into(),
        "COPY" => dav
            .handle_copy(
                req.path(),
                parse_destination(&req),
                parse_depth(&req),
                parse_overwrite(&req),
            )
            .await
            .into(),
        "MOVE" => dav
            .handle_move(
                req.path(),
                parse_destination(&req),
                parse_depth(&req),
                parse_overwrite(&req),
            )
            .await
            .into(),
        _ => dav.handle_unsupport_method().await.into(),
    } {
        DavResponseType::DavResponse(r) => r.map_or_else(from_dav_err_response, from_dav_response),
        DavResponseType::DavStreamResponse(r) => {
            r.map_or_else(from_dav_err_response, from_dav_stream_response)
        }
    };

    let cors = Cors::new()
        .with_origins(
            req.headers()
                .get("origin")
                .unwrap()
                .map_or(vec![], |v| vec![v.to_string()]),
        )
        .with_methods(Method::all())
        .with_allowed_headers([
            "authorization",
            "content-type",
            "depth",
            "overwrite",
            "destination",
            "range",
        ])
        .with_exposed_headers([
            "content-length",
            "content-type",
            "etag",
            "last-modified",
            "range",
        ]);
    response = response.map(|response| response.with_cors(&cors).unwrap());
    response
}

fn basic_authorization(
    authorization_header: Option<String>,
    username: String,
    password: String,
) -> Option<Result<Response>> {
    let basic_authorization_error_response = || {
        Some(Response::error("Unauthorized", 401).map(|response| {
            let mut headers = Headers::new();
            headers
                .append("WWW-Authenticate", "Basic realm=\"webdav\"")
                .unwrap();
            response.with_headers(headers)
        }))
    };

    if let Some(text) = authorization_header {
        let a: Vec<&str> = text.split(" ").collect();
        if a.len() != 2 || a[0] != "Basic" {
            return basic_authorization_error_response();
        }
        if let Ok(v) = base64::decode(a[1]) {
            let v = match String::from_utf8(v) {
                Ok(v) => v,
                Err(_) => return basic_authorization_error_response(),
            };
            let v: Vec<&str> = v.split(":").collect();
            if v.len() != 2 {
                return basic_authorization_error_response();
            }
            if v[0] != username || v[1] != password {
                return basic_authorization_error_response();
            }

            return None;
        } else {
            return basic_authorization_error_response();
        }
    }

    return basic_authorization_error_response();
}

fn parse_depth(req: &Request) -> Depth {
    req.headers()
        .get("depth")
        .unwrap()
        .map_or("infinity".to_string(), |v| v)
        .into()
}

fn parse_range(req: &Request) -> values::Range {
    req.headers().get("range").unwrap().map_or(
        values::Range {
            start: None,
            end: None,
        },
        |v| values::Range::from(v.to_string().split("bytes=").next().unwrap().to_string()),
    )
}

fn parse_destination(req: &Request) -> String {
    req.headers()
        .get("destination")
        .unwrap()
        .map_or("".to_string(), |v| {
            v.split("http://")
                .nth(1)
                .unwrap()
                .split("/")
                .skip(1)
                .collect::<Vec<&str>>()
                .join("/")
        })
}

fn parse_overwrite(req: &Request) -> Overwrite {
    req.headers()
        .get("overwrite")
        .unwrap()
        .map_or("T".to_string(), |v| v.to_string())
        .into()
}

fn from_dav_err_response(response: DavErrResponse) -> Result<Response> {
    let (status_code, headers, body) = response;
    console_debug!("{} {:?} {:?}", status_code, headers, body);
    Response::error(body.unwrap_or("".to_string()), status_code).map(|response| {
        match headers {
            Some(headers) => response.with_headers(Headers::from_iter(headers)),
            None => response,
        }
        .with_status(status_code)
    })
}

fn from_dav_response(response: DavResponse) -> Result<Response> {
    let (status_code, headers, body) = response;
    console_debug!("{} {:?} {:?}", status_code, headers, body);
    Response::from_bytes(body.into_bytes()).map(|response| {
        response
            .with_headers(Headers::from_iter(headers))
            .with_status(status_code)
    })
}

fn from_dav_stream_response(response: DavStreamResponse) -> Result<Response> {
    let (status_code, headers, body) = response;
    console_debug!("{} {:?} {:?}", status_code, headers, body);
    Response::from_stream(body).map(|response| {
        response
            .with_headers(Headers::from_iter(headers))
            .with_status(status_code)
    })
}
