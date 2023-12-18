/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
	// Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
	// MY_KV_NAMESPACE: KVNamespace;
	//
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	// MY_DURABLE_OBJECT: DurableObjectNamespace;
	//
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;
	//
	// Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
	// MY_SERVICE: Fetcher;
	//
	// Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
	// MY_QUEUE: Queue;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
}

const DAV_CLASS = "1";
const SUPPORT_METHODS = [
	"OPTIONS",
	"PROPFIND",
	"MKCOL",
	"GET",
	"HEAD",
	"PUT",
	"COPY",
	"MOVE",
];

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
}

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: undefined,
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: undefined,
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: undefined,
			resourcetype: '',
		};
	}

	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
	};
}


function make_resource_path(request: Request): string {
	return new URL(request.url).pathname.slice(1)
}

async function handle_options(request: Request, bucket: R2Bucket): Promise<Response> {
	return new Response(null, {
		status: 204,
		headers: {
			'DAV': DAV_CLASS,
			'Allow': SUPPORT_METHODS.join(', '),
		}
	});
}

async function handle_head(request: Request, bucket: R2Bucket): Promise<Response> {
	let response = await handle_get(request, bucket);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

async function handle_get(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (request.url.endsWith('/')) {
		let r2_objects = await bucket.list({
			prefix: resource_path,
			delimiter: '/',
			include: ['httpMetadata', 'customMetadata'],
		});
		let page = '';
		if (resource_path !== '') page += `<a href="../">..</a><br>`;
		for (let object of r2_objects.objects.filter(object => object.key !== resource_path)) {
			let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
			page += `<a href="${href}">${object.httpMetadata?.contentDisposition ?? object.key}</a><br>`;
		}
		return new Response(page, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	} else {
		let object = await bucket.get(resource_path, {
			onlyIf: request.headers,
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		}

		if (object === null) {
			return new Response('Not Found', { status: 404 });
		} else if (!isR2ObjectBody(object)) {
			return new Response("Precondition Failed", { status: 412 });
		} else {
			return new Response(object.body, {
				status: object.range ? 206 : 200,
				headers: {
					'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
					// TODO: Content-Length, Content-Range

					...(object.httpMetadata?.contentDisposition ? {
						'Content-Disposition': object.httpMetadata.contentDisposition,
					} : {}),
					...(object.httpMetadata?.contentEncoding ? {
						'Content-Encoding': object.httpMetadata.contentEncoding,
					} : {}),
					...(object.httpMetadata?.contentLanguage ? {
						'Content-Language': object.httpMetadata.contentLanguage,
					} : {}),
					...(object.httpMetadata?.cacheControl ? {
						'Cache-Control': object.httpMetadata.cacheControl,
					} : {}),
					...(object.httpMetadata?.cacheExpiry ? {
						'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
					} : {}),
				}
			});
		}
	}
}

async function handle_put(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (resource_path.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let dirpath = resource_path.split('/').slice(0, -1).join('/');
	if (dirpath !== '') {
		let dir = await bucket.head(dirpath);
		if (!(dir && dir.customMetadata?.resourcetype === '<collection />')) {
			return new Response('Conflict', { status: 409 });
		}
	}

	let body = await request.arrayBuffer();
	await bucket.put(resource_path, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
	});
	return new Response('', { status: 201 });
}

async function handle_delete(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (!resource_path.endsWith('/')) {
		let resource = await bucket.head(resource_path);
		if (resource === null) {
			return new Response('Not Found', { status: 404 });
		} else {
			if (resource.customMetadata?.resourcetype !== '<collection />') {
				await bucket.delete(resource_path);
				return new Response(null, { status: 204 });
			}
		}
	}

	let dirpath = resource_path.slice(0, -1);
	if (await bucket.head(dirpath) === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.delete(dirpath);

	let r2_objects, cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: resource_path,
			cursor: cursor,
		});
		let keys = r2_objects.objects.map(object => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);

	return new Response(null, { status: 204 });
}

async function handle_mkcol(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (request.body) {
		return new Response('Unsupported Media Type', { status: 415 });
	}

	resource_path = resource_path.endsWith('/') ? resource_path.slice(0, -1) : resource_path;

	// Check if the resource already exists
	if (await bucket.head(resource_path)) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parent_dir = resource_path.split('/').slice(0, -1).join("/");

	if (parent_dir !== '' && !await bucket.head(parent_dir)) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resource_path, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' }
	});
	return new Response('', { status: 201 });
}

