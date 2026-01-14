/**
 * Script to install Rill CLI binary
 * Downloads and installs the Rill CLI for the current platform
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const RILL_VERSION = 'latest'; // or specify a version like 'v0.40.0'
const RILL_BASE_URL = 'https://github.com/rilldata/rill/releases';

function getPlatformInfo() {
  const platform = os.platform();
  const arch = os.arch();

  let platformName;
  let archName;

  if (platform === 'linux') {
    platformName = 'linux';
  } else if (platform === 'darwin') {
    platformName = 'darwin';
  } else if (platform === 'win32') {
    platformName = 'windows';
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  if (arch === 'x64') {
    archName = 'amd64';
  } else if (arch === 'arm64') {
    archName = 'arm64';
  } else {
    throw new Error(`Unsupported architecture: ${arch}`);
  }

  return { platformName, archName };
}

async function getLatestVersion() {
  return new Promise((resolve, reject) => {
    https.get(
      'https://api.github.com/repos/rilldata/rill/releases/latest',
      {
        headers: {
          'User-Agent': 'rill-cli-installer',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            resolve(release.tag_name.replace('v', ''));
          } catch (error) {
            reject(error);
          }
        });
      }
    ).on('error', reject);
  });
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

async function installRillCLI() {
  try {
    const { platformName, archName } = getPlatformInfo();
    const version =
      RILL_VERSION === 'latest'
        ? await getLatestVersion()
        : RILL_VERSION.replace('v', '');

    console.log(`Installing Rill CLI ${version} for ${platformName}/${archName}`);

    const binaryName = platformName === 'windows' ? 'rill.exe' : 'rill';
    const downloadUrl = `${RILL_BASE_URL}/download/v${version}/rill_${version}_${platformName}_${archName}.tar.gz`;

    const tempDir = path.join(os.tmpdir(), 'rill-cli-install');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tarPath = path.join(tempDir, `rill_${version}.tar.gz`);
    const binaryPath = path.join(tempDir, binaryName);
    const targetPath = path.join(__dirname, '..', 'node_modules', '.bin', binaryName);

    // Ensure .bin directory exists
    const binDir = path.join(__dirname, '..', 'node_modules', '.bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    // Download the tarball
    console.log(`Downloading from ${downloadUrl}`);
    await downloadFile(downloadUrl, tarPath);

    // Extract the tarball
    console.log('Extracting tarball...');
    if (platformName === 'windows') {
      // On Windows, we might need a different approach
      // For now, we'll try to use tar if available, or skip extraction
      try {
        execSync(`tar -xzf "${tarPath}" -C "${tempDir}"`, { stdio: 'inherit' });
      } catch (error) {
        console.warn('tar command failed, trying alternative method...');
        // You might need to use a Node.js tar library here
        throw new Error('Windows tar extraction not implemented. Please install Rill CLI manually.');
      }
    } else {
      execSync(`tar -xzf "${tarPath}" -C "${tempDir}"`, { stdio: 'inherit' });
    }

    // Find the extracted binary
    const extractedBinary = path.join(tempDir, binaryName);
    if (!fs.existsSync(extractedBinary)) {
      // Sometimes the binary is in a subdirectory
      const files = fs.readdirSync(tempDir);
      const foundBinary = files.find((f) => f === binaryName || f.endsWith(binaryName));
      if (foundBinary) {
        fs.renameSync(path.join(tempDir, foundBinary), binaryPath);
      } else {
        throw new Error(`Binary not found in extracted files: ${files.join(', ')}`);
      }
    } else {
      fs.renameSync(extractedBinary, binaryPath);
    }

    // Make binary executable (Unix-like systems)
    if (platformName !== 'windows') {
      fs.chmodSync(binaryPath, 0o755);
    }

    // Copy to node_modules/.bin
    fs.copyFileSync(binaryPath, targetPath);
    if (platformName !== 'windows') {
      fs.chmodSync(targetPath, 0o755);
    }

    console.log(`Rill CLI installed successfully to ${targetPath}`);

    // Cleanup
    fs.unlinkSync(tarPath);
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
