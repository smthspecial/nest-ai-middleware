import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";

const packageDirectories = [
  "core",
  "adapter-sqlite",
  "adapter-postgres",
  "adapter-mongodb",
];
const registry = "https://registry.npmjs.org/";
const packages = packageDirectories.map((directory) => {
  const path = `packages/${directory}`;
  const {
    name,
    version,
    private: isPrivate,
  } = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
  if (isPrivate) throw new Error(`${name} is private.`);
  return { name, version, archive: `./release/${name}-${version}.tgz` };
});

const version = packages[0].version;
if (packages.some((pkg) => pkg.version !== version)) {
  throw new Error("The four npm packages must share the same release version.");
}

const {
  GITHUB_ACTIONS,
  GITHUB_EVENT_NAME,
  NPM_RELEASE_TAG,
  NPM_RELEASE_PUBLISH,
} = process.env;
if (
  NPM_RELEASE_TAG !== undefined &&
  (!/^\d+\.\d+\.\d+$/.test(version) || NPM_RELEASE_TAG !== `v${version}`)
) {
  throw new Error(
    `Use a stable release tag matching the package version, v${version}.`,
  );
}

function npm(...args) {
  execFileSync("npm", args, { stdio: "inherit" });
}

async function planPublish() {
  const pending = [];
  for (const pkg of packages) {
    const digest = createHash("sha512")
      .update(readFileSync(pkg.archive))
      .digest("base64");
    const url = new URL(
      `${encodeURIComponent(pkg.name)}/${pkg.version}`,
      registry,
    );
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (response.status === 404) {
      pending.push(pkg);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Could not verify ${pkg.name}@${pkg.version} (HTTP ${response.status}).`,
      );
    }
    const current = await response.json();
    if (current.dist?.integrity !== `sha512-${digest}`) {
      throw new Error(
        `${pkg.name}@${pkg.version} already exists with different contents. Choose a new release version.`,
      );
    }
    console.log(
      `${pkg.name}@${pkg.version} is already published with matching contents.`,
    );
  }
  return pending;
}

switch (process.argv[2]) {
  case "pack":
    mkdirSync("release", { recursive: true });
    for (const pkg of packages) {
      npm("pack", "--workspace", pkg.name, "--pack-destination", "release");
      npm(
        "publish",
        pkg.archive,
        "--dry-run",
        "--ignore-scripts",
        "--access",
        "public",
        "--registry",
        registry,
      );
    }
    break;
  case "publish": {
    if (
      GITHUB_ACTIONS !== "true" ||
      GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      NPM_RELEASE_PUBLISH !== "true" ||
      !NPM_RELEASE_TAG
    ) {
      throw new Error(
        "Publishing requires a manual GitHub Actions run with a release tag and publishing enabled.",
      );
    }
    const pending = await planPublish();
    const publishCommand =
      process.env.NPM_BOOTSTRAP === "true" ? ["stage", "publish"] : ["publish"];
    for (const pkg of pending) {
      npm(
        ...publishCommand,
        pkg.archive,
        "--ignore-scripts",
        "--access",
        "public",
        "--registry",
        registry,
      );
    }
    break;
  }
  default:
    throw new Error("Use npm-release.mjs pack or publish.");
}