async function handle_propfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let depth = request.headers.get('Depth') ?? 'infinity';
	switch (depth) {
		case '0': {
			if (resource_path === "") {
				return new Response(`<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
	<response>
		<href>/</href>
		<propstat>
			<prop>
				<resourcetype><collection /></resourcetype>
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>
</multistatus>
							`, {
					status: 207,
					headers: {
						'Content-Type': 'text/xml',
					},
				});
			}

			let object = await bucket.head(resource_path);
			if (object === null && resource_path.endsWith('/')) {
				object = await bucket.head(resource_path.slice(0, -1));
			}

			if (object === null) {
				return new Response('Not Found', { status: 404 });
			}

			let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
	<response>
		<href>/${resource_path}</href>
		<propstat>
			<prop>
				${Object.entries(fromR2Object(object))
					.filter(([_, value]) => value !== undefined)
					.map(([key, value]) => `<${key}>${value}</${key}>`)
					.join('\n')
				}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>
</multistatus>
`;
			return new Response(page, {
				status: 207,
				headers: {
					'Content-Type': 'text/xml',
				},
			});
		}
		case '1': {
			if (resource_path !== "") {
				let object = await bucket.head(resource_path);
				if (object === null && resource_path.endsWith('/')) {
					object = await bucket.head(resource_path.slice(0, -1));
				}

				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}

				if (object.customMetadata?.resourcetype !== '<collection />') {
					let page = `<?xml version="1.0" encoding="utf-8"?>
	<multistatus xmlns="DAV:">
		<response>
			<href>/${resource_path}</href>
			<propstat>
				<prop>
					${Object.entries(fromR2Object(object))
							.filter(([_, value]) => value !== undefined)
							.map(([key, value]) => `<${key}>${value}</${key}>`)
							.join('\n				')
						}
				</prop>
				<status>HTTP/1.1 200 OK</status>
			</propstat>
		</response>
	</multistatus>
	`;
					return new Response(page, {
						status: 207,
						headers: {
							'Content-Type': 'text/xml',
						},
					});
				}
			}

			let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

			let cursor: string | undefined = undefined;
			do {
				var r2_objects = await bucket.list({
					prefix: resource_path.endsWith('/') || resource_path === "" ? resource_path : resource_path + '/',
					delimiter: '/',
					cursor: cursor,
					include: ['httpMetadata', 'customMetadata'],
				});

				for (let object of r2_objects.objects.filter(object => object.key !== resource_path)) {
					let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
					page += `
	<response>
		<href>${href}</href>
		<propstat>
			<prop>
				${Object.entries(fromR2Object(object))
							.filter(([_, value]) => value !== undefined)
							.map(([key, value]) => `<${key}>${value}</${key}>`)
							.join('\n				')
						}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
				}

				if (r2_objects.truncated) {
					cursor = r2_objects.cursor;
				}
			} while (r2_objects.truncated)
			page += '\n</multistatus>\n';
			return new Response(page, {
				status: 207,
				headers: {
					'Content-Type': 'text/xml',
				},
			});
		}
		case 'infinity': {
			if (resource_path !== "") {
				let object = await bucket.head(resource_path);
				if (object === null && resource_path.endsWith('/')) {
					object = await bucket.head(resource_path.slice(0, -1));
				}

				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}

				if (object.customMetadata?.resourcetype !== '<collection />') {
					let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
	<response>
		<href>/${resource_path}</href>
		<propstat>
			<prop>
				${Object.entries(fromR2Object(object))
							.filter(([_, value]) => value !== undefined)
							.map(([key, value]) => `<${key}>${value}</${key}>`)
							.join('\n				')
						}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>
</multistatus>
`;
					return new Response(page, {
						status: 207,
						headers: {
							'Content-Type': 'text/xml',
						},
					});
				}
			}

			let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

			let cursor: string | undefined = undefined;
			do {
				var r2_objects = await bucket.list({
					prefix: resource_path.endsWith('/') || resource_path === "" ? resource_path : resource_path + '/',
					cursor: cursor,
					include: ['httpMetadata', 'customMetadata'],
				});

				for (let object of r2_objects.objects.filter(object => object.key !== resource_path)) {
					let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
					page += `
	<response>
		<href>${href}</href>
		<propstat>
			<prop>
				${Object.entries(fromR2Object(object))
							.filter(([_, value]) => value !== undefined)
							.map(([key, value]) => `<${key}>${value}</${key}>`)
							.join('\n				')
						}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
				}

				if (r2_objects.truncated) {
					cursor = r2_objects.cursor;
				}
			} while (r2_objects.truncated);
			page += '\n</multistatus>\n';
			return new Response(page, {
				status: 207,
				headers: {
					'Content-Type': 'text/xml',
				},
			});
		}
		default: {
			return new Response('Forbidden', { status: 403 });
		}
	}
}

