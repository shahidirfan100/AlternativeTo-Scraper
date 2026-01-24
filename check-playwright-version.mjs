/**
 * Validates that the Playwright version in package.json matches the Docker image.
 */
import { readFileSync } from 'fs';

try {
    const dockerfileContent = readFileSync('./Dockerfile', 'utf-8');
    const packageJsonContent = readFileSync('./package.json', 'utf-8');

    // Extract version from Dockerfile
    const dockerMatch = dockerfileContent.match(/apify\/actor-node-playwright-chrome:\d+-(\d+\.\d+\.\d+)/);
    const dockerVersion = dockerMatch ? dockerMatch[1] : null;

    // Extract version from package.json
    const packageJson = JSON.parse(packageJsonContent);
    const packageVersion = packageJson.dependencies?.playwright;

    if (!dockerVersion) {
        console.log('⚠️  Could not extract Playwright version from Dockerfile');
        process.exit(0);
    }

    if (!packageVersion) {
        console.log('⚠️  Playwright not found in package.json dependencies');
        process.exit(0);
    }

    // Clean version strings (remove ^ or ~ prefix)
    const cleanPackageVersion = packageVersion.replace(/^[\^~]/, '');

    if (dockerVersion !== cleanPackageVersion) {
        console.error(`❌ Playwright version mismatch!`);
        console.error(`   Dockerfile: ${dockerVersion}`);
        console.error(`   package.json: ${cleanPackageVersion}`);
        console.error(`   Please update package.json to match Dockerfile.`);
        process.exit(1);
    }

    console.log(`✅ Playwright versions match: ${dockerVersion}`);
} catch (error) {
    console.log('⚠️  Version check skipped:', error.message);
    process.exit(0);
}
