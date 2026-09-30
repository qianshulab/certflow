#!/usr/bin/env python3
"""Pull a scoped CertFlow bundle over HTTPS into an atomic, versioned certificate directory.

Python 3 + OpenSSL; no third-party Python packages. See docs/remote-pull.md.
Service configuration must point to TARGET/current/fullchain.pem and privkey.pem.
"""
import argparse
import contextlib
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

FILES = ('cert.pem', 'chain.pem', 'fullchain.pem', 'privkey.pem')
MAX_ZIP = 4 * 1024 * 1024
MAX_FILE = 1024 * 1024
TOKEN_PATTERN = re.compile(r'cfp_[A-Za-z0-9_-]{43}\Z')
GENERATION = re.compile(r'versions/[a-f0-9]{64}\Z')
PEM = re.compile(rb'-----BEGIN CERTIFICATE-----\s+[^-]+-----END CERTIFICATE-----')


class PullError(Exception):
    """Safe, fixed diagnostic: never includes remote output, argv, token, or private key."""


def sync_directory(directory):
    if os.name == 'posix':
        fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def inspect_private(info, directory=False):
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise PullError('Refusing a redirected or non-regular storage path.')
    if not directory and info.st_nlink != 1:
        raise PullError('Refusing a linked storage file.')
    if os.name == 'posix' and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
        raise PullError('Storage must be owned by this user with directory mode 700 and file mode 600.')


def inspect_ancestors(filename):
    for ancestor in reversed(Path(os.path.abspath(filename)).parents):
        info = ancestor.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise PullError('Storage paths must not traverse symbolic links.')
        if os.name == 'posix' and (info.st_mode & 0o022 or info.st_uid not in (0, os.getuid())):
            raise PullError('Storage ancestors must be owned by root or this user and must not be writable by other users. Do not use /tmp or shared writable directories.')


def private_directory(directory, create=False):
    if create:
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            pass
    inspect_private(directory.lstat(), directory=True)


