// @ts-check

'use strict';

const path = require('pathe');
// @ts-expect-error: works
const { getProjectDirpath } = require('lion-utils');
const monorepoDirpath = getProjectDirpath(__dirname, { monorepoRoot: true });

process.env.ESBK_TSCONFIG_PATH = path.join(monorepoDirpath, 'tsconfig.json');

const fs = require('node:fs');
const Module = require('node:module');
const {
	transformSync,
	installSourceMapSupport,
	resolveTsPath,
	transformDynamicImport
} = require('@esbuild-kit/core-utils');
const {
	getTsconfig,
	parseTsconfig,
	createPathsMatcher,
	createFilesMatcher
} = require('get-tsconfig');
// @ts-expect-error: bad typings
const { isFileEsmSync } = require('is-file-esm-ts');
const {
	getGlobfileContents,
	getGlobfilePath,
	isGlobSpecifier
	// @ts-expect-error: bad typings
} = require('glob-imports');
const { expandTildeImport } = require('tilde-imports');
const resolve = require('resolve.exports');
const { packageSlugToCategory } = require('./utils/paths.cjs');

const isPathPattern = /^\.{0,2}\//;
const isTsFilePattern = /\.[cm]?tsx?$/;
const nodeModulesPath = `${path.sep}node_modules${path.sep}`;

const tsconfig = process.env.ESBK_TSCONFIG_PATH
	? {
			path: path.resolve(process.env.ESBK_TSCONFIG_PATH),
			config: parseTsconfig(process.env.ESBK_TSCONFIG_PATH)
	  }
	: getTsconfig();

const fileMatcher = tsconfig && createFilesMatcher(tsconfig);
const tsconfigPathsMatcher = tsconfig && createPathsMatcher(tsconfig);
const applySourceMap = installSourceMapSupport();

/**
	@param {any} module
	@param {string} filepath
*/
function transformer(module, filepath) {
	if (filepath.endsWith('.css')) {
		return;
	}

	if (path.basename(filepath).startsWith('__virtual__:')) {
		const virtualFileContents = getGlobfileContents({
			globfilePath: filepath,
			moduleType: 'commonjs',
			filepathType: 'absolute'
		});

		module._compile(virtualFileContents, filepath);
		return;
	}

	let code = fs.readFileSync(filepath, 'utf8');

	if (filepath.includes('/node_modules/')) {
		try {
			if (isFileEsmSync(filepath)) {
				const transformed = transformSync(code, filepath, { format: 'cjs' });
				code = applySourceMap(transformed, filepath);
			}
		} catch {
			// Ignore invalid file extension issues
		}

		module._compile(code, filepath);
		return;
	}

	if (filepath.endsWith('.cjs')) {
		const transformed = transformDynamicImport(filepath, code);
		if (transformed) {
			code = applySourceMap(transformed, filepath);
		}
	} else {
		const transformed = transformSync(code, filepath, {
			// @ts-expect-error: Correct type
			tsconfigRaw: fileMatcher?.(filepath)
		});

		code = applySourceMap(transformed, filepath);
	}

	module._compile(code, filepath);
}

// @ts-expect-error: Node.js Internals
const extensions = Module._extensions;

/**
 * Loaders for implicitly resolvable extensions
 * https://github.com/nodejs/node/blob/v12.16.0/lib/internal/modules/cjs/loader.js#L1166
 */
for (const extension of [
	'.js', // (Handles .cjs, .cts, .mts & any explicitly specified extension that doesn't match any loaders)
	'.ts',
	'.tsx',
	'.jsx'
]) {
	extensions[extension] = transformer;
}

/**
 * Loaders for explicitly resolvable extensions
 * (basically just .mjs because CJS loader has a special handler for it)
 *
 * Loaders for extensions .cjs, .cts, & .mts don't need to be
 * registered because they're explicitly specified and unknown
 * extensions (incl .cjs) fallsback to using the '.js' loader:
 * https://github.com/nodejs/node/blob/v18.4.0/lib/internal/modules/cjs/loader.js#L430
 *
 * That said, it's actually ".js" and ".mjs" that get special treatment
 * rather than ".cjs" (it might as well be ".random-ext")
 */
Object.defineProperty(extensions, '.mjs', {
	value: transformer,
	writable: true,
	configurable: true,

	// Prevent Object.keys from detecting these extensions
	// when CJS loader iterates over the possible extensions
	enumerable: false
});

// @ts-expect-error: Node.js internals
const resolveFilename = Module._resolveFilename;

/**
	Resolves the filename of a module, given its request, parent module, and whether it's the main module.
	@param {string} request - The request for the module to resolve.
	@param {NodeModule} parent - The parent module that is requiring the module to resolve.
	@param {boolean} isMain - Whether the module being resolved is the main module.
	@param {object} options
	@returns {string} - The filename of the resolved module.
*/
// @ts-expect-error: Node.js internals
Module._resolveFilename = function (request, parent, isMain, options) {
	if (isGlobSpecifier(request)) {
		return getGlobfilePath({
			globfileModuleSpecifier: request,
			importerFilePath: parent.filename
		});
	}

	if (request.startsWith('~')) {
		request = expandTildeImport({
			importSpecifier: request,
			importerFilePath: parent.filename
		});
	}

	if (request.startsWith('@t/')) {
		const packageSlug = request.match(/@t\/([^/]+)/)?.[1];
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

		const relativeImportPath = request.replace(`@t/${packageSlug}`, '.');
		const relativeFilePaths =
			resolve.exports(packageJson, relativeImportPath) ?? [];

		if (relativeFilePaths.length > 0) {
			return path.join(
				packageDirpath,
				/** @type {string} */ (relativeFilePaths[0])
			);
		}
	}

	if (
		tsconfigPathsMatcher &&
		// bare specifier
		!isPathPattern.test(request) &&
		// Dependency paths should not be resolved using tsconfig.json
		!parent?.filename?.includes(nodeModulesPath)
	) {
		const possiblePaths = tsconfigPathsMatcher(request);

		for (const possiblePath of possiblePaths) {
			const tsFilename = resolveTsFilename.call(
				this,
				possiblePath,
				parent,
				isMain,
				options
			);
			if (tsFilename) {
				return tsFilename;
			}

			try {
				return resolveFilename.call(
					this,
					possiblePath,
					parent,
					isMain,
					options
				);
			} catch {}
		}
	}

	const tsFilename = resolveTsFilename.call(
		this,
		request,
		parent,
		isMain,
		options
	);
	if (tsFilename) {
		return tsFilename;
	}

	return resolveFilename.call(this, request, parent, isMain, options);
};

/**
	Typescript gives .ts, .cts, or .mts priority over actual .js, .cjs, or .mjs extensions
	@param {string} request - The request for the module to resolve.
	@param {NodeModule} parent - The parent module that is requiring the module to resolve.
	@param {boolean} isMain - Whether the module being resolved is the main module.
	@param {object} options
*/
function resolveTsFilename(request, parent, isMain, options) {
	const tsPath = resolveTsPath(request);

	if (parent && isTsFilePattern.test(parent.filename) && tsPath) {
		try {
			// @ts-expect-error: `this` type
			return resolveFilename.call(this, tsPath, parent, isMain, options);
		} catch (/** @type {any} */ error) {
			const { code } = error;
			if (
				code !== 'MODULE_NOT_FOUND' &&
				code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED'
			) {
				throw error;
			}
		}
	}
}
