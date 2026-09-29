These are intentionally public, self-signed TEST-ONLY certificate/key fixtures.
They are not credentials and must never be deployed or used for real TLS.

`server-cert.test.txt` and `server-key.test.txt` form a matching EC P-256 pair
for `example.com` and `*.example.com`. `other-key.test.txt` deliberately does
not match. `single-domain-cert.test.txt` shares the test key and covers only
`example.com`, allowing HTTP challenge tests to require exact SAN matching.
The certificates last 20 years to keep tests independent of a
short-lived public CA certificate. Tests for validity boundaries pass an
explicit time to certificate validation.

The fixtures have `.txt` extensions so the repository's production key
ignore rules remain in force. OpenSSL and Python cryptography were used once
to generate these fixed fixtures. ZIP interoperability tests use Windows .NET
or Python's standard-library zipfile on Linux. GitHub CI installs the pinned
lego binary so the real bridge integration test cannot silently skip.