def read_private(filename, maximum=MAX_FILE):
    filename = Path(os.path.abspath(filename))
    inspect_ancestors(filename)
    before = filename.lstat()
    inspect_private(before)
    if before.st_size > maximum:
        raise PullError('A storage file exceeds the size limit.')
    fd = os.open(filename, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        after = os.fstat(fd)
        inspect_private(after)
        if (after.st_ino, after.st_dev) != (before.st_ino, before.st_dev):
            raise PullError('Storage changed during validation.')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            value = stream.read(maximum + 1)
        if len(value) > maximum:
            raise PullError('A storage file exceeds the size limit.')
        return value
    finally:
        os.close(fd)


def write_private(filename, value):
    fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def read_token(token_file=None):
    token_file = token_file or os.environ.get('CERTFLOW_PULL_TOKEN_FILE')
    supplied = os.environ.get('CERTFLOW_PULL_TOKEN')
    if token_file and supplied:
        raise PullError('Use either a token file or CERTFLOW_PULL_TOKEN, not both.')
    if token_file:
        supplied = read_private(Path(token_file), 128).decode('ascii').strip()
    if not supplied or not TOKEN_PATTERN.fullmatch(supplied):
        raise PullError('A valid distribution token is required in a private file or environment variable.')
    return supplied


def bundle_url(server, job):
    parsed = urllib.parse.urlsplit(server)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or
            parsed.password is not None or parsed.path not in ('', '/') or parsed.query or parsed.fragment or
            re.search(r'[\x00-\x20\x7f]', server) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', job)):
        raise PullError('Use an HTTPS server origin and a valid job ID.')
    return server.rstrip('/') + '/api/pull/' + job + '/bundle.zip'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise PullError('The server redirected the request; use its final HTTPS origin.')


def download_bundle(url, token, ca_bundle=None):
    if ca_bundle:
        ca_bundle = os.path.abspath(ca_bundle)
        inspect_ancestors(Path(ca_bundle))
        info = Path(ca_bundle).lstat()
        if not stat.S_ISREG(info.st_mode) or os.name == 'posix' and (info.st_mode & 0o022 or info.st_uid not in (0, os.getuid())):
            raise PullError('The custom HTTPS CA bundle must be a regular file protected from changes by other users.')
    context = ssl.create_default_context(cafile=ca_bundle)
    # Disable ambient proxies so a workstation's unrelated proxy configuration cannot intercept tokens.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=context))
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/zip'})
    started = time.monotonic()
    try:
        with opener.open(request, timeout=30) as response:
            if response.status != 200:
                raise PullError('The certificate server did not return a bundle.')
            length = response.headers.get('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > MAX_ZIP):
                raise PullError('The bundle exceeds the download size limit.')
            chunks, total = [], 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ZIP or time.monotonic() - started > 120:
                    raise PullError('The bundle exceeded its size or download time limit.')
                chunks.append(chunk)
            return b''.join(chunks)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise PullError('Authorization failed. Check the token, expiry and job scope.') from None
        if error.code == 429:
            raise PullError('The server rate limit was reached; retry later.') from None
        raise PullError('The certificate server refused this download.') from None
    except (urllib.error.URLError, TimeoutError, ssl.SSLError, OSError):
        raise PullError('HTTPS connection failed. Check the server address, certificate trust and network.') from None


def unpack_bundle(value):
    if len(value) > MAX_ZIP:
        raise PullError('The bundle exceeds the download size limit.')
    try:
        with zipfile.ZipFile(io.BytesIO(value)) as archive:
            entries = archive.infolist()
            if len(entries) != len(FILES) or {entry.filename for entry in entries} != set(FILES):
                raise PullError('The ZIP must contain exactly the four expected PEM files, without folders or duplicates.')
            result = {}
            for entry in entries:
                mode = entry.external_attr >> 16
                if (entry.file_size > MAX_FILE or entry.flag_bits & 1 or entry.is_dir() or
                        stat.S_IFMT(mode) not in (0, stat.S_IFREG) or
                        entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                    raise PullError('The ZIP contains an unsafe or oversized entry.')
                with archive.open(entry) as stream:
                    content = stream.read(MAX_FILE + 1)
                if len(content) > MAX_FILE or len(content) != entry.file_size:
                    raise PullError('The ZIP contains an invalid file size.')
                result[entry.filename] = content
            return result
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, ValueError, EOFError):
        raise PullError('The downloaded ZIP is invalid.') from None


def normalize_domains(domains):
    result = set()
    for domain in domains:
        wildcard = domain.startswith('*.')
        base = domain[2:] if wildcard else domain
        try:
            base = base.encode('idna').decode('ascii').lower()
        except UnicodeError:
            raise PullError('Expected domains must be valid DNS names.') from None
        labels = base.split('.')
        if (len(base) > 253 or len(labels) < 2 or not re.search(r'[a-z]', labels[-1]) or
                any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels)):
            raise PullError('Expected domains must be valid DNS names.')
        result.add(('*.' if wildcard else '') + base)
    if not result or len(result) > 100:
        raise PullError('Specify the complete expected domain set using --domain.')
    return result


def command_argv(value):
    if value is None:
        return None
    try:
        result = json.loads(value)
    except (ValueError, TypeError):
        raise PullError('Commands must be JSON arrays of arguments.') from None
    if (not isinstance(result, list) or not result or len(result) > 64 or
            any(not isinstance(part, str) or not part or len(part) > 4096 or '\x00' in part for part in result)):
        raise PullError('Commands must be JSON arrays of nonempty arguments.')
    return result


def run_command(argv, capture=False):
    env = {key: value for key, value in os.environ.items() if not key.startswith('CERTFLOW_PULL_TOKEN')}
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, shell=False, env=env, start_new_session=os.name == 'posix')
    try:
        output, _ = process.communicate(timeout=60)
    except BaseException:
        if os.name == 'posix':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        process.wait()
        raise PullError('A local validation or reload command timed out or was interrupted.') from None
    if process.returncode != 0:
        raise PullError('A local validation or reload command failed; its output was suppressed to protect secrets.')
    return output or b''


def certificate_blocks(value):
    blocks = PEM.findall(value)
    if PEM.sub(b'', value).strip():
        raise PullError('Certificate files must contain only PEM certificate blocks.')
    return [re.sub(rb'\s+', b'', block) for block in blocks]


