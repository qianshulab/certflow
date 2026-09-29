// Anonymous verification intentionally ignores Docker credentials and GITHUB_TOKEN.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyPublicImage(image, tag, expectedDigest) {
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(image) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('Expected a GHCR image name and a valid tag.');
  const repository = image.slice('ghcr.io/'.length);
  const expected = expectedDigest?.split('@').at(-1);
  if (expected && !/^sha256:[a-f0-9]{64}$/.test(expected)) throw new Error('Expected digest must be SHA-256.');
  let authorization;
  try {
    const tokenUrl = new URL('https://ghcr.io/token');
    tokenUrl.search = new URLSearchParams({ service: 'ghcr.io', scope: `repository:${repository}:pull` }).toString();
    const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(15000) });
    if (!tokenResponse.ok) return { public: false, status: tokenResponse.status, reason: 'Anonymous pull authorization was denied; check package visibility or registry availability.' };
    authorization = (await tokenResponse.json()).token;
    if (typeof authorization !== 'string' || !authorization) return { public: false, reason: 'The registry did not provide anonymous pull authorization.' };
    const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${authorization}`, Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
    });
    if (!response.ok) return { public: false, status: response.status, reason: 'The version manifest cannot be read anonymously; check the tag and package visibility.' };
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > 4 * 1024 * 1024) throw new Error('Registry manifest exceeded the expected size.');
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    const headerDigest = response.headers.get('docker-content-digest');
    if (headerDigest && headerDigest !== digest) throw new Error('Registry digest header does not match the downloaded manifest.');
    if (expected && expected !== digest) throw new Error('Public registry tag does not match the tested image digest.');
    return { public: true, status: response.status, digest: `${image}@${digest}` };
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.message === 'fetch failed') return { public: false, reason: 'Anonymous registry verification could not complete because of a network failure.' };
    throw error;
  } finally { authorization = undefined; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await verifyPublicImage(process.argv[2] ?? 'ghcr.io/qianshulab/certflow', process.argv[3] ?? '0.4.1', process.argv[4]);
  console.log(JSON.stringify(result, null, 2));
  if (!result.public) process.exitCode = 1;
}
