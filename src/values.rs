use worker::{console_debug, Object};

#[derive(Default, Debug, Clone, PartialEq, Hash, Eq)]
pub enum Depth {
    Zero,
    One,
    #[default]
    Infinity,
}

impl From<String> for Depth {
    fn from(m: String) -> Self {
        match m.to_ascii_uppercase().as_str() {
            "0" => Depth::Zero,
            "1" => Depth::One,
            "infinity" => Depth::Infinity,
            _ => Depth::Infinity,
        }
    }
}

#[derive(Default, Debug, Clone, PartialEq, Hash, Eq)]
pub struct Range {
    pub start: Option<u32>,
    pub end: Option<u32>,
}

impl From<Option<String>> for Range {
    fn from(line: Option<String>) -> Self {
        match line {
            None => Range {
                start: None,
                end: None,
            },
            Some(line) => Range::from(line),
        }
    }
}

impl From<String> for Range {
    fn from(line: String) -> Self {
        if line.contains(";") {
            return Range {
                start: None,
                end: None,
            };
        }

        line.split("-")
            .map(|v| v.parse::<u32>())
            .collect::<Result<Vec<u32>, _>>()
            .map_or(Range::from(None), |v| match v.len() {
                2 => Range {
                    start: Some(v[0]),
                    end: Some(v[1]),
                },
                _ => Range {
                    start: None,
                    end: None,
                },
            })
    }
}

#[derive(Default, Debug, Clone, PartialEq, Hash, Eq)]
pub enum Overwrite {
    #[default]
    True,
    False,
}

impl From<String> for Overwrite {
    fn from(value: String) -> Self {
        match value.as_str() {
            "F" => Overwrite::False,
            "T" => Overwrite::True,
            _ => Overwrite::True,
        }
    }
}

#[derive(Default, Debug, Clone, PartialEq, Hash, Eq)]
pub struct DavProperties {
    pub creation_date: Option<String>,
    pub display_name: Option<String>,
    pub get_content_language: Option<String>,
    pub get_content_length: Option<u64>,
    pub get_content_type: Option<String>,
    pub get_etag: Option<String>,
    pub get_last_modified: Option<String>,
}

impl From<&Object> for DavProperties {
    fn from(file: &Object) -> DavProperties {
        console_debug!("Calling from Object for DavProperties");
        let http_metedata = file.http_metadata();
        console_debug!("http_metedata {:?}", http_metedata);
        DavProperties {
            creation_date: Some(file.uploaded().to_string()),
            display_name: http_metedata.content_disposition,
            get_content_language: http_metedata.content_language,
            get_content_length: Some(file.size().into()),
            get_content_type: http_metedata.content_type,
            get_etag: Some(file.http_etag()),
            get_last_modified: None,
        }
    }
}
