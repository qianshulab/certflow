"""Isolated pull-client regression tests. No real server, credentials, DNS, or ACME."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'certflow-pull.py'
SPEC = importlib.util.spec_from_file_location('certflow_pull', SCRIPT)
pull = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pull)
OPENSSL = os.environ.get('CERTFLOW_TEST_OPENSSL', 'openssl')
TOKEN = 'cfp_' + 'A' * 43  # Synthetic format-valid test value; never a live credential.


def zip_bytes(contents, extra=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in contents.items():
            archive.writestr(name, value)
        if extra:
            archive.writestr(*extra)
    return output.getvalue()


class PullTests(unittest.TestCase):
    def test_openssl_dates_accept_crlf_without_platform_timezone_parsing(self):
        details = 'notBefore=Sep 30 11:20:00 2026 GMT\r\nnotAfter=Dec 29 11:20:00 2026 GMT\r\n'
        self.assertEqual(pull.certificate_date(details, 'notBefore').isoformat(), '2026-09-30T11:20:00+00:00')
        self.assertEqual(pull.certificate_date(details, 'notAfter').isoformat(), '2026-12-29T11:20:00+00:00')
        with self.assertRaises(pull.PullError):
            pull.certificate_date('notBefore=Sep 30 11:20:00 2026 PST\r\n', 'notBefore')

    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix='.certflow-pull-tls-', dir=Path.home())
        cls.tls = Path(cls.fixture.name) / 'localhost.pem'
        result = subprocess.run([OPENSSL, 'req', '-new', '-x509', '-key', str(ROOT / 'test/fixtures/server-key.test.txt'),
                                 '-out', str(cls.tls), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if result.returncode:
            raise RuntimeError('Failed to create the local HTTPS test certificate.')

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.certflow-pull-test-', dir=Path.home())
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.target = self.directory / 'target'
        self.key = (ROOT / 'test/fixtures/server-key.test.txt').read_bytes()
        self.cert = (ROOT / 'test/fixtures/server-cert.test.txt').read_bytes()
        self.contents = {'cert.pem': self.cert, 'chain.pem': b'', 'fullchain.pem': self.cert, 'privkey.pem': self.key}
        self.domains = {'example.com', '*.example.com'}

    def assert_symlinks_available(self):
        try:
            link = self.directory / 'symlink-check'
            os.symlink('target', link, target_is_directory=True)
            link.unlink()
        except OSError:
            if os.name == 'posix':
                raise
            self.skipTest('Windows host cannot create directory symlinks; Linux CI exercises transactions.')

    @contextlib.contextmanager
    def server(self, data=None, redirect=None):
        records = []
        body = zip_bytes(self.contents) if data is None else data
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                records.append({'path': self.path, 'authorized': self.headers.get('Authorization') == 'Bearer ' + TOKEN})
                self.send_response(302 if redirect else 200)
                if redirect:
                    self.send_header('Location', redirect)
                self.send_header('Content-Type', 'application/zip')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.tls), str(ROOT / 'test/fixtures/server-key.test.txt'))
        http.socket = context.wrap_socket(http.socket, server_side=True)
        thread = threading.Thread(target=lambda: http.serve_forever(poll_interval=0.02), daemon=True)
        thread.start()
        try:
            yield 'https://localhost:' + str(http.server_port), records
        finally:
            http.shutdown()
            http.server_close()
            thread.join(timeout=5)

    def cli(self, server, *extra, ca=True):
        env = {key: value for key, value in os.environ.items() if not key.startswith('CERTFLOW_PULL_TOKEN')}
        env['CERTFLOW_PULL_TOKEN'] = TOKEN
        args = [sys.executable, str(SCRIPT), '--server', server, '--job', 'job', '--domain', 'example.com', '--domain', '*.example.com',
                '--target', str(self.target), '--openssl', OPENSSL]
        if ca:
            args += ['--ca-bundle', str(self.tls)]
        result = subprocess.run(args + list(extra), capture_output=True, env=env, timeout=30)
        self.assertNotIn(TOKEN.encode(), result.stdout + result.stderr)
        self.assertNotIn(self.key, result.stdout + result.stderr)
        return result

    def test_real_https_install_unchanged_and_header_only_no_secret_logging(self):
        self.assert_symlinks_available()
        count = self.directory / 'count'
        check = [sys.executable, '-c', 'import os,sys;sys.exit(any(k.startswith("CERTFLOW_PULL_TOKEN") for k in os.environ))']
        reload = [sys.executable, '-c', 'from pathlib import Path; p=Path(__import__("sys").argv[1]); p.write_text(str(int(p.read_text())+1) if p.exists() else "1")', str(count)]
        with self.server() as (url, records):
            result = self.cli(url, '--check-command', json.dumps(check), '--reload-command', json.dumps(reload))
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual((self.target / 'current/fullchain.pem').read_bytes(), self.cert)
            self.assertEqual((self.target / 'current/privkey.pem').read_bytes(), self.key)
            self.assertEqual(count.read_text(), '1')
            selection = os.readlink(self.target / 'current')
            again = self.cli(url, '--check-command', json.dumps(check), '--reload-command', json.dumps(reload))
            self.assertEqual(again.returncode, 0, again.stderr.decode())
            self.assertIn(b'unchanged', again.stdout)
            self.assertEqual(os.readlink(self.target / 'current'), selection)
            self.assertEqual(count.read_text(), '1', 'unchanged certificates must not reload services')
            self.assertEqual(records, [{'path': '/api/pull/job/bundle.zip', 'authorized': True}] * 2)
        self.assertFalse((self.target / '.transaction.json').exists())
        if os.name == 'posix':
            self.assertEqual((self.target / 'current/privkey.pem').stat().st_mode & 0o777, 0o600)

    def test_https_trust_and_redirect_fail_closed(self):
        with self.server() as (url, records):
            failed = self.cli(url, ca=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(records, [])
        with self.server(redirect='https://localhost:1/steal') as (url, records):
            failed = self.cli(url)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn(b'redirected', failed.stderr)
            self.assertEqual(len(records), 1)
        for origin in ['http://localhost:1', 'https://user:password@localhost', 'https://localhost?token=secret']:
            with self.assertRaises(pull.PullError):
                pull.bundle_url(origin, 'job')

    def test_zip_traversal_duplicate_symlink_oversize_and_malformed_are_rejected(self):
        bad = [zip_bytes(self.contents, ('../privkey.pem', b'secret')), b'not-a-zip']
        with mock.patch('warnings.warn'):
            bad.append(zip_bytes(self.contents, ('privkey.pem', b'duplicate')))
        oversized = dict(self.contents, **{'chain.pem': b'x' * (pull.MAX_FILE + 1)})
        bad.append(zip_bytes(oversized))
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for name, value in self.contents.items():
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, value)
        bad.append(output.getvalue())
        for archive in bad:
            with self.assertRaises(pull.PullError):
                pull.unpack_bundle(archive)
        self.assertEqual(pull.unpack_bundle(zip_bytes(self.contents)), self.contents)

    def test_key_domain_chain_and_expired_certificates_fail_before_switch(self):
        self.assert_symlinks_available()
        with pull.target_lock(self.target):
            variants = [(dict(self.contents, **{'privkey.pem': (ROOT / 'test/fixtures/other-key.test.txt').read_bytes()}), self.domains),
                        (self.contents, {'example.com'}), (dict(self.contents, **{'fullchain.pem': b''}), self.domains)]
            for contents, domains in variants:
                with self.assertRaises(pull.PullError):
                    pull.install_bundle(self.target, contents, domains, OPENSSL)
                self.assertFalse(os.path.lexists(self.target / 'current'))
            original_run = pull.run_command
            def expired(argv, capture=False):
                if '-dates' in argv:
                    return b'notBefore=Jan  1 00:00:00 2000 GMT\nnotAfter=Jan  1 00:00:00 2001 GMT\nDNS:example.com, DNS:*.example.com\n'
                return original_run(argv, capture)
            with mock.patch.object(pull, 'run_command', side_effect=expired):
                with self.assertRaisesRegex(pull.PullError, 'not currently valid'):
                    pull.install_bundle(self.target, self.contents, self.domains, OPENSSL)

    def test_check_and_reload_failure_restore_old_selection_and_keep_all_versions(self):
        self.assert_symlinks_available()
        with pull.target_lock(self.target):
            pull.install_bundle(self.target, self.contents, self.domains, OPENSSL)
            previous = os.readlink(self.target / 'current')
            changed = dict(self.contents, **{'chain.pem': self.cert, 'fullchain.pem': self.cert + self.cert})
            with self.assertRaisesRegex(pull.PullError, 'previous certificate selection was restored'):
                pull.install_bundle(self.target, changed, self.domains, OPENSSL, check=[sys.executable, '-c', 'raise SystemExit(2)'])
            self.assertEqual(os.readlink(self.target / 'current'), previous)
            self.assertFalse((self.target / '.transaction.json').exists())
            count = self.directory / 'reload-count'
            reload = [sys.executable, '-c', 'import sys;from pathlib import Path;p=Path(sys.argv[1]);n=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(n));sys.exit(1 if n==1 else 0)', str(count)]
            with self.assertRaisesRegex(pull.PullError, 'previous certificate selection was restored'):
                pull.install_bundle(self.target, changed, self.domains, OPENSSL, check=[sys.executable, '-c', 'pass'], reload=reload)
            self.assertEqual(os.readlink(self.target / 'current'), previous)
            self.assertEqual(count.read_text(), '2', 'failed reload must be followed by restoring the old service configuration')
            self.assertEqual(len(list((self.target / 'versions').iterdir())), 2)
            self.assertFalse((self.target / '.transaction.json').exists())

    def test_failed_rollback_or_interrupted_checkpoint_blocks_future_install(self):
        self.assert_symlinks_available()
        with pull.target_lock(self.target):
            pull.install_bundle(self.target, self.contents, self.domains, OPENSSL)
            changed = dict(self.contents, **{'chain.pem': self.cert, 'fullchain.pem': self.cert + self.cert})
            with self.assertRaisesRegex(pull.PullError, 'service recovery needs review'):
                pull.install_bundle(self.target, changed, self.domains, OPENSSL, check=[sys.executable, '-c', 'pass'], reload=[sys.executable, '-c', 'raise SystemExit(2)'])
            self.assertTrue((self.target / '.transaction.json').is_file())
            with mock.patch.object(pull, 'run_command', side_effect=AssertionError('must not execute')):
                with self.assertRaisesRegex(pull.PullError, 'interrupted installation needs review'):
                    pull.install_bundle(self.target, self.contents, self.domains, OPENSSL)

    @unittest.skipUnless(os.name == 'posix', 'Cross-process crash durability uses POSIX directory symlinks.')
    def test_process_death_after_switch_retains_checkpoint_and_prevents_network_retry(self):
        # The child exits immediately after the real atomic symlink switch. No mocked installer result.
        child = '''import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('pull',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
target=Path(sys.argv[2]);fixtures=Path(sys.argv[3]);cert=(fixtures/'server-cert.test.txt').read_bytes()
contents={'cert.pem':cert,'chain.pem':b'','fullchain.pem':cert,'privkey.pem':(fixtures/'server-key.test.txt').read_bytes()}
original=m.switch_generation
def crash(target,generation):
    original(target,generation)
    os._exit(77)
m.switch_generation=crash
with m.target_lock(target):m.install_bundle(target,contents,{'example.com','*.example.com'},sys.argv[4])
'''
        result = subprocess.run([sys.executable, '-B', '-c', child, str(SCRIPT), str(self.target), str(ROOT / 'test/fixtures'), OPENSSL],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        self.assertEqual(result.returncode, 77, result.stderr.decode())
        self.assertTrue((self.target / '.transaction.json').is_file())
        self.assertTrue((self.target / 'current').is_symlink())
        with self.server() as (url, records):
            fresh = self.cli(url)
            self.assertNotEqual(fresh.returncode, 0)
            self.assertIn(b'interrupted installation', fresh.stderr)
            self.assertEqual(records, [], 'a stale transaction must block before downloading or reloading')

    def test_cleanup_durability_failure_keeps_a_recovery_checkpoint(self):
        self.assert_symlinks_available()
        with pull.target_lock(self.target):
            pull.install_bundle(self.target, self.contents, self.domains, OPENSSL)
            changed = dict(self.contents, **{'chain.pem': self.cert, 'fullchain.pem': self.cert + self.cert})
            original_remove = pull.remove_journal
            def fail_after_removal(target):
                original_remove(target)
                raise OSError('injected directory sync failure')
            with mock.patch.object(pull, 'remove_journal', side_effect=fail_after_removal):
                with self.assertRaisesRegex(pull.PullError, 'service recovery needs review'):
                    pull.install_bundle(self.target, changed, self.domains, OPENSSL)
            self.assertTrue((self.target / '.transaction.json').is_file())

    def test_concurrent_process_is_locked_and_linked_target_is_rejected(self):
        with pull.target_lock(self.target):
            result = self.cli('https://localhost:1')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b'already running', result.stderr)
        self.assert_symlinks_available()
        linked = self.directory / 'linked'
        os.symlink(self.target, linked, target_is_directory=True)
        with self.assertRaises(pull.PullError):
            with pull.target_lock(linked):
                self.fail('a linked target must never be opened')

    def test_private_token_files_and_subprocess_secret_scrubbing(self):
        tokenfile = self.directory / 'token'
        pull.write_private(tokenfile, TOKEN.encode() + b'\n')
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(pull.read_token(str(tokenfile)) == TOKEN)
        with mock.patch.dict(os.environ, {'CERTFLOW_PULL_TOKEN': TOKEN}):
            with self.assertRaises(pull.PullError):
                pull.read_token(str(tokenfile))
            output = pull.run_command([sys.executable, '-c', 'import os;print(any(k.startswith("CERTFLOW_PULL_TOKEN") for k in os.environ))'], capture=True)
            self.assertEqual(output.strip(), b'False')
        if os.name == 'posix':
            tokenfile.chmod(0o644)
            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(pull.PullError):
                    pull.read_token(str(tokenfile))

    @unittest.skipUnless(os.name == 'posix', 'POSIX ancestor ownership and mode enforcement.')
    def test_writable_ancestors_cannot_redirect_target_token_or_custom_ca(self):
        shared = self.directory / 'shared'
        shared.mkdir(mode=0o700)
        token = shared / 'token'
        pull.write_private(token, TOKEN.encode())
        shared.chmod(0o777)
        try:
            with self.assertRaisesRegex(pull.PullError, 'ancestors'):
                with pull.target_lock(shared / 'target'):
                    self.fail('must not create a target in a shared writable parent')
            with mock.patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(pull.PullError, 'ancestors'):
                    pull.read_token(str(token))
            with self.assertRaisesRegex(pull.PullError, 'ancestors'):
                pull.download_bundle('https://localhost:1', TOKEN, str(token))
            self.assertFalse((shared / 'target').exists())
            with self.assertRaisesRegex(pull.PullError, 'ancestors'):
                with pull.target_lock(Path('/tmp') / ('certflow-rejected-' + str(os.getpid()))):
                    self.fail('sticky /tmp must also be rejected')
        finally:
            shared.chmod(0o700)


if __name__ == '__main__':
    unittest.main(verbosity=2)
