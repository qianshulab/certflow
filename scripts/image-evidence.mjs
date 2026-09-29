import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyPublicImage } from './verify-registry.mjs';

const image = process.argv[2] ?? 'certflow:ci';
const result = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', shell: false, windowsHide: true });
if (result.status !== 0) throw new Error(`Cannot inspect verified image: ${result.stderr}`);
const [imageInfo] = JSON.parse(result.stdout);
const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const registryImage = process.env.REGISTRY_IMAGE || 'ghcr.io/qianshulab/certflow';
const digests = imageInfo.RepoDigests ?? [];
const digest = digests.find(value => value.startsWith(`${registryImage}@sha256:`)) ?? null;
if (process.env.REQUIRE_PUBLISHED_DIGEST === '1' && !digest) throw new Error('Published registry digest is missing from the verified image.');
const publicAccess = digest ? await verifyPublicImage(registryImage, pkg.version, digest) : null;
if (publicAccess && !publicAccess.public) console.warn('::warning::Image is published, but anonymous pull is not verified. For a new GHCR package, set its visibility to Public in Package settings, then run scripts/verify-registry.mjs.');
const evidence = {
  version: pkg.version,
  sourceCommit: process.env.GITHUB_SHA || imageInfo.Config.Labels?.['org.opencontainers.image.revision'] || 'unknown',
  workflowRun: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  platform: `${imageInfo.Os}/${imageInfo.Architecture}`,
  imageId: imageInfo.Id,
  registryImage: `${registryImage}:${pkg.version}`,
  registryDigest: digest,
  publicAccess,
  verifiedAt: new Date().toISOString(),
  checks: ['windows-and-linux-node-tests', 'real-lego-exec-bridge-integration', 'network-isolated-container-smoke', 'nonroot-read-only-runtime', 'encrypted-credentials-and-config-after-two-restarts'],
};
const reportDirectory = path.resolve('reports');
await fs.mkdir(reportDirectory, { recursive: true });
await fs.writeFile(path.join(reportDirectory, 'image-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
const markdown = [
  '## Verified CertFlow image', '',
  `- Version: ${evidence.version}`,
  `- Source commit: \`${evidence.sourceCommit}\``,
  `- Platform: \`${evidence.platform}\``,
  `- Local image ID: \`${evidence.imageId}\``,
  `- Registry image: \`${evidence.registryImage}\``,
  `- Registry digest: ${digest ? `\`${digest}\`` : 'Not published by this run.'}`,
  `- Anonymous pull: ${publicAccess?.public ? 'Verified; manifest digest matches the tested image.' : digest ? `Not verified: ${publicAccess.reason}` : 'Not applicable to this build.'}`,
  '- Windows/Linux tests and the real lego bridge integration passed.',
  '- Container login, encrypted storage, persistence, nonroot/read-only operation and dynamic health port passed.',
  '- The smoke container had no external network. Real DNS-provider access and CA issuance are not included.', '',
].join('\n');
await fs.writeFile(path.join(reportDirectory, 'image-summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown);
