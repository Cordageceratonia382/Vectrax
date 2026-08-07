import { describe, expect, it } from 'vitest';

import { assertUrlAllowed, isPrivateHost, normalizeUrl, parseUrl } from '../src/core/http/guard.js';
import { VectraxError } from '../src/core/errors.js';

describe('parseUrl', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(parseUrl('https://example.com/a').href).toBe('https://example.com/a');
    expect(parseUrl('http://example.com/a').href).toBe('http://example.com/a');
  });

  it('assumes https for a bare host', () => {
    expect(parseUrl('example.com/song.mp3').href).toBe('https://example.com/song.mp3');
  });

  it('preserves query strings containing "="', () => {
    const url = parseUrl('https://example.com/dl?id=7&token=abc=def');
    expect(url.search).toBe('?id=7&token=abc=def');
  });

  it('rejects empty input', () => {
    expect(() => parseUrl('   ')).toThrow(VectraxError);
  });

  it('rejects non-http schemes', () => {
    expect(() => parseUrl('file:///etc/passwd')).toThrow(/Unsupported URL scheme/);
    expect(() => parseUrl('ftp://example.com/a')).toThrow(/Unsupported URL scheme/);
    expect(() => parseUrl('javascript:alert(1)')).toThrow(/Unsupported URL scheme/);
  });

  it('blocks private destinations by default', () => {
    expect(() => parseUrl('http://127.0.0.1:8080/x')).toThrow(/private address/);
    expect(() => parseUrl('http://169.254.169.254/latest/meta-data/')).toThrow(/private address/);
  });

  it('allows private destinations when opted in', () => {
    expect(parseUrl('http://127.0.0.1:8080/x', { allowPrivateHosts: true }).port).toBe('8080');
  });

  it('can refuse plaintext http', () => {
    expect(() => parseUrl('http://example.com/a', { allowInsecure: false })).toThrow(/plaintext HTTP/);
  });
});

describe('isPrivateHost', () => {
  it('flags loopback and local names', () => {
    for (const host of ['localhost', 'app.localhost', 'printer.local', '127.0.0.1', '127.5.5.5', '::1', '::']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('flags RFC 1918 and carrier-grade NAT ranges', () => {
    for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('flags the cloud metadata address', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
  });

  it('flags IPv6 link-local and unique-local ranges', () => {
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fd00::1')).toBe(true);
    expect(isPrivateHost('[::ffff:127.0.0.1]')).toBe(true);
  });

  it('allows public addresses and hostnames', () => {
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1111']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe('assertUrlAllowed', () => {
  it('re-checks a redirect target', () => {
    expect(() => assertUrlAllowed(new URL('http://192.168.0.5/x'))).toThrow(/private address/);
  });
});

describe('normalizeUrl', () => {
  it('drops the fragment and sorts query parameters', () => {
    expect(normalizeUrl(new URL('https://a.test/x?b=2&a=1#frag'))).toBe('https://a.test/x?a=1&b=2');
  });

  it('drops the default port', () => {
    expect(normalizeUrl(new URL('https://a.test:443/x'))).toBe('https://a.test/x');
    expect(normalizeUrl(new URL('http://a.test:80/x'))).toBe('http://a.test/x');
  });

  it('keeps a non-default port', () => {
    expect(normalizeUrl(new URL('https://a.test:8443/x'))).toBe('https://a.test:8443/x');
  });
});
