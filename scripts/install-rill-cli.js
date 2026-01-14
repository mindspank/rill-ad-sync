/**
 * Script to install Rill CLI binary
 * Downloads and installs the Rill CLI for the current platform
 * Replicates the logic from the official Rill install script
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');

const RILL_VERSION = process.env.RILL_VERSION || 'latest';
const CDN_BASE = 'cdn.rilldata.com';

function getPlatformInfo() {
    const platform = os.platform();
    const arch = os.arch();

    // Match the official install script platform detection
    let platformString;

    if (platform === 'darwin' && arch === 'arm64') {
        platformString = 'darwin_arm64';
    } else if (platform === 'darwin' && arch === 'x64') {
        platformString = 'darwin_amd64';
    } else if (platform === 'linux' && arch === 'x64') {
        platformString = 'linux_amd64';
    } else if (platform === 'linux' && (arch === 'arm64' || arch === 'aarch64')) {
        platformString = 'linux_arm64';
    } else {
        throw new Error(`Platform not supported: os=${platform} arch=${arch}`);
    }

    return platformString;
}

function validateVersion(version) {
    // Validate version string to prevent injection
    if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
        throw new Error(`Invalid version format: ${version}`);
    }
    return version;
}

async function downloadFile(url, dest, maxSize = 100 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        let downloadedBytes = 0;
        let timeoutId;

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (fs.existsSync(dest)) {
                try {
                    fs.unlinkSync(dest);
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        };

        // Set timeout (30 seconds)
        timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`Download timeout for ${url}`));
        }, 30000);

        https
            .get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    // Follow redirect
                    file.close();
                    clearTimeout(timeoutId);
                    return downloadFile(response.headers.location, dest, maxSize)
                        .then(resolve)
                        .catch(reject);
                }
                if (response.statusCode !== 200) {
                    cleanup();
                    reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
                    return;
                }

                const contentLength = parseInt(response.headers['content-length'] || '0', 10);
                if (contentLength > maxSize) {
                    cleanup();
                    reject(new Error(`File too large: ${contentLength} bytes (max: ${maxSize})`));
                    return;
                }

                response.on('data', (chunk) => {
                    downloadedBytes += chunk.length;
                    if (downloadedBytes > maxSize) {
                        cleanup();
                        reject(new Error(`Download exceeded max size: ${maxSize} bytes`));
                    }
                });

                response.pipe(file);
                file.on('finish', () => {
                    clearTimeout(timeoutId);
                    file.close();
                    resolve();
                });
            })
            .on('error', (err) => {
                cleanup();
                reject(new Error(`Download error for ${url}: ${err.message}`));
            });
    });
}

async function getLatestVersion() {
    return new Promise((resolve, reject) => {
        https.get(
            `https://${CDN_BASE}/rill/latest.txt`,
            (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Failed to get latest version: ${res.statusCode}`));
                    return;
                }
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve(data.trim());
                });
            }
        ).on('error', reject);
    });
}

function verifyChecksum(filePath, expectedChecksum) {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    const actualChecksum = hashSum.digest('hex');

    if (actualChecksum !== expectedChecksum) {
        throw new Error(
            `Checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`
        );
    }
    return true;
}

function parseChecksums(checksumsPath, platform) {
    const checksumsContent = fs.readFileSync(checksumsPath, 'utf8');
    const lines = checksumsContent.split('\n');

    // Look for the line matching our platform zip file
    // Format: <hash>  <filename> or <hash> *<filename>
    const zipFileName = `rill_${platform}.zip`;
    const hashRegex = /^([a-f0-9]{64})\s+[* ]?(.+)$/i;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue; // Skip empty lines and comments
        }

        const match = trimmed.match(hashRegex);
        if (match) {
            const hash = match[1];
            const filename = match[2].trim();
            // Exact match required, not just includes (prevents false matches)
            if (filename === zipFileName || filename.endsWith(`/${zipFileName}`)) {
                return hash;
            }
        }
    }

    throw new Error(`Checksum not found for ${zipFileName} in ${checksumsPath}`);
}

function safeUnlink(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        // Ignore cleanup errors
        console.warn(`Warning: Could not delete ${filePath}: ${error.message}`);
    }
}

function cleanupTempDir(tempDir, files) {
    if (files) {
        files.forEach((file) => safeUnlink(path.join(tempDir, file)));
    }
    try {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    } catch (error) {
        console.warn(`Warning: Could not remove temp directory ${tempDir}: ${error.message}`);
    }
}

async function installRillCLI() {
    const tempDir = path.join(os.tmpdir(), `rill-cli-install-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    const tempFiles = [];

    try {
        const platform = getPlatformInfo();
        let version =
            RILL_VERSION === 'latest'
                ? await getLatestVersion()
                : RILL_VERSION.replace(/^v/, ''); // Remove leading 'v' if present
        
        version = validateVersion(version);

        console.log(`Installing Rill CLI ${version} for ${platform}`);

        const binaryName = 'rill';
        const zipFileName = `rill_${platform}.zip`;
        const binaryUrl = `https://${CDN_BASE}/rill/${version}/${zipFileName}`;
        const checksumUrl = `https://${CDN_BASE}/rill/${version}/checksums.txt`;

        // Create unique temp directory to avoid race conditions
        fs.mkdirSync(tempDir, { recursive: true });

        const zipPath = path.join(tempDir, zipFileName);
        const checksumsPath = path.join(tempDir, 'checksums.txt');
        const binaryPath = path.join(tempDir, binaryName);
        const targetPath = path.join(__dirname, '..', 'node_modules', '.bin', binaryName);

        // Track temp files for cleanup
        tempFiles.push(zipFileName, 'checksums.txt', binaryName);

        // Ensure .bin directory exists
        const binDir = path.join(__dirname, '..', 'node_modules', '.bin');
        if (!fs.existsSync(binDir)) {
            fs.mkdirSync(binDir, { recursive: true });
        }

        // Download checksum file first (smaller, faster)
        console.log(`Downloading checksum: ${checksumUrl}`);
        await downloadFile(checksumUrl, checksumsPath).catch((error) => {
            throw new Error(`Failed to download checksum file: ${error.message}`);
        });

        // Parse checksum before downloading binary
        console.log('Parsing checksum file...');
        const expectedChecksum = parseChecksums(checksumsPath, platform);

        // Download the zip file
        console.log(`Downloading binary: ${binaryUrl}`);
        await downloadFile(binaryUrl, zipPath).catch((error) => {
            throw new Error(`Failed to download binary: ${error.message}`);
        });

        // Verify checksum immediately after download
        console.log('Verifying SHA256 checksum...');
        verifyChecksum(zipPath, expectedChecksum);
        console.log('Checksum verified successfully');

        // Extract the zip file
        console.log(`Unpacking ${zipFileName}...`);
        try {
            // Use unzip command (should be available on Unix-like systems)
            // Escape paths to prevent injection
            const escapedZipPath = zipPath.replace(/"/g, '\\"');
            const escapedTempDir = tempDir.replace(/"/g, '\\"');
            execSync(`unzip -q "${escapedZipPath}" -d "${escapedTempDir}"`, { 
                stdio: 'inherit',
                maxBuffer: 10 * 1024 * 1024 // 10MB
            });
        } catch (error) {
            throw new Error(
                `Failed to extract zip file: ${error.message}. ` +
                `Ensure 'unzip' is installed or install Rill CLI manually.`
            );
        }

        // Find the extracted binary
        const extractedBinary = path.join(tempDir, binaryName);
        if (!fs.existsSync(extractedBinary)) {
            // Sometimes the binary might be in a subdirectory
            const files = fs.readdirSync(tempDir);
            const foundBinary = files.find((f) => f === binaryName);
            if (foundBinary) {
                fs.renameSync(path.join(tempDir, foundBinary), binaryPath);
            } else {
                // Check subdirectories
                for (const file of files) {
                    const filePath = path.join(tempDir, file);
                    if (fs.statSync(filePath).isDirectory()) {
                        const subBinary = path.join(filePath, binaryName);
                        if (fs.existsSync(subBinary)) {
                            fs.copyFileSync(subBinary, binaryPath);
                            break;
                        }
                    }
                }
                if (!fs.existsSync(binaryPath)) {
                    throw new Error(`Binary not found in extracted files: ${files.join(', ')}`);
                }
            }
        } else {
            fs.copyFileSync(extractedBinary, binaryPath);
        }

        // Make binary executable (Unix-like systems)
        fs.chmodSync(binaryPath, 0o755);

        // Check if binary already exists and is the same version
        if (fs.existsSync(targetPath)) {
            try {
                const existingVersion = execSync(`"${targetPath}" version`, { 
                    encoding: 'utf8',
                    timeout: 5000
                }).trim();
                console.log(`Existing Rill CLI found: ${existingVersion}`);
                // Could compare versions here, but for now we'll just overwrite
            } catch (error) {
                console.warn('Existing binary found but could not verify version, will overwrite');
            }
        }

        // Copy to node_modules/.bin using install command (like the official script)
        try {
            const escapedBinaryPath = binaryPath.replace(/"/g, '\\"');
            const escapedTargetPath = targetPath.replace(/"/g, '\\"');
            execSync(`install "${escapedBinaryPath}" "${escapedTargetPath}"`, { 
                stdio: 'inherit',
                timeout: 10000
            });
        } catch (error) {
            // Fallback to copyFileSync if install command fails
            console.warn('install command failed, using copyFileSync fallback');
            fs.copyFileSync(binaryPath, targetPath);
            fs.chmodSync(targetPath, 0o755);
        }

        console.log(`Rill CLI installed successfully to ${targetPath}`);

        // Test the installed binary
        try {
            const escapedTargetPath = targetPath.replace(/"/g, '\\"');
            const versionOutput = execSync(`"${escapedTargetPath}" version`, { 
                encoding: 'utf8',
                timeout: 5000
            });
            console.log(`Installed: ${versionOutput.trim()}`);
        } catch (error) {
            console.warn(`Could not verify installed binary version: ${error.message}`);
        }

        // Cleanup temp files
        cleanupTempDir(tempDir, tempFiles);
    } catch (error) {
        // Cleanup on error
        cleanupTempDir(tempDir, tempFiles);
        console.error(`Failed to install Rill CLI: ${error.message}`);
        console.warn('You may need to install Rill CLI manually or use a Dockerfile');
        // Don't throw - allow build to continue
        // The function will fail at runtime if Rill CLI is not available
    }
}

// Run installation
if (require.main === module) {
    installRillCLI().catch((error) => {
        console.error('Installation error:', error);
        process.exit(1);
    });
}

module.exports = { installRillCLI };
