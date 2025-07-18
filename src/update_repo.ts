// src/update_repo.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

// --- Configuration ---
const CAIDO_API_URL = "https://api.caido.io/releases/latest";
const DOWNLOAD_DIR = ".packages";
const REPO_DIR = "repo";
const APTIFY_CONFIG_PATH = "aptify.yml";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// --- Type Definitions for Caido API ---
interface CaidoLink {
  display: string;
  platform: string;
  kind: "cli" | "desktop";
  link: string;
  os: "linux" | "macos" | "windows";
  arch: "x86_64" | "aarch64";
  format: "tar.gz" | "zip" | "deb" | "AppImage" | "dmg" | "exe";
  hash: string;
}

interface CaidoRelease {
  id: string;
  version: string;
  links: CaidoLink[];
  released_at: string;
}

// --- Internal Type Definitions ---
interface CaidoPackage {
  url: string;
  arch: "amd64" | "arm64";
  filename: string;
}

interface AptifyComponent {
  name: string;
  packages: string[];
}

interface AptifyRelease {
  name: string;
  origin: string;
  label: string;
  suite: string;
  components: AptifyComponent[];
}

interface AptifyConfig {
  apiVersion: string;
  kind: string;
  releases: AptifyRelease[];
}

// --- Core Logic ---

/**
 * Maps architecture names from Caido API to standard Debian architecture names.
 */
