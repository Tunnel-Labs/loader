// @ts-check

import fs from 'node:fs';
import path from 'pathe';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	installSourceMapSupport,
	resolveTsPath,
	transform,
	transformDynamicImport
} from './utils/core-utils.cjs';
import {
	getGlobfileContents,
	getGlobfilePath,
	isGlobSpecifier
	// @ts-expect-error: bad typings
} from 'glob-imports';
// @ts-expect-error: bad typings
import { createTildeImportExpander } from 'tilde-imports';
import {
	createFilesMatcher,
	createPathsMatcher,
	getTsconfig,
	parseTsconfig
} from 'get-tsconfig';
import { resolve as resolveExports } from 'resolve.exports';

import pathsData from './utils/paths.cjs';

const { packageSlugToCategory, monorepoDirpath } = pathsData;
const expandTildeImport = createTildeImportExpander({
	monorepoDirpath
});

const packageJsonCache = new Map();
/** @param {string} filepath */
async function readPackageJson(filepath) {
	if (packageJsonCache.has(filepath)) {
		return packageJsonCache.get(filepath);
	}

	const exists = await fs.promises.access(filepath).then(
		() => true,
		() => false
	);

	if (!exists) {
		packageJsonCache.set(filepath, undefined);
		return;
	}

	const packageJsonString = await fs.promises.readFile(filepath, 'utf8');
	try {
		const packageJson = JSON.parse(packageJsonString);
		packageJsonCache.set(filepath, packageJson);
		return packageJson;
	} catch {
		throw new Error(`Error parsing: ${filepath}`);
	}
}

/**
	From Node.js
	@see https://github.com/nodejs/node/blob/e86a6383054623e5168384a83d8cd6ebfe1fb584/lib/internal/modules/esm/resolve.js#L229
	@param {string} filepath
*/
async function findPackageJson(filepath) {
	let packageJsonUrl = new URL('package.json', filepath);

	for (;;) {
		// Don't look outside of /node_modules/
		if (packageJsonUrl.pathname.endsWith('/node_modules/package.json')) {
			break;
		}

		const packageJsonPath = fileURLToPath(packageJsonUrl);
		// eslint-disable-next-line no-await-in-loop -- false positive
		const packageJson = await readPackageJson(packageJsonPath);

		if (packageJson) {
			return packageJson;
		}

		const lastPackageJSONUrl = packageJsonUrl;
		packageJsonUrl = new URL('../package.json', packageJsonUrl);

		// Terminates at root where ../package.json equals ../../package.json
		// (can't just check "/package.json" for Windows support).
		if (packageJsonUrl.pathname === lastPackageJSONUrl.pathname) {
			break;
		}
	}
}

/** @param {string} filepath */
export async function getPackageType(filepath) {
	const packageJson = await findPackageJson(filepath);
	return packageJson?.type ?? 'commonjs';
}

export const applySourceMap = installSourceMapSupport();

const tsconfig = process.env.ESBK_TSCONFIG_PATH
	? {
			path: path.resolve(process.env.ESBK_TSCONFIG_PATH),
			config: parseTsconfig(process.env.ESBK_TSCONFIG_PATH)
	  }
	: getTsconfig();

export const fileMatcher = tsconfig && createFilesMatcher(tsconfig);
export const tsconfigPathsMatcher = tsconfig && createPathsMatcher(tsconfig);

export const fileProtocol = 'file://';

export const tsExtensionsPattern = /\.([cm]?ts|[jt]sx)$/;

/**
	@param {string} fileUrl
	@returns {ModuleFormat | undefined}
*/
const getFormatFromExtension = (fileUrl) => {
	const extension = path.extname(fileUrl);

	if (extension === '.json') {
		return 'json';
	}

	if (extension === '.mjs' || extension === '.mts') {
		return 'module';
	}

	if (extension === '.cjs' || extension === '.cts') {
		return 'commonjs';
	}
};

/**
	@param {string} fileUrl
*/
export const getFormatFromFileUrl = (fileUrl) => {
	const format = getFormatFromExtension(fileUrl);

	if (format) {
		return format;
	}

	// ts, tsx, jsx
	if (tsExtensionsPattern.test(fileUrl)) {
		return getPackageType(fileUrl);
	}
};

/**
	@typedef {
		'builtin'
	| 'dynamic'
	| 'commonjs'
	| 'json'
	| 'module'
	| 'wasm'
	} ModuleFormat
*/