async function handle_copy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = new URL(destination_header).pathname.slice(1);

	// Check if the parent directory exists
	let destination_parent = destination.split('/').slice(0, destination.endsWith('/') ? -2 : -1).join('/');
	if (destination_parent !== '' && !await bucket.head(destination_parent)) {
		return new Response('Conflict', { status: 409 });
	}

	if (resource_path.endsWith('/')) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let r2_objects = await bucket.list({
					prefix: resource_path,
				});
				if (r2_objects.objects.length === 0) {
					return new Response('Not Found', { status: 404 });
				}
				await Promise.all(r2_objects.objects.map(
					object => (async () => {
						let target = destination + object.key.slice(resource_path.length);
						let src = await bucket.get(object.key);
						if (src !== null) {
							await bucket.put(target, src.body, {
								httpMetadata: object.httpMetadata,
								customMetadata: object.customMetadata,
							});
						}
					})()
				));
				return new Response('', { status: 201 });
			}
			case '0': {
				let object = await bucket.get(resource_path.slice(0, -1));
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				return new Response('', { status: 201 });
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let destination_exists = await bucket.head(destination);
		if (dont_overwrite && destination_exists) {
			return new Response('Precondition Failed', { status: 412 });
		}

		let src = await bucket.get(resource_path);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return new Response('', { status: 201 });
		}
	}
}

async function handle_move(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let overwrite = request.headers.get('Overwrite') === 'T';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = new URL(destination_header).pathname.slice(1);
	let destination_exists = await bucket.head(destination);
	if (destination_exists && !overwrite) {
		return new Response('Precondition Failed', { status: 412 });
	}

	// TODO delete recursively (if destination is a directory)
	// await bucket.delete(
	// 	(await bucket.list({ prefix: destination, delimiter: '/' })).objects.map(object => object.key)
	// );

	if (resource_path.endsWith('/')) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let r2_objects, cursor: string | undefined = undefined;
				do {
					r2_objects = await bucket.list({
						prefix: resource_path,
						cursor: cursor,
						include: ['httpMetadata', 'customMetadata'],
					});
					await Promise.all(r2_objects.objects.map(
						object => (async () => {
							let target = destination + object.key.slice(resource_path.length);
							let src = await bucket.get(object.key);
							if (src !== null) {
								await bucket.put(target, src.body, {
									httpMetadata: object.httpMetadata,
									customMetadata: object.customMetadata,
								});
								await bucket.delete(object.key);
							}
						})()
					));
					if (r2_objects.truncated) {
						cursor = r2_objects.cursor;
					}
				} while (r2_objects.truncated)
				return new Response('', { status: 201 });
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource_path);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return new Response('', { status: 201 });
		}
	}
}

async function dispatch_handler(request: Request, bucket: R2Bucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return await handle_options(request, bucket);
		}
		case 'HEAD': {
			return await handle_head(request, bucket);
		}
		case 'GET': {
			return await handle_get(request, bucket);
		}
		case 'PUT': {
			return await handle_put(request, bucket);
		}
		case 'DELETE': {
			return await handle_delete(request, bucket);
		}
		case 'MKCOL': {
			return await handle_mkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handle_propfind(request, bucket);
		}
		case 'COPY': {
			return await handle_copy(request, bucket);
		}
		case 'MOVE': {
			return await handle_move(request, bucket);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					'Allow': SUPPORT_METHODS.join(', '),
					'DAV': DAV_CLASS,
				}
			});
		}
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		if (request.headers.get('Authorization') !== `Basic ${btoa(`${env.USERNAME}:${env.PASSWORD}`)}`) {
			return new Response('Unauthorized', {
				status: 401, headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				}
			});
		}

		let response: Response = await dispatch_handler(request, bucket);

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set('Access-Control-Allow-Headers',
			["authorization", "content-type", "depth", "overwrite", "destination", "range"].join(', ')
		);
		response.headers.set('Access-Control-Expose-Headers',
			["content-type", "content-length", "dav", "etag", "last-modified", "location", "date", "content-range"].join(', ')
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response
	},
};