function mapArchitecture(apiArch: "x86_64" | "aarch64"): "amd64" | "arm64" {
  switch (apiArch) {
    case "x86_64":
      return "amd64";
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported architecture from Caido API: ${apiArch}`);
  }
}

/**
 * Fetches the latest Caido .deb package information from the official Caido Releases API.
 */
async function getLatestCaidoPackages(): Promise<CaidoPackage[]> {
  console.log(
    `[INFO] Fetching latest release information from ${CAIDO_API_URL}...`,
  );
  try {
    const response = await fetch(CAIDO_API_URL, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(
        `Caido API request failed with status: ${response.status}`,
      );
    }

    const releaseData: CaidoRelease = await response.json();
    console.log(`[INFO] Found latest Caido version: ${releaseData.version}`);

    const debLinks = releaseData.links.filter(
      (link) =>
        link.format === "deb" &&
        link.os === "linux" &&
        (link.arch === "x86_64" || link.arch === "aarch64"),
    );

    if (debLinks.length === 0) {
      throw new Error(
        "No .deb packages found in the latest Caido release assets.",
      );
    }

    const debPackages: CaidoPackage[] = debLinks.map((link) => {
      const arch = mapArchitecture(link.arch);
      const filename = path.basename(link.link);
      console.log(`[INFO] Found package: ${filename} (${arch})`);
      return {
        url: link.link,
        arch,
        filename,
      };
    });

    return debPackages;
  } catch (error) {
    console.error(
      `[ERROR] Failed to fetch or parse Caido release info:`,
      error,
    );
    throw error;
  }
}

/**
 * Downloads a .deb package from a URL to a specified directory.
 */
async function downloadPackage(
  pkg: CaidoPackage,
  downloadDir: string,
): Promise<string | null> {
  const destinationPath = path.join(rootDir, downloadDir, pkg.filename);

  console.log(`[DOWNLOAD] Downloading ${pkg.filename}...`);
  try {
    const response = await fetch(pkg.url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    await Bun.write(destinationPath, response);
    console.log(`[DOWNLOAD] Successfully saved to ${destinationPath}`);
    return destinationPath;
  } catch (error) {
    console.error(`[ERROR] Failed to download ${pkg.url}:`, error);
    return null;
  }
}

/**
 * Executes a command using Bun.spawn for better performance and async handling.
 */
async function runCommand(command: string, args: string[]): Promise<void> {
  console.log(`[EXEC] Running: ${command} ${args.join(" ")}`);
  const proc = Bun.spawn([command, ...args], {
    cwd: rootDir,
    stdio: ["inherit", "inherit", "inherit"], // Pipe stdin, stdout, stderr
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `Command "${command} ${args.join(" ")}" failed with exit code ${exitCode}.`,
    );
  }
}

/**
 * Loads and parses the aptify.yml configuration file.
 */
async function loadAptifyConfig(): Promise<AptifyConfig> {
  try {
    const configPath = path.join(rootDir, APTIFY_CONFIG_PATH);
    const configFile = await Bun.file(configPath).text();
    const config = parse(configFile) as AptifyConfig;

    if (!config.releases) {
      throw new Error("Invalid aptify.yml: missing required 'releases' field.");
    }

    return config;
  } catch (error) {
    console.error(`[ERROR] Failed to load aptify configuration:`, error);
    throw error;
  }
}

/**
 * Saves the aptify.yml configuration file.
 */
async function saveAptifyConfig(config: AptifyConfig): Promise<void> {
  try {
    const configPath = path.join(rootDir, APTIFY_CONFIG_PATH);
    const yamlString = stringify(config, {
      indent: 2,
      lineWidth: 0, // Prevent line wrapping for package lists
      singleQuote: false,
    });
    await fs.writeFile(configPath, yamlString, "utf-8");
    console.log(`[INFO] Successfully updated ${APTIFY_CONFIG_PATH}`);
  } catch (error) {
    console.error(`[ERROR] Failed to save aptify configuration:`, error);
    throw error;
  }
}

/**
 * Ensures the download directory exists and is clean.
 */
async function prepareDownloadDirectory(): Promise<void> {
  const fullDownloadDir = path.join(rootDir, DOWNLOAD_DIR);
  console.log(`[INFO] Preparing download directory: ${fullDownloadDir}`);
  try {
    await fs.rm(fullDownloadDir, { recursive: true, force: true });
    await fs.mkdir(fullDownloadDir, { recursive: true });
  } catch (error) {
    console.error(`[ERROR] Failed to prepare download directory:`, error);
    throw error;
  }
}

/**
 * Cleans up temporary files and directories.
 */
async function cleanup(): Promise<void> {
  console.log(`[INFO] Cleaning up temporary directory: ${DOWNLOAD_DIR}`);
  try {
    await fs.rm(path.join(rootDir, DOWNLOAD_DIR), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.error(`[WARN] Failed to clean up temporary directory:`, error);
  }
}

/**
 * Validates that required tools are available.
 */
async function validateDependencies(): Promise<void> {
  console.log(`[INFO] Validating dependencies...`);
  try {
    await runCommand("aptify", ["--version"]);
    console.log(`[INFO] aptify is available`);
  } catch (error) {
    console.error(
      `[ERROR] aptify is not installed or not in PATH. Please install it with: pip install aptify`,
    );
    throw error;
  }
}

/**
 * Main execution function to update the APT repository.
 */
async function main(): Promise<void> {
  const startTime = Date.now();
  console.log(`[INFO] Starting Caido APT repository update process...`);

  try {
    await validateDependencies();
    const config = await loadAptifyConfig();
    console.log(
      `[INFO] Loaded configuration for ${config.releases.length} releases`,
    );

    const packagesToDownload = await getLatestCaidoPackages();
    console.log(
      `[INFO] Found ${packagesToDownload.length} packages to download`,
    );

    await prepareDownloadDirectory();

    console.log(`[INFO] Starting concurrent downloads...`);
    const downloadPromises = packagesToDownload.map((pkg) =>
      downloadPackage(pkg, DOWNLOAD_DIR),
    );
    const downloadedPaths = (await Promise.all(downloadPromises)).filter(
      (p): p is string => p !== null,
    );

    if (downloadedPaths.length !== packagesToDownload.length) {
      console.warn(
        `[WARN] Some package downloads failed. Proceeding with ${downloadedPaths.length} packages.`,
      );
    }

    if (downloadedPaths.length === 0) {
      throw new Error(
        "All package downloads failed. Cannot update repository.",
      );
    }

    console.log(
      `[INFO] Successfully downloaded ${downloadedPaths.length}/${packagesToDownload.length} packages`,
    );

    const relativePackagePaths = downloadedPaths.map((p) =>
      path.relative(rootDir, p),
    );

    // Update the configuration in memory to point to the new packages
    for (const release of config.releases) {
      for (const component of release.components) {
        component.packages = relativePackagePaths;
        console.log(
          `[INFO] Updated package list for release '${release.name}' component '${component.name}'`,
        );
      }
    }

    // Save the updated configuration back to aptify.yml
    await saveAptifyConfig(config);

    console.log(`[INFO] Ensuring repository directory '${REPO_DIR}' exists...`);
    await fs.mkdir(path.join(rootDir, REPO_DIR), { recursive: true });

    console.log(`[INFO] Building repository metadata...`);
    await runCommand("aptify", [
      "build",
      "--config",
      APTIFY_CONFIG_PATH,
      "--repository-dir",
      REPO_DIR,
    ]);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    console.log(
      `[SUCCESS] Caido APT repository update completed successfully in ${duration}s`,
    );
  } catch (error) {
    console.error(
      `[FATAL] An unhandled error occurred during the repository update process:`,
      error,
    );
    process.exit(1);
  } finally {
    await cleanup();
  }
}

// Handle process signals for graceful shutdown
process.on("SIGINT", async () => {
  console.log(`\n[INFO] Received SIGINT, cleaning up and exiting...`);
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  console.log(`\n[INFO] Received SIGTERM, cleaning up and exiting...`);
  await cleanup();
  process.exit(143);
});

// Run the main function
main().catch((error) => {
  console.error(`[FATAL] Unhandled promise rejection in main:`, error);
  process.exit(1);
});
