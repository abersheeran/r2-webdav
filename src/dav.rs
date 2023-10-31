use worker::ByteStream;

use crate::r2::R2;
use crate::values::{Depth, Overwrite, Range};
use crate::xml::XMLNode;
use std::collections::HashMap;
use std::option::Option;

pub struct Dav {
    fs: R2,
}

pub type DavResponse = (u16, HashMap<String, String>, String);
pub type DavErrResponse = (u16, Option<HashMap<String, String>>, Option<String>);
pub type DavStreamResponse = (u16, HashMap<String, String>, ByteStream);

pub enum DavResponseType {
    DavResponse(Result<DavResponse, DavErrResponse>),
    DavStreamResponse(Result<DavStreamResponse, DavErrResponse>),
}

impl From<Result<DavResponse, DavErrResponse>> for DavResponseType {
    fn from(value: Result<DavResponse, DavErrResponse>) -> Self {
        DavResponseType::DavResponse(value)
    }
}

impl From<Result<DavStreamResponse, DavErrResponse>> for DavResponseType {
    fn from(value: Result<DavStreamResponse, DavErrResponse>) -> Self {
        DavResponseType::DavStreamResponse(value)
    }
}

static DAV_CLASS: &str = "1";
static SUPPORT_METHODS: [&str; 9] = [
    "OPTIONS",
    "PROPFIND",
    "PROPPATCH",
    "MKCOL",
    "GET",
    "HEAD",
    "PUT",
    "COPY",
    "MOVE",
];

impl Dav {
    pub fn new(fs: R2) -> Dav {
        Dav { fs }
    }

    pub async fn handle_unsupport_method(&self) -> Result<DavResponse, DavErrResponse> {
        let mut headers = HashMap::new();
        headers.insert("DAV".to_string(), DAV_CLASS.to_string());
        headers.insert("Allow".to_string(), SUPPORT_METHODS.join(", ").to_string());
        return Err((405, Some(headers), None));
    }

    pub async fn handle_options(&self) -> Result<DavResponse, DavErrResponse> {
        let mut headers = HashMap::new();
        headers.insert("DAV".to_string(), DAV_CLASS.to_string());
        headers.insert("Allow".to_string(), SUPPORT_METHODS.join(", ").to_string());
        return Ok((204, headers, "".to_string()));
    }

