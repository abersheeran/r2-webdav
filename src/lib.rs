use crate::values::Depth;
use base64;
use dav::DavResponseType;
use r2::R2;
use values::Overwrite;
use worker::*;

mod dav;
mod r2;
mod values;
mod xml;

#[event(fetch)]
async fn main(req: Request, env: Env, _: Context) -> Result<Response> {
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
    worker(req, dav).await
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

    match authorization_header {
        Some(text) => {
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
        None => {
            return basic_authorization_error_response();
        }
    }
}

async fn worker(mut req: Request, dav: dav::Dav) -> Result<Response> {
    let dav_response: DavResponseType = match req.inner().method().as_str() {
        "PROPFIND" => {
            let depth: Depth = req
                .headers()
                .get("depth")
                .unwrap()
                .map_or("infinity".to_string(), |v| v)
                .into();
            let resource_path = req.path();
            dav.handle_propfind(resource_path, depth, req.text().await?)
                .await
                .into()
        }
        "OPTIONS" => dav.handle_options().await.into(),
        "MKCOL" => {
            let resource_path = req.path();
            dav.handle_mkcol(resource_path, req.text().await?)
                .await
                .into()
        }
        "GET" => {
            let resource_path = req.path();
            let range = req.headers().get("range").unwrap().map_or(
                values::Range {
                    start: None,
                    end: None,
                },
                |v| values::Range::from(v.to_string().split("bytes=").next().unwrap().to_string()),
            );
            if resource_path.ends_with("/") {
                dav.handle_get_dir(resource_path).await.into()
            } else {
                dav.handle_get_obj(resource_path, range).await.into()
            }
        }
        "HEAD" => {
            let resource_path = req.path();
            let range = req.headers().get("range").unwrap().map_or(
                values::Range {
                    start: None,
                    end: None,
                },
                |v| values::Range::from(v.to_string().split("bytes=").next().unwrap().to_string()),
            );
            if resource_path.ends_with("/") {
                dav.handle_head_dir(resource_path).await.into()
            } else {
                dav.handle_head_obj(resource_path, range).await.into()
            }
        }
        "DELETE" => {
            let resource_path = req.path();
            dav.handle_delete(resource_path).await.into()
        }
        "PUT" => {
            let resource_path = req.path();
            let content_length = req
                .headers()
                .get("content-length")
                .unwrap()
                .map_or(0, |v| v.parse::<u64>().unwrap());
            println!("content-length: {}", content_length);
            dav.handle_put(resource_path, req.stream().unwrap(), content_length)
                .await
                .into()
        }
        "COPY" => {
            let resource_path = req.path();
            let destination =
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
                    });
            let depth: Depth = req
                .headers()
                .get("depth")
                .unwrap()
                .map_or("infinity".to_string(), |v| v)
                .into();
            let overwrite: Overwrite = req
                .headers()
                .get("overwrite")
                .unwrap()
                .map_or("T".to_string(), |v| v.to_string())
                .into();
            dav.handle_copy(resource_path, destination, depth, overwrite)
                .await
                .into()
        }
        "MOVE" => {
            let resource_path = req.path();
            let destination =
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
                    });
            let depth: Depth = req
                .headers()
                .get("depth")
                .unwrap()
                .map_or("infinity".to_string(), |v| v)
                .into();
            let overwrite: Overwrite = req
                .headers()
                .get("overwrite")
                .unwrap()
                .map_or("T".to_string(), |v| v.to_string())
                .into();
            dav.handle_move(resource_path, destination, depth, overwrite)
                .await
                .into()
        }
        _ => dav.handle_unsupport_method().await.into(),
    };

    match dav_response {
        DavResponseType::DavResponse(r) => r.map_or_else(
            |e| {
                let (status_code, headers, body) = e;
                Response::error(body.unwrap_or("".to_string()), status_code).map(|response| {
                    match headers {
                        Some(headers) => response.with_headers(Headers::from_iter(headers)),
                        None => response,
                    }
                    .with_status(status_code)
                })
            },
            |r| {
                let (status_code, headers, body) = r;
                Response::from_body(ResponseBody::Body(body.into_bytes())).map(|response| {
                    response
                        .with_headers(Headers::from_iter(headers))
                        .with_status(status_code)
                })
            },
        ),
        DavResponseType::DavStreamResponse(r) => r.map_or_else(
            |e| {
                let (status_code, headers, body) = e;
                Response::error(body.unwrap_or("".to_string()), status_code).map(|response| {
                    match headers {
                        Some(headers) => response.with_headers(Headers::from_iter(headers)),
                        None => response,
                    }
                    .with_status(status_code)
                })
            },
            |r| {
                let (status_code, headers, body) = r;
                Response::from_stream(body).map(|response| {
                    response
                        .with_headers(Headers::from_iter(headers))
                        .with_status(status_code)
                })
            },
        ),
    }
}
