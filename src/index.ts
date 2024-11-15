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
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
}

async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
			yield object;
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
};

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: new Date().toUTCString(),
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: new Date().toUTCString(),
			resourcetype: '<collection />',
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
	let path = new URL(request.url).pathname.slice(1);
	path = path.endsWith('/') ? path.slice(0, -1) : path;
	return path;
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
		let page = '',
			prefix = resource_path;
		if (resource_path !== '') {
			page += `<a href="../">..</a><br>`;
			prefix = `${resource_path}/`;
		}

		for await (const object of listAll(bucket, prefix)) {
			if (object.key === resource_path) {
				continue;
			}
			let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
			page += `<a href="${href}">${object.httpMetadata?.contentDisposition ?? object.key.slice(prefix.length)}</a><br>`;
		}
		// 定义模板
		var pageSource = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>R2Storage</title><style>*{box-sizing:border-box;}body{padding:10px;font-family:'Segoe UI','Circular','Roboto','Lato','Helvetica Neue','Arial Rounded MT Bold','sans-serif';}a{display:inline-block;width:100%;color:#000;text-decoration:none;padding:5px 10px;cursor:pointer;border-radius:5px;}a:hover{background-color:#60C590;color:white;}a[href="../"]{background-color:#cbd5e1;}</style></head><body><h1>R2 Storage</h1><div>${page}</div></body></html>`;

		return new Response(pageSource, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	} else {
		let object = await bucket.get(resource_path, {
			onlyIf: request.headers,
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			return new Response('Not Found', { status: 404 });
		} else if (!isR2ObjectBody(object)) {
			return new Response('Precondition Failed', { status: 412 });
		} else {
			const { rangeOffset, rangeEnd } = calcContentRange(object);
			const contentLength = rangeEnd - rangeOffset + 1;
			return new Response(object.body, {
				status: object.range && contentLength !== object.size ? 206 : 200,
				headers: {
					'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
					'Content-Length': contentLength.toString(),
					...{ 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` },
					...(object.httpMetadata?.contentDisposition
						? {
							'Content-Disposition': object.httpMetadata.contentDisposition,
						}
						: {}),
					...(object.httpMetadata?.contentEncoding
						? {
							'Content-Encoding': object.httpMetadata.contentEncoding,
						}
						: {}),
					...(object.httpMetadata?.contentLanguage
						? {
							'Content-Language': object.httpMetadata.contentLanguage,
						}
						: {}),
					...(object.httpMetadata?.cacheControl
						? {
							'Cache-Control': object.httpMetadata.cacheControl,
						}
						: {}),
					...(object.httpMetadata?.cacheExpiry
						? {
							'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
						}
						: {}),
				},
			});
		}
	}
}

function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Case 3: {suffix: number}
			rangeOffset = object.size - object.range.suffix;
		} else {
			// Case 1: {offset: number, length?: number}
			// Case 2: {offset?: number, length: number}
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

async function handle_put(request: Request, bucket: R2Bucket): Promise<Response> {
	if (request.url.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resource_path = make_resource_path(request);

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

	if (resource_path === '') {
		let r2_objects,
			cursor: string | undefined = undefined;
		do {
			r2_objects = await bucket.list({ cursor: cursor });
			let keys = r2_objects.objects.map((object) => object.key);
			if (keys.length > 0) {
				await bucket.delete(keys);
			}

			if (r2_objects.truncated) {
				cursor = r2_objects.cursor;
			}
		} while (r2_objects.truncated);

		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	await bucket.delete(resource_path);
	if (resource.customMetadata?.resourcetype !== '<collection />') {
		return new Response(null, { status: 204 });
	}

	let r2_objects,
		cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: resource_path + '/',
			cursor: cursor,
		});
		let keys = r2_objects.objects.map((object) => object.key);
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
	// Stupid Windows Explorer carries the body, we have to support it.
	// So dont check for request.body.
	// if (request.body) {
	// 	return new Response('Unsupported Media Type', { status: 415 });
	// }

	let resource_path = make_resource_path(request);

	// Check if the resource already exists
	let resource = await bucket.head(resource_path);
	if (resource !== null) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parent_dir = resource_path.split('/').slice(0, -1).join('/');

	if (parent_dir !== '' && !(await bucket.head(parent_dir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resource_path, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

function generate_propfind_response(object: R2Object | null): string {
	if (object === null) {
		return `
	<response>
		<href>/</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(null))
				.filter(([_, value]) => value !== undefined)
				.map(([key, value]) => `<${key}>${value}</${key}>`)
				.join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
	}

	let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
	return `
	<response>
		<href>${href}</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(object))
			.filter(([_, value]) => value !== undefined)
			.map(([key, value]) => `<${key}>${value}</${key}>`)
			.join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
}

async function handle_propfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	let is_collection: boolean;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response(null);
		is_collection = true;
	} else {
		let object = await bucket.head(resource_path);
		if (object === null) {
			return new Response('Not Found', { status: 404 });
		}
		is_collection = object.customMetadata?.resourcetype === '<collection />';
		page += generate_propfind_response(object);
	}

	if (is_collection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix)) {
						page += generate_propfind_response(object);
					}
				}
				break;
			case 'infinity':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix, true)) {
						page += generate_propfind_response(object);
					}
				}
				break;
			default: {
				return new Response('Forbidden', { status: 403 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'text/xml',
		},
	});
}

async function handle_proppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);

	// 检查资源是否存在
	let object = await bucket.head(resource_path);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	// 读取请求体
	const body = await request.text();

	// 使用 HTMLRewriter 解析 XML
	const setProperties: { [key: string]: string } = {};
	const removeProperties: string[] = [];
	let currentAction: 'set' | 'remove' | null = null;
	let currentPropName: string | null = null;
	let currentPropValue: string = '';

	class PropHandler {
		element(element: Element) {
			const tagName = element.tagName.toLowerCase();
			if (tagName === 'set') {
				currentAction = 'set';
			} else if (tagName === 'remove') {
				currentAction = 'remove';
			} else if (tagName === 'prop') {
				// 忽略 <prop> 标签
			} else {
				// 属性名称
				currentPropName = tagName;
				currentPropValue = '';
			}
		}

		text(textChunk: Text) {
			if (currentPropName) {
				currentPropValue += textChunk.text;
			}
		}

		end(element: Element) {
			if (currentAction === 'set' && currentPropName) {
				setProperties[currentPropName] = currentPropValue.trim();
			} else if (currentAction === 'remove' && currentPropName) {
				removeProperties.push(currentPropName);
			}
			currentPropName = null;
			currentPropValue = '';
		}
	}

	// 使用 HTMLRewriter 解析请求体
	await new HTMLRewriter().on('propertyupdate', new PropHandler()).transform(new Response(body)).arrayBuffer();

	// 复制原有的自定义元数据
	const customMetadata = object.customMetadata ? { ...object.customMetadata } : {};

	// 更新元数据
	for (const propName in setProperties) {
		customMetadata[propName] = setProperties[propName];
	}

	for (const propName of removeProperties) {
		delete customMetadata[propName];
	}

	// 更新对象的元数据
	const src = await bucket.get(object.key);
	if (src === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(object.key, src.body, {
		httpMetadata: object.httpMetadata,
		customMetadata: customMetadata,
	});

	// 构造响应
	let responseXML = '<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n';

	for (const propName in setProperties) {
		responseXML += `
    <response>
        <href>/${object.key}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
	}

	for (const propName of removeProperties) {
		responseXML += `
    <response>
        <href>/${object.key}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
	}

	responseXML += '</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset="utf-8"',
		},
	});
}

async function handle_copy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = new URL(destination_header).pathname.slice(1);
	destination = destination.endsWith('/') ? destination.slice(0, -1) : destination;

	// Check if the parent directory exists
	let destination_parent = destination
		.split('/')
		.slice(0, destination.endsWith('/') ? -2 : -1)
		.join('/');
	if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const copy = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: object.customMetadata,
						});
					}
				};
				let promise_array = [copy(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(copy(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
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
	destination = destination.endsWith('/') ? destination.slice(0, -1) : destination;

	// Check if the parent directory exists
	let destination_parent = destination
		.split('/')
		.slice(0, destination.endsWith('/') ? -2 : -1)
		.join('/');
	if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.key === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	if (destination_exists) {
		// Delete the destination first
		await handle_delete(new Request(new URL(destination_header), request), bucket);
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const move = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: object.customMetadata,
						});
						await bucket.delete(object.key);
					}
				};
				let promise_array = [move(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(move(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: object.customMetadata,
				});
				await bucket.delete(resource.key);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return new Response('', { status: 201 });
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: src.customMetadata,
		});
		await bucket.delete(resource.key);
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return new Response('', { status: 201 });
		}
	}
}

const DAV_CLASS = '1, 3';
const SUPPORT_METHODS = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'DELETE', 'COPY', 'MOVE'];

async function dispatch_handler(request: Request, bucket: R2Bucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 204,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
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
		case 'PROPPATCH': {
			return await handle_proppatch(request, bucket);
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
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
	}
}

function is_authorized(authorization_header: string, username: string, password: string): boolean {
    const encoder = new TextEncoder();

    const header = encoder.encode(authorization_header);
    const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

    return header.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(header, expected);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		if (
			request.method !== 'OPTIONS' &&
			!is_authorized(request.headers.get('Authorization') ?? '', env.USERNAME, env.PASSWORD)
		) {
			return new Response('Unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				},
			});
		}

		let response: Response = await dispatch_handler(request, bucket);

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			['authorization', 'content-type', 'depth', 'overwrite', 'destination', 'range'].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			['content-type', 'content-length', 'dav', 'etag', 'last-modified', 'location', 'date', 'content-range'].join(
				', ',
			),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response;
	},
};