/**
	@typedef {{
		url: string;
		format: ModuleFormat | undefined;
		shortCircuit?: boolean
	}} Resolved
*/

/**
	@typedef {{
		conditions: string[];
		parentURL: string | undefined;
	}} Context
*/

/**
	@typedef {(
		specifier: string,
		context: Context,
		defaultResolve: resolve,
		recursiveCall?: boolean,
	) => Resolved | Promise<Resolved>} resolve
*/

const extensions = ['.js', '.json', '.ts', '.tsx', '.jsx'];

/**
	@param {string} specifier
	@param {Context} context
	@param {resolve} defaultResolve
*/
async function tryExtensions(specifier, context, defaultResolve) {
	let error;
	for (const extension of extensions) {
		try {
			// eslint-disable-next-line no-await-in-loop -- We need to check in order
			return await resolve(
				specifier + extension,
				context,
				defaultResolve,
				true
			);
		} catch (/** @type {any} */ _error) {
			if (error === undefined) {
				const { message } = _error;
				_error.message = _error.message.replace(`${extension}'`, "'");
				_error.stack = _error.stack.replace(message, _error.message);
				error = _error;
			}
		}
	}

	throw error;
}

/**
	@param {string} specifier
	@param {Context} context
	@param {resolve} defaultResolve
*/
async function tryDirectory(specifier, context, defaultResolve) {
	const isExplicitDirectory = specifier.endsWith('/');
	const appendIndex = isExplicitDirectory ? 'index' : '/index';

	try {
		return await tryExtensions(
			specifier + appendIndex,
			context,
			defaultResolve
		);
	} catch (/** @type {any} */ error) {
		if (!isExplicitDirectory) {
			try {
				return await tryExtensions(specifier, context, defaultResolve);
			} catch {}
		}

		const { message } = error;
		error.message = error.message.replace(
			`${appendIndex.replace('/', path.sep)}'`,
			"'"
		);
		error.stack = error.stack.replace(message, error.message);
		throw error;
	}
}

const isPathPattern = /^\.{0,2}\//;

/**
	@type {resolve}
*/
export const resolve = async function (
	specifier,
	context,
	defaultResolve,
	recursiveCall
) {
	if (specifier.includes('/node_modules/')) {
		return defaultResolve(specifier, context, defaultResolve);
	}

	// Support tilde alias imports
	if (specifier.startsWith('~') && context.parentURL !== undefined) {
		const importerFilePath = fileURLToPath(context.parentURL);
		return {
			url: `file://${expandTildeImport({
				importSpecifier: specifier,
				importerFilePath
			})}`,
			format: 'module',
			shortCircuit: true
		};
	}

	// Support glob imports
	if (isGlobSpecifier(specifier) && context.parentURL !== undefined) {
		const importerFilePath = fileURLToPath(context.parentURL);
		const url = `file://${getGlobfilePath({
			globfileModuleSpecifier: specifier,
			importerFilePath
		})}`;

		return {
			url,
			format: 'module',
			shortCircuit: true
		};
	}

	if (specifier.startsWith('@t/')) {
		const packageSlug = specifier.match(/@t\/([^/]+)/)?.[1];

		if (packageSlug === undefined) {
			throw new Error(
				`Could not extract tunnel package slug from ${packageSlug}`
			);
		}

		const packageCategory = packageSlugToCategory[packageSlug];
		if (packageCategory === undefined) {
			throw new Error(`Can't find package category for @t/${packageSlug}`);
		}

		const packageDirpath = path.join(
			monorepoDirpath,
			packageCategory,
			packageSlug
		);
		const packageJson = JSON.parse(
			fs.readFileSync(path.join(packageDirpath, 'package.json'), 'utf8')
		);

		const relativeImportPath = specifier.replace(`@t/${packageSlug}`, '.');
		const relativeFilePaths =
			resolveExports(packageJson, relativeImportPath) ?? [];

		if (relativeFilePaths.length > 0) {
			return {
				url: `file://${path.join(
					packageDirpath,
					/** @type {string} */ (relativeFilePaths[0])
				)}`,
				format: 'module',
				shortCircuit: true
			};
		}
	}

	// If directory, can be index.js, index.ts, etc.
	if (specifier.endsWith('/')) {
		return tryDirectory(specifier, context, defaultResolve);
	}

	const isPath =
		specifier.startsWith(fileProtocol) || isPathPattern.test(specifier);

	if (
		tsconfigPathsMatcher &&
		!isPath && // bare specifier
		!context.parentURL?.includes('/node_modules/')
	) {
		const possiblePaths = tsconfigPathsMatcher(specifier);
		for (const possiblePath of possiblePaths) {
			try {
				// eslint-disable-next-line no-await-in-loop -- We need to check in order
				return await resolve(
					pathToFileURL(possiblePath).toString(),
					context,
					defaultResolve
				);
			} catch {}
		}
	}

	/**
	 * Typescript gives .ts, .cts, or .mts priority over actual .js, .cjs, or .mjs extensions
	 */
	if (
		context.parentURL !== undefined &&
		tsExtensionsPattern.test(context.parentURL)
	) {
		const tsPath = resolveTsPath(specifier);

		if (tsPath) {
			try {
				return await resolve(tsPath, context, defaultResolve, true);
			} catch (/** @type {any} */ error) {
				const { code } = error;
				if (
					code !== 'ERR_MODULE_NOT_FOUND' &&
					code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
				) {
					throw error;
				}
			}
		}
	}

	/** @type {Resolved} */
	let resolved;
	try {
		resolved = await defaultResolve(specifier, context, defaultResolve);
	} catch (error) {
		if (error instanceof Error && !recursiveCall) {
			const { code } = /** @type {any} */ (error);
			if (code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
				try {
					return await tryDirectory(specifier, context, defaultResolve);
				} catch (/** @type {any} */ error_) {
					if (error_.code !== 'ERR_PACKAGE_IMPORT_NOT_DEFINED') {
						throw error_;
					}
				}
			}

			if (code === 'ERR_MODULE_NOT_FOUND') {
				try {
					return await tryExtensions(specifier, context, defaultResolve);
				} catch {}
			}
		}

		throw error;
	}

	if (!resolved.format && resolved.url.startsWith(fileProtocol)) {
		resolved.format = await getFormatFromFileUrl(resolved.url);
	}

	return resolved;
};

