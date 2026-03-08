# r2-webdav

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abersheeran/r2-webdav)

Use Cloudflare Workers to provide a WebDav interface for Cloudflare R2.

Currently the server advertises WebDAV Class 1 and Class 2 (LOCK/UNLOCK) support.

## Usage

Change wrangler.toml to your own.

```toml
[[r2_buckets]]
binding = 'bucket' # <~ valid JavaScript variable name, don't change this
bucket_name = 'webdav'
```

Then use wrangler to deploy.

```bash
wrangler deploy

wrangler secret put USERNAME
wrangler secret put PASSWORD
```

## Development

With `wrangler`, you can run and deploy your Worker with the following commands:

```sh
# run your Worker in an ideal development workflow (with a local server, file watcher & more)
$ npm run dev

# deploy your Worker globally to the Cloudflare network (update your wrangler.toml file for configuration)
$ npm run deploy
```

## Test

Use [litmus](https://github.com/notroj/litmus) to test.

GitHub Actions runs the `basic`, `copymove`, `props`, and `locks` litmus suites against `wrangler dev --local`.
The `http` suite is currently excluded because local Workers runs still time out on the interim `Expect: 100-continue` response check.
