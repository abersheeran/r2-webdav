# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

Use Cloudflare Workers to provide a WebDav interface for Cloudflare R2.

## Configuration

Change wrangler.toml to your own.

```toml
[[r2_buckets]]
binding = 'webdav' # <~ valid JavaScript variable name
bucket_name = 'webdav'

[vars]
PROTOCOL = "r2"
BUCKET_NAME = "webdav"
USERNAME = "USERNAME"
PASSWORD = "PASSWORD"
```

## Development

With `wrangler`, you can build, test, and deploy your Worker with the following commands:

```sh
# run your Worker in an ideal development workflow (with a local server, file watcher & more)
$ npm run dev

# deploy your Worker globally to the Cloudflare network (update your wrangler.toml file for configuration)
$ npm run deploy
```

Read the latest `worker` crate documentation here: https://docs.rs/worker