    pub async fn handle_propfind(
        &self,
        path: String,
        depth: Depth,
        req_body: String,
    ) -> Result<DavResponse, DavErrResponse> {
        let mut xml;
        if req_body.len() > 0 {
            match XMLNode::parse_xml(&req_body) {
                Ok(v) => xml = v,
                Err(_) => return Err((415, None, None)),
            };
        } else {
            return Err((415, None, None));
        }

        let mut headers = HashMap::new();
        headers.insert(
            "Content-Type".to_string(),
            "application/xml; charset=utf-8".to_string(),
        );

        match depth {
            Depth::One => {
                let mut multistatus = XMLNode::new(
                    "D:multistatus".to_string(),
                    Some(vec![("xmlns:D".to_string(), "DAV:".to_string())]),
                    None,
                );
                match self.fs.list(path.clone()).await {
                    Ok(items) => {
                        for (href, properties) in items {
                            let response = multistatus.elem("D:response".to_string(), None, None);
                            response.elem("D:href".to_string(), None, Some(href));
                            let propstat = response.elem("D:propstat".to_string(), None, None);
                            propstat.elem(
                                "D:status".to_string(),
                                None,
                                Some("HTTP/1.1 200 OK".to_string()),
                            );
                            let prop = propstat.elem("D:prop".to_string(), None, None);
                            properties
                                .creation_date
                                .map(|v| prop.elem("D:creationdate".to_string(), None, Some(v)));
                            properties
                                .display_name
                                .map(|v| prop.elem("D:displayname".to_string(), None, Some(v)));
                            properties.get_content_language.map(|v| {
                                prop.elem("D:getcontentlanguage".to_string(), None, Some(v))
                            });
                            properties.get_content_length.map(|v| {
                                prop.elem(
                                    "D:getcontentlength".to_string(),
                                    None,
                                    Some(v.to_string()),
                                )
                            });
                            properties
                                .get_content_type
                                .map(|v| prop.elem("D:getcontenttype".to_string(), None, Some(v)));
                            properties
                                .get_etag
                                .map(|v| prop.elem("D:getetag".to_string(), None, Some(v)));
                            properties.get_last_modified.map(|v| {
                                prop.elem(
                                    "D:getlastmodified".to_string(),
                                    None,
                                    Some(v.to_string()),
                                )
                            });
                        }

                        Ok((207, headers, multistatus.build()))
                    }
                    Err(message) => return Err((404, None, Some(message))),
                }
            }
            Depth::Zero => {
                let mut multistatus = XMLNode::new(
                    "D:multistatus".to_string(),
                    Some(vec![("xmlns:D".to_string(), "DAV:".to_string())]),
                    None,
                );
                match self.fs.get(path.clone()).await {
                    Ok((href, properties, _, custom_metadata)) => {
                        let response = multistatus.elem("D:response".to_string(), None, None);
                        response.elem("D:href".to_string(), None, Some(href));
                        let propstat = response.elem("D:propstat".to_string(), None, None);
                        propstat.elem(
                            "D:status".to_string(),
                            None,
                            Some("HTTP/1.1 200 OK".to_string()),
                        );
                        let prop = propstat.elem("D:prop".to_string(), None, None);
                        properties
                            .creation_date
                            .map(|v| prop.elem("D:creationdate".to_string(), None, Some(v)));
                        properties
                            .display_name
                            .map(|v| prop.elem("D:displayname".to_string(), None, Some(v)));
                        properties
                            .get_content_language
                            .map(|v| prop.elem("D:getcontentlanguage".to_string(), None, Some(v)));
                        properties.get_content_length.map(|v| {
                            prop.elem("D:getcontentlength".to_string(), None, Some(v.to_string()))
                        });
                        properties
                            .get_content_type
                            .map(|v| prop.elem("D:getcontenttype".to_string(), None, Some(v)));
                        properties
                            .get_etag
                            .map(|v| prop.elem("D:getetag".to_string(), None, Some(v)));
                        properties.get_last_modified.map(|v| {
                            prop.elem("D:getlastmodified".to_string(), None, Some(v.to_string()))
                        });

                        for (key, value) in custom_metadata {
                            prop.elem(key, None, Some(value));
                        }

                        Ok((207, (headers), (multistatus.build())))
                    }
                    Err(_) => {
                        if !path.ends_with("/") {
                            return Err((404, None, None));
                        }
                        let response = multistatus.elem("D:response".to_string(), None, None);
                        response.elem("D:href".to_string(), None, Some(path));
                        let propstat = response.elem("D:propstat".to_string(), None, None);
                        propstat.elem(
                            "D:status".to_string(),
                            None,
                            Some("HTTP/1.1 200 OK".to_string()),
                        );
                        propstat.elem("D:prop".to_string(), None, None);

                        Ok((207, (headers), (multistatus.build())))
                    }
                }
            }
            Depth::Infinity => return Err((400, None, None)),
        }
    }

    pub async fn handle_proppatch(
        &self,
        path: String,
        req_body: String,
    ) -> Result<DavResponse, DavErrResponse> {
        let mut headers = HashMap::new();
        headers.insert(
            "Content-Type".to_string(),
            "application/xml; charset=utf-8".to_string(),
        );
        let mut multistatus = XMLNode::new(
            "D:multistatus".to_string(),
            Some(vec![("xmlns:D".to_string(), "DAV:".to_string())]),
            None,
        );
        let response = multistatus.elem("D:response".to_string(), None, None);
        response.elem("D:href".to_string(), None, Some(path));
        let propstat = response.elem("D:propstat".to_string(), None, None);
        let prop = propstat.elem("D:prop".to_string(), None, None);
        // TODO
        propstat.elem(
            "D:status".to_string(),
            None,
            Some("HTTP/1.1 200 OK".to_string()),
        );
        Ok((207, HashMap::new(), multistatus.build()))
    }

    pub async fn handle_mkcol(
        &self,
        _: String,
        req_body: String,
    ) -> Result<DavResponse, DavErrResponse> {
        if req_body.len() > 0 {
            return Err((415, None, None));
        }
        Ok((201, HashMap::new(), "".to_string()))
        // R2 unsupport create empty directory
        // Err((403, None, None))
    }

