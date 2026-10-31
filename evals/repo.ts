import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type RepoSlice = { readonly repo: string; readonly commit: string; readonly packageDir: string; readonly files: Map<string, string>; readonly sourceFiles: number; readonly typeFiles: number; readonly bytes: number };

const TYPE_FILE = /\.d\.(ts|mts|cts)$/;

const walk = (root: string, keep: (path: string) => boolean): Array<string> =>
	readdirSync(root).flatMap((name) => {
		const path = join(root, name);

		return statSync(path).isDirectory() ? walk(path, keep) : keep(path) ? [path] : [];
	});

const packageTypes = (store: string, name: string): Map<string, string> => {
	const match = readdirSync(store).filter((entry) => entry.startsWith(`${name.replace("/", "+")}@`)).sort().at(-1);

	if (match === undefined) throw new Error(`no ${name} in ${store}`);

	const dir = join(store, match, "node_modules", name);
	const files = new Map<string, string>([[`node_modules/${name}/package.json`, readFileSync(join(dir, "package.json"), "utf8")]]);

	for (const path of walk(dir, (candidate) => TYPE_FILE.test(candidate) && !candidate.includes("/node_modules/", dir.length))) files.set(`node_modules/${name}/${relative(dir, path)}`, readFileSync(path, "utf8"));

	return files;
};

export const sliceOf = (repo: string, packageDir: string, store: string, dependencies: ReadonlyArray<string>, tsconfig: object): RepoSlice => {
	const tracked = execFileSync("git", ["-C", repo, "ls-files", `${packageDir}/src`], { encoding: "utf8" }).split("\n").filter((path) => path.endsWith(".ts"));
	const files = new Map<string, string>([["tsconfig.json", JSON.stringify(tsconfig)]]);

	for (const path of tracked) files.set(relative(packageDir, path), readFileSync(join(repo, path), "utf8"));

	const sourceFiles = files.size - 1;

	for (const name of dependencies) for (const [path, text] of packageTypes(store, name)) files.set(path, text);

	if (!existsSync(store)) throw new Error(`missing store ${store}`);

	return {
		repo,
		commit: execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
		packageDir,
		files,
		sourceFiles,
		typeFiles: files.size - 1 - sourceFiles,
		bytes: Array.from(files.values()).reduce((sum, text) => sum + text.length, 0),
	};
};
