use crate::values::{DavProperties, Range};
use worker::{console_debug, Bucket, ByteStream, FixedLengthStream, Headers, Range as R2Range};

pub struct R2 {
    bucket: Bucket,
}

impl R2 {
    pub fn new(bucket: Bucket) -> R2 {
        R2 { bucket }
    }

    pub async fn get(&self, path: String) -> Result<(String, DavProperties), String> {
        match self.bucket.get(path).execute().await {
            Ok(f) => f.map_or(Err("Resource not found".to_string()), |file| {
                Ok((file.key(), DavProperties::from(&file)))
            }),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn list(&self, path: String) -> Result<Vec<(String, DavProperties)>, String> {
        match self.bucket.list().prefix(path).execute().await {
            Ok(files) => {
                let mut result = Vec::new();
                for file in files.objects() {
                    console_debug!("Access {}", file.key());
                    result.push((file.key(), DavProperties::from(&file)))
                }
                Ok(result)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn patch_metadata(&self, path: String, metadata: Headers) -> Result<(), String> {
        match self.bucket.get(path).execute().await {
            Ok(f) => f.map_or(Err("Resource not found".to_string()), |file| {
                match file.write_http_metadata(metadata) {
                    Ok(_) => Ok(()),
                    Err(error) => Err(error.to_string()),
                }
            }),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn download(
        &self,
        path: String,
        range: Range,
    ) -> Result<(DavProperties, ByteStream), String> {
        let r2range: Option<R2Range> = match (range.start, range.end) {
            (Some(start), Some(end)) => Some(R2Range::OffsetWithLength {
                offset: start,
                length: end - start + 1,
            }),
            (Some(start), None) => Some(R2Range::OffsetWithOptionalLength {
                offset: start,
                length: None,
            }),
            (None, Some(end)) => Some(R2Range::OptionalOffsetWithLength {
                offset: None,
                length: end,
            }),
            (None, None) => None,
        };
        let path_clone = path.clone();
        let result = r2range
            .map_or(self.bucket.get(path), |r| {
                self.bucket.get(path_clone).range(r)
            })
            .execute()
            .await;
        match result {
            Ok(f) => f.map_or(Err("Resource not found".to_string()), |file| {
                file.body()
                    .map_or(Err("Failed to get file body stream".to_string()), |b| {
                        b.stream().map_or(
                            Err("Failed to get file body stream".to_string()),
                            |stream| Ok((DavProperties::from(&file), stream)),
                        )
                    })
            }),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn delete(&self, path: String) -> Result<(), String> {
        match self.bucket.delete(path).await {
            Ok(_) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn put(
        &self,
        path: String,
        stream: ByteStream,
        content_length: u64,
    ) -> Result<DavProperties, String> {
        match self
            .bucket
            .put(path, FixedLengthStream::wrap(stream, content_length))
            .execute()
            .await
        {
            Ok(file) => Ok(DavProperties::from(&file)),
            Err(error) => Err(error.to_string()),
        }
    }
}
