// Dedicated Node preloader for lego's exec provider. Do not import into the app.
import path from 'node:path';
import { createDnsPodClient, dnsPodDiagnostic, loadDnsPodCredentials, runDnsPodChallenge } from './dnspod-token.mjs';

try {
  const [, entry, fqdn, value, ...extra] = process.argv;
  const action = path.basename(entry ?? '');
  if (extra.length || !['present', 'cleanup'].includes(action)) throw new Error('DNSPod bridge 参数无效。');
  const credentials = await loadDnsPodCredentials();
  await runDnsPodChallenge(action, fqdn, value, {
    directory: process.env.CERTFLOW_DNSPOD_STATE_DIR,
    client: createDnsPodClient({ ...credentials, contact: process.env.CERTFLOW_DNSPOD_CONTACT }),
  });
  process.exit(0);
} catch (error) {
  process.stderr.write(`CERTFLOW_DNSPOD_ERROR:${dnsPodDiagnostic(error)}\n`);
  process.exit(1);
}