def validate_certificate(directory, contents, domains, openssl='openssl'):
    certs = certificate_blocks(contents['cert.pem'])
    chain = certificate_blocks(contents['chain.pem'])
    fullchain = certificate_blocks(contents['fullchain.pem'])
    if len(certs) != 1 or fullchain != certs + chain:
        raise PullError('The leaf certificate and full chain do not agree.')
    cert = str(directory / 'cert.pem')
    pub_cert = run_command([openssl, 'x509', '-in', cert, '-noout', '-pubkey'], capture=True)
    pub_key = run_command([openssl, 'pkey', '-in', str(directory / 'privkey.pem'), '-passin', 'pass:', '-pubout'], capture=True)
    if pub_cert.strip() != pub_key.strip():
        raise PullError('The certificate does not match its private key.')
    details = run_command([openssl, 'x509', '-in', cert, '-noout', '-dates', '-ext', 'subjectAltName'], capture=True).decode('ascii')
    sans = set(re.findall(r'DNS:([^,\s]+)', details))
    if sans != domains or re.search(r'(?:IP Address|URI|email):', details):
        raise PullError('The certificate does not match the complete expected domain set.')
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        dates = [datetime.datetime.strptime(re.search(name + r'=(.+)', details).group(1), '%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
                 for name in ('notBefore', 'notAfter')]
    except (AttributeError, ValueError):
        raise PullError('The certificate validity dates could not be verified.') from None
    if not dates[0] <= now < dates[1]:
        raise PullError('The certificate is not currently valid.')
    # Parse every chain certificate as well; trust/issuance policy is enforced by the central server.
    if chain:
        run_command([openssl, 'crl2pkcs7', '-nocrl', '-certfile', str(directory / 'chain.pem'), '-outform', 'DER'], capture=True)


@contextlib.contextmanager
def target_lock(target):
    # Do not follow a symlink in any component of the managed installation path.
    inspect_ancestors(target)
    private_directory(target, create=True)
    lockfile = target / '.pull.lock'
    fd = os.open(lockfile, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        inspect_private(os.fstat(fd))
        try:
            if os.name == 'posix':
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:  # Allows the same regression suite on Windows; deployment support is Linux.
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            raise PullError('Another certificate pull is already running for this target.') from None
        yield
    finally:
        os.close(fd)  # Never unlink flock's inode: unlinking permits a second, independent lock.


def current_generation(target):
    try:
        info = (target / 'current').lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISLNK(info.st_mode):
        raise PullError('The current path must be a CertFlow-managed symbolic link.')
    current = os.readlink(target / 'current')
    if not GENERATION.fullmatch(current):
        raise PullError('The current path points outside the managed versions directory.')
    private_directory(target / current)
    return current


def switch_generation(target, generation):
    if generation is None:
        (target / 'current').unlink()
    else:
        temporary = target / ('.current-' + uuid.uuid4().hex)
        try:
            os.symlink(generation, temporary, target_is_directory=True)
            os.replace(temporary, target / 'current')
        finally:
            if temporary.is_symlink():
                temporary.unlink()
    sync_directory(target)


def remove_journal(target):
    try:
        (target / '.transaction.json').unlink()
    except FileNotFoundError:
        pass
    sync_directory(target)


def install_bundle(target, contents, domains, openssl='openssl', check=None, reload=None):
    """Caller holds target_lock for the whole download/validation/install transaction."""
    if os.path.lexists(target / '.transaction.json'):
        raise PullError('An interrupted installation needs review. Preserve versions and .transaction.json; inspect current and service state before retrying.')
    versions = target / 'versions'
    private_directory(versions, create=True)
    previous = current_generation(target)
    staging = versions / ('.staging-' + uuid.uuid4().hex)
    staging.mkdir(mode=0o700)
    try:
        for filename in FILES:
            write_private(staging / filename, contents[filename])
        validate_certificate(staging, contents, domains, openssl)
        fingerprint = hashlib.sha256()
        for filename in FILES:
            fingerprint.update(filename.encode('ascii') + b'\0' + len(contents[filename]).to_bytes(8, 'big') + contents[filename])
        name = fingerprint.hexdigest()
        generation = 'versions/' + name
        destination = versions / name
        if os.path.lexists(destination):
            private_directory(destination)
            if set(os.listdir(destination)) != set(FILES) or any(read_private(destination / file) != contents[file] for file in FILES):
                raise PullError('A saved certificate version was modified. Preserve it for review.')
        else:
            sync_directory(staging)
            os.rename(staging, destination)
            sync_directory(versions)
        if previous == generation:
            return 'unchanged'
        # Preserve an on-disk checkpoint before switching, so a crash never silently retries deployment.
        checkpoint = json.dumps({'format': 1, 'previous': previous, 'next': generation}).encode('ascii')
        write_private(target / '.transaction.json', checkpoint)
        sync_directory(target)
        reload_attempted = False
        try:
            switch_generation(target, generation)
            if check:
                run_command(check)
            if reload:
                reload_attempted = True
                run_command(reload)
            remove_journal(target)
            return 'installed'
        except BaseException:
            try:
                actual = current_generation(target)
                if actual != previous:
                    if actual != generation:
                        raise PullError('The active certificate changed unexpectedly.')
                    switch_generation(target, previous)
                if reload_attempted:
                    if previous is None:
                        raise PullError('The first service reload failed and there is no previous version.')
                    if check:
                        run_command(check)
                    run_command(reload)
                remove_journal(target)
            except BaseException:
                # A failed directory fsync after journal unlink must not erase the recovery warning.
                if not os.path.lexists(target / '.transaction.json'):
                    try:
                        write_private(target / '.transaction.json', checkpoint)
                        sync_directory(target)
                    except BaseException:
                        pass  # Disk failure itself may prevent a durable marker; never report success.
                raise PullError('Installation failed and service recovery needs review. Preserve versions and .transaction.json, inspect current, then validate and reload the service manually.') from None
            raise PullError('Installation failed. The previous certificate selection was restored; review the local check/reload command before retrying.') from None
    finally:
        if staging.exists():
            for filename in FILES:
                try:
                    (staging / filename).unlink()
                except FileNotFoundError:
                    pass
            staging.rmdir()


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise PullError('Invalid command options. Run --help for the supported arguments; never pass the token as an argument.')


def main(argv=None):
    parser = SafeParser(description=__doc__)
    parser.add_argument('--server', required=True, help='HTTPS origin of the central CertFlow server')
    parser.add_argument('--job', required=True)
    parser.add_argument('--domain', action='append', required=True, help='Expected certificate domain; repeat for every SAN, quote wildcards')
    parser.add_argument('--target', required=True, help='Private managed directory (parent must already exist)')
    parser.add_argument('--token-file', help='Private file, mode 600; alternatively CERTFLOW_PULL_TOKEN_FILE or CERTFLOW_PULL_TOKEN')
    parser.add_argument('--ca-bundle', help='Optional CA bundle for the HTTPS management endpoint')
    parser.add_argument('--openssl', default='openssl')
    parser.add_argument('--check-command', help='JSON argv, e.g. ["nginx","-t"]')
    parser.add_argument('--reload-command', help='JSON argv, e.g. ["nginx","-s","reload"]')
    try:
        args = parser.parse_args(argv)
        url = bundle_url(args.server, args.job)
        domains = normalize_domains(args.domain)
        check, reload = command_argv(args.check_command), command_argv(args.reload_command)
        if reload and not check:
            raise PullError('A reload command requires a check command to validate the selected certificate first.')
        token = read_token(args.token_file)
        target = Path(os.path.abspath(args.target))
        with target_lock(target):
            if os.path.lexists(target / '.transaction.json'):
                raise PullError('An interrupted installation needs review. Preserve versions and .transaction.json and inspect the service before retrying.')
            contents = unpack_bundle(download_bundle(url, token, args.ca_bundle))
            result = install_bundle(target, contents, domains, args.openssl, check, reload)
        print('Certificate unchanged.' if result == 'unchanged' else 'Certificate installed successfully.')
        return 0
    except PullError as error:
        print('CertFlow pull: ' + str(error), file=sys.stderr)
        return 1
    except (Exception, KeyboardInterrupt):
        print('CertFlow pull failed. Check dependencies, private file permissions and target state; remote output and secrets were suppressed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