    pub async fn handle_get_obj(
        &self,
        path: String,
        range: Range,
    ) -> Result<DavStreamResponse, DavErrResponse> {
        match self.fs.download(path, range.clone()).await {
            Ok((properties, response_headers, stream)) => {
                let mut headers: HashMap<String, String> = HashMap::new();
                headers.insert("Accept-Ranges".to_string(), "bytes".to_string());
                headers.insert(
                    "Content-Type".to_string(),
                    properties
                        .get_content_type
                        .map_or("application/octet-stream".to_string(), |v| v),
                );
                headers.insert(
                    "Content-Length".to_string(),
                    properties
                        .get_content_length
                        .map_or("0".to_string(), |v| v.to_string()),
                );
                properties
                    .get_etag
                    .map(|v| headers.insert("ETag".to_string(), v));
                properties
                    .get_last_modified
                    .map(|v| headers.insert("Last-Modified".to_string(), v));
                response_headers
                    .cache_control
                    .map(|v| headers.insert("Cache-Control".to_string(), v));
                response_headers
                    .cache_expiry
                    .map(|v| headers.insert("Expires".to_string(), v.to_string()));
                response_headers
                    .content_disposition
                    .map(|v| headers.insert("Content-Disposition".to_string(), v));
                response_headers
                    .content_encoding
                    .map(|v| headers.insert("Content-Encoding".to_string(), v));
                match (range.start, range.end) {
                    (Some(start), Some(end)) => {
                        headers.insert(
                            "Content-Range".to_string(),
                            format!("bytes {}-{}/{}", start, end, end - start + 1),
                        );
                        Ok((206, (headers), stream))
                    }
                    _ => Ok((200, (headers), stream)),
                }
            }
            Err(message) => return Err((404, None, Some(message))),
        }
    }

    pub async fn handle_get_dir(&self, path: String) -> Result<DavResponse, DavErrResponse> {
        match self.fs.list(path).await {
            Ok(items) => {
                let mut headers = HashMap::new();
                headers.insert(
                    "Content-Type".to_string(),
                    "application/html; charset=utf-8".to_string(),
                );
                let html = items
                    .iter()
                    .map(|item| {
                        format!(
                            "<a href=\"{}\">{}</a>",
                            &item.0,
                            match &item.1.display_name {
                                Some(display_name) => display_name,
                                None => &item.0,
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                return Ok((200, (headers), (html)));
            }
            Err(message) => {
                return Err((404, None, Some(message)));
            }
        }
    }

    pub async fn handle_head_obj(
        &self,
        path: String,
        range: Range,
    ) -> Result<DavResponse, DavErrResponse> {
        match self.handle_get_obj(path, range).await {
            Ok((status_code, headers, _)) => Ok((status_code, headers, "".to_string())),
            Err(e) => Err(e),
        }
    }

    pub async fn handle_head_dir(&self, path: String) -> Result<DavResponse, DavErrResponse> {
        match self.handle_get_dir(path).await {
            Ok((status_code, headers, _)) => Ok((status_code, headers, "".to_string())),
            Err(e) => Err(e),
        }
    }

    pub async fn handle_delete(&self, path: String) -> Result<DavResponse, DavErrResponse> {
        match self.fs.delete(path).await {
            Ok(()) => Ok((204, HashMap::new(), "".to_string())),
            Err(error) => Err((400, None, Some(error.to_string()))),
        }
    }

    pub async fn handle_put(
        &self,
        path: String,
        stream: ByteStream,
        content_length: u64,
    ) -> Result<DavResponse, DavErrResponse> {
        if path.ends_with("/") {
            return Err((405, None, None));
        }
        match self.fs.put(path, stream, content_length).await {
            Ok(properties) => {
                println!("{:?}", properties);
                Ok((201, HashMap::new(), "".to_string()))
            }
            Err(error) => Err((400, None, Some(error.to_string()))),
        }
    }

    pub async fn handle_copy(
        &self,
        path: String,
        destination: String,
        depth: Depth,
        overwrite: Overwrite,
    ) -> Result<DavResponse, DavErrResponse> {
        if path.ends_with("/") {
            match depth {
                Depth::Zero => Err((400, None, Some("Unsupported copy collection".to_string()))),
                Depth::Infinity => Ok((200, HashMap::new(), "".to_string())),
                _ => Err((400, None, Some("Unsupported copy depth".to_string()))),
            }
        } else {
            Err((400, None, Some("Unsupported copy resource".to_string())))
        }
    }

    pub async fn handle_move(
        &self,
        path: String,
        destination: String,
        depth: Depth,
        overwrite: Overwrite,
    ) -> Result<DavResponse, DavErrResponse> {
        if path.ends_with("/") {
            match depth {
                Depth::Zero => Err((400, None, Some("Unsupported move collection".to_string()))),
                Depth::Infinity => Ok((200, HashMap::new(), "".to_string())),
                _ => Err((400, None, Some("Unsupported move depth".to_string()))),
            }
        } else {
            Err((400, None, Some("Unsupported move resource".to_string())))
        }
    }
}
