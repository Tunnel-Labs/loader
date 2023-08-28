// @ts-expect-error: works
const { getMonorepoDirpath } = require('get-monorepo-rooet');

const fs = require('node:fs');
const path = require('pathe');

const monorepoDirpath = getMonorepoDirpath(__dirname);
if (monorepoDirpath === undefined) {
	throw new Error('could not get monorepo directory');
}

exports.monorepoDirpath = monorepoDirpath;

/** @type {Record<string, string[]>} */
const packageCategories = {
	monorepo: ['monorepo'],
	...Object.fromEntries(
		JSON.parse(
			fs.readFileSync(path.join(monorepoDirpath, 'pnpm-workspace.yaml'), 'utf8')
		)
			.packages.map((/** @type {string} */ packagePattern) =>
				packagePattern.replace(/\/\*$/, '')
			)
			// Some package categories might not exist on Docker
			.filter((/** @type {string} */ packageCategory) =>
				fs.existsSync(path.join(monorepoDirpath, packageCategory))
			)
			.map((/** @type {string} */ packageCategory) => {
				const packageSlugs = fs
					.readdirSync(path.join(monorepoDirpath, packageCategory))
					.filter((dir) => !dir.startsWith('.'));

				const ghostPackageSlugs = new Set();
				// Remove ghost packages that have been renamed
				for (const packageSlug of packageSlugs) {
					if (
						!fs.existsSync(
							path.join(
								monorepoDirpath,
								packageCategory,
								packageSlug,
								'package.json'
							)
						)
					) {
						// eslint-disable-next-line no-console -- TODO
						console.error(
							`Package at path \`${monorepoDirpath}/${packageCategory}/${packageSlug}\` does not contain a \`package.json\` file, deleting it...`
						);
						ghostPackageSlugs.add(packageSlug);
						fs.rmSync(
							path.join(monorepoDirpath, packageCategory, packageSlug),
							{
								recursive: true,
								force: true
							}
						);
					}
				}

				return [
					packageCategory,
					packageSlugs.filter(
						(packageSlug) => !ghostPackageSlugs.has(packageSlug)
					)
				];
			})
	)
};
exports.packageCategories = packageCategories;

const packageSlugToCategory = Object.fromEntries(
	Object.entries(packageCategories).flatMap(([category, packageNames]) =>
		packageNames.map((packageName) => [packageName, category])
	)
);
exports.packageSlugToCategory = packageSlugToCategory;
