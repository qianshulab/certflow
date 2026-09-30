import test from 'node:test';
import assert from 'node:assert/strict';
import { ACME_DIAGNOSTICS, readAcmeDiagnostic } from '../src/acme-diagnostics.mjs';

const privateText = 'example.private DNSPOD_API_TOKEN=do-not-disclose challenge-value=private-marker';
const failure = (message) => `2026/09/30 [INFO] Waiting for DNS record propagation.\nCould not obtain certificates:\n[${privateText}] ${message}`;

test('ACME failures map only recognized problem types and DNS-01 terminal errors to fixed messages', () => {
  const cases = [
    ['urn:ietf:params:acme:error:rateLimited :: too many certificates', 'RATE_LIMITED'],
    ['urn:ietf:params:acme:error:caa :: CAA policy', 'CAA_FORBIDDEN'],
    ['urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up TXT', 'NXDOMAIN'],
    ["time limit exceeded: last error: unexpected response code 'SERVFAIL'", 'SERVFAIL'],
    ['propagation: time limit exceeded: last error: read udp: i/o timeout', 'PROPAGATION_TIMEOUT'],
    ['time limit exceeded: last error: could not find authoritative NS', 'PROPAGATION_TIMEOUT'],
    ['did not return the expected TXT record', 'TXT_MISMATCH'],
    ['urn:ietf:params:acme:error:accountDoesNotExist', 'ACCOUNT'],
    ['urn:ietf:params:acme:error:externalAccountRequired', 'ACCOUNT'],
    ['urn:ietf:params:acme:error:invalidContact', 'ACCOUNT'],
    ['urn:ietf:params:acme:error:unauthorized', 'UNAUTHORIZED'],
    ['urn:ietf:params:acme:error:connection', 'VALIDATION_CONNECTION'],
    ['urn:ietf:params:acme:error:dns', 'DNS_QUERY'],
    ['Post https://acme.example/directory: context deadline exceeded', 'NETWORK'],
  ];
  for (const [raw, code] of cases) {
    const diagnostic = readAcmeDiagnostic(failure(raw));
    assert.equal(diagnostic, ACME_DIAGNOSTICS[code], raw);
    assert.equal(diagnostic.includes(privateText), false);
    assert.equal(diagnostic.includes('do-not-disclose'), false);
  }
});

test('informational progress, unknown errors and misleading prefixes are not guessed', () => {
  for (const text of [
    '', privateText, '[INFO] acme: Waiting for DNS record propagation.',
    'Could not obtain certificates: no solver for custom challenge',
    'Could not obtain certificates: urn:ietf:params:acme:error:rateLimitedExtra',
    'Could not obtain certificates: urn:ietf:params:acme:error:caa_fake',
  ]) assert.equal(readAcmeDiagnostic(text), null, text);
  assert.equal(readAcmeDiagnostic(null), null);
  const earlierWarning = 'warning: urn:ietf:params:acme:error:rateLimited\nCould not obtain certificates: unrelated failure';
  assert.equal(readAcmeDiagnostic(earlierWarning), null, 'only the final lego failure section is classified');
});
