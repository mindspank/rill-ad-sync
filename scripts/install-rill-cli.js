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

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
          return downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
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

async function parseChecksums(checksumsPath, platform) {
  const checksumsContent = fs.readFileSync(checksumsPath, 'utf8');
  const lines = checksumsContent.split('\n');
  
  // Look for the line matching our platform zip file
  const zipFileName = `rill_${platform}.zip`;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1].includes(zipFileName)) {
      return parts[0]; // Return the SHA256 hash
    }
  }
  
  throw new Error(`Checksum not found for ${zipFileName}`);
}

async function installRillCLI() {
  try {
    const platform = getPlatformInfo();
    const version =
      RILL_VERSION === 'latest'
        ? await getLatestVersion()
        : RILL_VERSION.replace('v', '');

    console.log(`Installing Rill CLI ${version} for ${platform}`);

    const binaryName = 'rill';
    const zipFileName = `rill_${platform}.zip`;
    const binaryUrl = `https://${CDN_BASE}/rill/${version}/${zipFileName}`;
    const checksumUrl = `https://${CDN_BASE}/rill/${version}/checksums.txt`;

    const tempDir = path.join(os.tmpdir(), 'rill-cli-install');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const zipPath = path.join(tempDir, zipFileName);
    const checksumsPath = path.join(tempDir, 'checksums.txt');
    const binaryPath = path.join(tempDir, binaryName);
    const targetPath = path.join(__dirname, '..', 'node_modules', '.bin', binaryName);

    // Ensure .bin directory exists
    const binDir = path.join(__dirname, '..', 'node_modules', '.bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    // Download the zip file
    console.log(`Downloading binary: ${binaryUrl}`);
    await downloadFile(binaryUrl, zipPath);

    // Download the checksum file
    console.log(`Downloading checksum: ${checksumUrl}`);
    await downloadFile(checksumUrl, checksumsPath);

    // Verify checksum
    console.log('Verifying SHA256 checksum...');
    const expectedChecksum = await parseChecksums(checksumsPath, platform);
    verifyChecksum(zipPath, expectedChecksum);
    console.log('Checksum verified successfully');

    // Extract the zip file
    console.log(`Unpacking ${zipFileName}...`);
    try {
      // Use unzip command (should be available on Unix-like systems)
      execSync(`unzip -q "${zipPath}" -d "${tempDir}"`, { stdio: 'inherit' });
    } catch (error) {
      // Fallback: try using Node.js built-in capabilities or a library
      // For now, we'll require unzip to be available
      throw new Error(
        'unzip command not available. Please install unzip or install Rill CLI manually.'
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

    // Copy to node_modules/.bin using install command (like the official script)
    try {
      execSync(`install "${binaryPath}" "${targetPath}"`, { stdio: 'inherit' });
    } catch (error) {
      // Fallback to copyFileSync if install command fails
      fs.copyFileSync(binaryPath, targetPath);
      fs.chmodSync(targetPath, 0o755);
    }

    console.log(`Rill CLI installed successfully to ${targetPath}`);

    // Test the installed binary
    try {
      const versionOutput = execSync(`"${targetPath}" version`, { encoding: 'utf8' });
      console.log(`Installed: ${versionOutput.trim()}`);
    } catch (error) {
      console.warn('Could not verify installed binary version');
    }

    // Cleanup
    fs.unlinkSync(zipPath);
    fs.unlinkSync(checksumsPath);
    if (fs.existsSync(binaryPath)) {
      fs.unlinkSync(binaryPath);
    }
  } catch (error) {
    console.error('Failed to install Rill CLI:', error);
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
