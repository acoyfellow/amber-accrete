import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

export const REPO = "/private/tmp/ca-fbb30d48";

export const PACKAGE = "packages/analytics";

export const TSCONFIG_PATH = `${PACKAGE}/tsconfig.amber.json`;

export const TSCONFIG = JSON.stringify({
	compilerOptions: {
		target: "ES2022",
		module: "ES2022",
		moduleResolution: "bundler",
		lib: ["ES2022"],
		strict: true,
		noEmit: true,
		isolatedModules: true,
		skipLibCheck: true,
		esModuleInterop: true,
		resolveJsonModule: true,
		types: ["@cloudflare/workers-types", "node"],
	},
	include: ["src/**/*.ts"],
});

const EMBEDDED = new RegExp(String.raw`[/]typescript[/]lib[/]|[/]@cloudflare[/]workers-types[/]`);

export const listedFiles = (): Array<string> => {
	const output = execFileSync("npx", ["tsc", "-p", TSCONFIG_PATH, "--listFilesOnly"], { cwd: REPO, encoding: "utf8" });

	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !EMBEDDED.test(line))
		.map((line) => relative(REPO, line))
		.filter((line) => !line.startsWith(".."));
};

const RESOLVED = /(?:Module name|Type reference directive) '([^'.][^']*)' was successfully resolved to '([^']+)'/;

const PACKAGE_DEPTH = "../../";

const resolvedPaths = (): Record<string, Array<string>> => {
	const trace = execFileSync("npx", ["tsc", "-p", TSCONFIG_PATH, "--traceResolution"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
	const table = new Map<string, string>();

	for (const line of trace.split("\n")) {
		const match = line.match(RESOLVED);

		if (match === null || match[1] === undefined || match[2] === undefined || table.has(match[1])) continue;

		const target = relative(REPO, match[2]);

		if (/\.d\.(ts|mts|cts)$|\.ts$/.test(target)) table.set(match[1], `${PACKAGE_DEPTH}${target}`);
	}

	return Object.fromEntries(Array.from(table, ([name, target]) => [name, [target]]));
};

export const sliceFiles = (overrides: ReadonlyMap<string, string> = new Map()): Map<string, string> => {
	const files = new Map<string, string>([[TSCONFIG_PATH, TSCONFIG]]);

	for (const path of listedFiles()) files.set(path, overrides.get(path) ?? readFileSync(`${REPO}/${path}`, "utf8"));

	for (const [path, text] of overrides) files.set(path, text);

	for (const path of files.keys()) if (path.includes("node_modules/")) addPackageJson(files, path);

	for (const workspace of ["packages/observability", "packages/utils"]) files.set(`${workspace}/package.json`, readFileSync(`${REPO}/${workspace}/package.json`, "utf8"));

	const config = JSON.parse(TSCONFIG) as { compilerOptions: Record<string, unknown> };

	const paths = resolvedPaths();

	config.compilerOptions["paths"] = paths;
	config.compilerOptions["types"] = ["node"].flatMap((name) => paths[name] ?? []);
	files.set(TSCONFIG_PATH, JSON.stringify(config));

	return files;
};
const addPackageJson = (files: Map<string, string>, path: string): void => {
	const match = path.match(new RegExp(String.raw`^(.*node_modules[/](?:@[^/]+[/])?[^/]+)[/]`));

	if (match === null || match[1] === undefined) return;

	const manifest = `${match[1]}/package.json`;

	if (!files.has(manifest)) files.set(manifest, readFileSync(`${REPO}/${manifest}`, "utf8"));
};