/**
	@typedef {{
		format: string;
		source: string | ArrayBuffer | SharedArrayBuffer | Uint8Array;
		shortCircuit?: boolean
	}} LoadResolved
*/

/**
	@typedef {
		(
			url: string,
			context: {
				format: string;
				importAssertions: Record<string, string>;
			},
			defaultLoad: load,
		) => LoadResolved | Promise<LoadResolved>
	} load
*/

/** @type {load} */
export const load = async function (url, context, defaultLoad) {
	// if (process.send) {
	// 	process.send({
	// 		type: 'dependency',
	// 		path: url,
	// 	});
	// }

	// If the file doesn't have an extension, we should return the source directly
	if (url.startsWith('file://') && path.extname(url) === '') {
		const source = await fs.promises.readFile(fileURLToPath(url), 'utf8');
		return {
			format: 'commonjs',
			source,
			shortCircuit: true
		};
	}

	const globfilePath = url.startsWith('file://') ? fileURLToPath(url) : url;

	if (path.basename(globfilePath).startsWith('__virtual__:')) {
		const globfileContents = getGlobfileContents({
			globfilePath,
			filepathType: 'absolute'
		});

		return {
			source: globfileContents,
			format: 'module',
			shortCircuit: true
		};
	}

	if (url.endsWith('.json')) {
		if (!context.importAssertions) {
			context.importAssertions = {};
		}

		context.importAssertions.type = 'json';
	}

	const loaded = await defaultLoad(url, context, defaultLoad);

	if (!loaded.source) {
		return loaded;
	}

	const code = loaded.source.toString();

	const filepath = url.startsWith('file://') ? fileURLToPath(url) : url;
	if (loaded.format === 'json' || tsExtensionsPattern.test(url)) {
		const transformed = await transform(code, filepath, {
			tsconfigRaw: /** @type {any} */ (fileMatcher?.(filepath))
		});

		return {
			format: 'module',
			source: applySourceMap(transformed, url)
		};
	}

	if (loaded.format === 'module') {
		const dynamicImportTransformed = transformDynamicImport(filepath, code);
		if (dynamicImportTransformed) {
			loaded.source = applySourceMap(dynamicImportTransformed, url);
		}
	}

	return loaded;
};
