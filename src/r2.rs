use crate::values::{DavProperties, Range};
use worker::{Bucket, ByteStream, FixedLengthStream, Range as R2Range};

pub struct R2 {
    bucket: Bucket,
}

impl R2 {
    pub fn new(bucket: Bucket) -> R2 {
        R2 { bucket }
    }

    pub async fn get(&self, path: String) -> Result<(String, DavProperties), String> {
        let result = self.bucket.get(path).execute().await;
        match result {
            Ok(f) => f.map_or(Err("Resource not found".to_string()), |file| {
                Ok((file.key(), DavProperties::from_r2(&file)))
            }),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn list(&self, path: String) -> Result<Vec<(String, DavProperties)>, String> {
        match self.bucket.list().prefix(path).execute().await {
            Ok(files) => {
                let mut result = Vec::new();
                for file in files.objects() {
                    result.push((file.key(), DavProperties::from_r2(&file)))
                }
                Ok(result)
            }
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
                            |stream| Ok((DavProperties::from_r2(&file), stream)),
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
            Ok(file) => Ok(DavProperties::from_r2(&file)),
            Err(error) => Err(error.to_string()),
        }
    }
}
