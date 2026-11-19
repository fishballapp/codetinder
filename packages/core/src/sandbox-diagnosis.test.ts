import { describe, expect, it } from '@effect/vitest';
import { diagnoseFailure } from './sandbox-diagnosis';

describe('diagnoseFailure', () => {
  it('names the host npm was refused, from the 403 line', () => {
    expect(
      diagnoseFailure(
        [
          'npm error code E403',
          'npm error 403 403 Forbidden - GET https://registry.npmjs.org/vitest - Forbidden',
          'npm error 403 In most cases you or one of your dependencies are requesting a forbidden package.',
        ].join('\n'),
      ),
    ).toEqual({ _tag: 'BlockedHosts', hosts: ['registry.npmjs.org'] });
  });

  it('names the host a proxy refused a tunnel to', () => {
    expect(diagnoseFailure('curl: (56) CONNECT api.example.com:443 failed, response 403')).toEqual({
      _tag: 'BlockedHosts',
      hosts: ['api.example.com'],
    });
  });

  it('names the host that did not resolve', () => {
    expect(
      diagnoseFailure(
        'Error: getaddrinfo ENOTFOUND api.example.com\n    at GetAddrInfoReqWrap.onlookupall',
      ),
    ).toEqual({ _tag: 'BlockedHosts', hosts: ['api.example.com'] });
    expect(diagnoseFailure('getaddrinfo EAI_AGAIN registry.npmjs.org')).toEqual({
      _tag: 'BlockedHosts',
      hosts: ['registry.npmjs.org'],
    });
  });

  it('names a host and port refused a connection, but not this machine', () => {
    expect(diagnoseFailure('Error: connect ECONNREFUSED 10.0.0.5:5432')).toEqual({
      _tag: 'BlockedHosts',
      hosts: ['10.0.0.5'],
    });
    expect(diagnoseFailure('Error: connect ECONNREFUSED 127.0.0.1:5432')).toEqual({
      _tag: 'Unknown',
    });
  });

  it('lists each host once, in the order it first failed', () => {
    expect(
      diagnoseFailure(
        [
          'npm error 403 403 Forbidden - GET https://registry.npmjs.org/a',
          'Error: getaddrinfo ENOTFOUND cdn.example.com',
          'npm error 403 403 Forbidden - GET https://registry.npmjs.org/b',
        ].join('\n'),
      ),
    ).toEqual({ _tag: 'BlockedHosts', hosts: ['registry.npmjs.org', 'cdn.example.com'] });
  });

  it('names the path a write was refused, from Node, coreutils and Go', () => {
    expect(
      diagnoseFailure(
        "npm error rofs Invalid response body while trying to fetch https://registry.npmjs.org/node: EROFS: read-only file system, open '/opt/cache/.npm/_cacache/tmp/c6ab6b05'",
      ),
    ).toEqual({ _tag: 'ReadOnlyPaths', paths: ['/opt/cache/.npm/_cacache/tmp/c6ab6b05'] });
    expect(
      diagnoseFailure("mkdir: cannot create directory '/var/lib/x/.gitlab': Read-only file system"),
    ).toEqual({ _tag: 'ReadOnlyPaths', paths: ['/var/lib/x/.gitlab'] });
    expect(
      diagnoseFailure(
        'Error: could not add the hook: open /work/.git/hooks/commit-msg: read-only file system',
      ),
    ).toEqual({ _tag: 'ReadOnlyPaths', paths: ['/work/.git/hooks/commit-msg'] });
  });

  it('lists each read-only path once, and ignores an EROFS with no path', () => {
    expect(
      diagnoseFailure(
        "EROFS: read-only file system, mkdir '/var/lib/a'\nEROFS: read-only file system, open '/var/lib/b'\nEROFS: read-only file system, mkdir '/var/lib/a'",
      ),
    ).toEqual({ _tag: 'ReadOnlyPaths', paths: ['/var/lib/a', '/var/lib/b'] });
    expect(diagnoseFailure('Error: EROFS: read-only file system')).toEqual({ _tag: 'Unknown' });
  });

  it('prefers a blocked host to a read-only path, and a read-only path to a timeout', () => {
    expect(
      diagnoseFailure(
        "EROFS: read-only file system, mkdir '/var/lib/a'\ngetaddrinfo ENOTFOUND api.example.com",
      ),
    ).toEqual({ _tag: 'BlockedHosts', hosts: ['api.example.com'] });
    expect(
      diagnoseFailure(
        "Test timed out in 5000ms.\nEROFS: read-only file system, mkdir '/var/lib/a'",
      ),
    ).toEqual({ _tag: 'ReadOnlyPaths', paths: ['/var/lib/a'] });
  });

  it('names the system library a binary could not load', () => {
    expect(
      diagnoseFailure(
        'node: error while loading shared libraries: libatomic.so.1: cannot open shared object file: No such file or directory',
      ),
    ).toEqual({ _tag: 'MissingLibraries', libraries: ['libatomic.so.1'] });
    expect(
      diagnoseFailure(
        'a: error while loading shared libraries: libb.so.2: cannot open shared object file\nc: error while loading shared libraries: libb.so.2: cannot open shared object file\nd: error while loading shared libraries: libe.so: cannot open shared object file',
      ),
    ).toEqual({ _tag: 'MissingLibraries', libraries: ['libb.so.2', 'libe.so'] });
  });

  it('prefers a missing library to a timeout, and a blocked host to a missing library', () => {
    const missing =
      'x: error while loading shared libraries: libz.so.1: cannot open shared object file';
    expect(diagnoseFailure(`Test timed out in 5000ms.\n${missing}`)).toEqual({
      _tag: 'MissingLibraries',
      libraries: ['libz.so.1'],
    });
    expect(diagnoseFailure(`${missing}\ngetaddrinfo ENOTFOUND api.example.com`)).toEqual({
      _tag: 'BlockedHosts',
      hosts: ['api.example.com'],
    });
  });

  it('reports a timeout from a test runner or a killed process', () => {
    expect(
      diagnoseFailure(' FAIL  src/api.test.ts > fetches\nError: Test timed out in 5000ms.'),
    ).toEqual({ _tag: 'TimedOut' });
    expect(diagnoseFailure('Error: Timeout of 2000ms exceeded.')).toEqual({ _tag: 'TimedOut' });
    expect(diagnoseFailure('Error: connect ETIMEDOUT')).toEqual({ _tag: 'TimedOut' });
  });

  it('prefers a blocked host to a timeout, since a refused host often leaves the test waiting', () => {
    expect(
      diagnoseFailure('Test timed out in 5000ms.\nError: getaddrinfo ENOTFOUND api.example.com'),
    ).toEqual({ _tag: 'BlockedHosts', hosts: ['api.example.com'] });
  });

  it('is unknown when the output says nothing of the environment', () => {
    expect(diagnoseFailure('AssertionError: expected 1 to be 2')).toEqual({ _tag: 'Unknown' });
    expect(diagnoseFailure('')).toEqual({ _tag: 'Unknown' });
  });
});
