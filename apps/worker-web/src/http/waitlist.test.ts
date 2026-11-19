import { describe, expect, it } from 'vitest';
import { clientKey } from '../platform/signup-limit';
import { FAKE_LIMIT, jsonRequest, testWorld, VALID } from '../test-support';

const answer = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});

describe('an invalid request', () => {
  const refused = async (body: unknown) => {
    const world = testWorld();
    const response = await answer(await world.api(jsonRequest(body)));
    expect(world.entries()).toEqual([]);
    return response;
  };

  it.each([
    ['no email', { consent: 'v1' }],
    ['an empty email', { ...VALID, email: '' }],
    ['an email of spaces', { ...VALID, email: '   ' }],
    ['no @', { ...VALID, email: 'ada.example.com' }],
    ['no domain dot', { ...VALID, email: 'ada@localhost' }],
    ['a numeric TLD', { ...VALID, email: 'ada@example.123' }],
    ['a space inside', { ...VALID, email: 'a da@example.com' }],
    ['two addresses', { ...VALID, email: 'ada@example.com, bob@example.com' }],
    ['a display name', { ...VALID, email: 'Ada <ada@example.com>' }],
    ['a leading dot', { ...VALID, email: '.ada@example.com' }],
    ['two dots', { ...VALID, email: 'ada..l@example.com' }],
    ['a non-ASCII local part', { ...VALID, email: 'adä@example.com' }],
    ['a non-ASCII domain', { ...VALID, email: 'ada@exämple.com' }],
    ['a local part over 64 characters', { ...VALID, email: `${'a'.repeat(65)}@example.com` }],
    [
      'an address over 254 characters',
      {
        ...VALID,
        email: `a@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.${'e'.repeat(63)}.com`,
      },
    ],
    ['an email that is not a string', { ...VALID, email: 42 }],
    ['an unknown platform', { ...VALID, platform: 'bitbucket' }],
    ['a null platform', { ...VALID, platform: null }],
    ['no consent id', { email: VALID.email }],
    ['an unknown consent id', { ...VALID, consent: 'v2' }],
    ['a hidden field that is not a string', { ...VALID, website: 1 }],
    ['a body that is not an object', ['ada@example.com']],
    ['a body that is null', null],
  ])('refuses %s with 400 and stores nothing', async (_name, body) => {
    const response = await refused(body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'InvalidRequestError' });
    expect(response.body).toHaveProperty('message');
  });

  it('refuses a body that is not JSON with 400', async () => {
    const world = testWorld();
    const response = await answer(await world.api(jsonRequest('{"email":')));
    expect(response.status).toBe(400);
    expect(world.entries()).toEqual([]);
  });

  it.each([
    'application/x-www-form-urlencoded',
    'text/plain',
    'application/jsonp',
    'text/json',
    '',
  ])(
    'refuses a body sent as "%s" with 400 in the error shape, and stores nothing',
    async contentType => {
      const world = testWorld();
      const response = await answer(
        await world.api(jsonRequest(VALID, { 'content-type': contentType })),
      );
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'InvalidRequestError' });
      expect(world.entries()).toEqual([]);
    },
  );

  it('refuses a body sent with no Content-Type, which a page on another origin can send without a preflight', async () => {
    const world = testWorld();
    const response = await answer(
      await world.api(jsonRequest(VALID, { 'content-type': undefined })),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'InvalidRequestError' });
    expect(world.entries()).toEqual([]);
  });

  it('takes application/json with a charset, in any case', async () => {
    const world = testWorld();
    const response = await world.api(
      jsonRequest(VALID, { 'content-type': 'Application/JSON; charset=utf-8' }),
    );
    expect(response.status).toBe(200);
  });

  it.each(['/api/waitlist?email=ada@example.com', '/api/waitlist?'])(
    'refuses %s: an address never travels in the URL',
    async path => {
      const world = testWorld();
      const response = await answer(await world.api(jsonRequest(VALID, {}, 'POST', path)));
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'InvalidRequestError' });
      expect(world.entries()).toEqual([]);
    },
  );

  it('accepts the longest address the schema allows', async () => {
    const world = testWorld();
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    expect(email.length).toBe(254);
    const response = await world.api(jsonRequest({ ...VALID, email }));
    expect(response.status).toBe(200);
  });
});

describe('the body cap', () => {
  it('refuses a body over 1024 bytes with 413 and stores nothing', async () => {
    const world = testWorld();
    const response = await answer(
      await world.api(jsonRequest({ ...VALID, website: 'x'.repeat(1100) })),
    );
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'PayloadTooLargeError' });
    expect(world.entries()).toEqual([]);
  });

  it('takes a body of exactly 1024 bytes', async () => {
    const world = testWorld();
    const filler = 1024 - JSON.stringify({ ...VALID, website: '' }).length;
    const body = { ...VALID, website: 'x'.repeat(filler) };
    expect(JSON.stringify(body).length).toBe(1024);
    const response = await world.api(jsonRequest(body));
    // A filled hidden field: a success, stored nowhere.
    expect(response.status).toBe(200);
  });

  it.each(['', 'abc', '-1', '1e3', '0x10', '1.5'])(
    'refuses a malformed Content-Length "%s" with 413 and stores nothing',
    async contentLength => {
      const world = testWorld();
      const response = await answer(
        await world.api(jsonRequest(VALID, { 'content-length': contentLength })),
      );
      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({ code: 'PayloadTooLargeError' });
      expect(world.entries()).toEqual([]);
    },
  );

  it.each(['', 'abc', '-1'])(
    'refuses an oversized body that sends the malformed Content-Length "%s"',
    async contentLength => {
      const world = testWorld();
      const response = await world.api(
        jsonRequest({ ...VALID, website: 'x'.repeat(5000) }, { 'content-length': contentLength }),
      );
      expect(response.status).toBe(413);
      expect(world.entries()).toEqual([]);
    },
  );

  it('refuses a body sent without a Content-Length', async () => {
    const world = testWorld();
    const request = new Request('http://localhost/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify(VALID),
    });
    const response = await answer(await world.api(request));
    expect(response.status).toBe(413);
    expect(world.entries()).toEqual([]);
  });
});

describe('the rate limit', () => {
  it(`refuses the ${FAKE_LIMIT + 1}th request of one client with 429 and stores nothing`, async () => {
    const world = testWorld();
    const statuses: number[] = [];
    for (let attempt = 0; attempt <= FAKE_LIMIT; attempt++) {
      const response = await world.api(
        jsonRequest({ ...VALID, email: `person${attempt}@example.com` }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([...Array.from({ length: FAKE_LIMIT }, () => 200), 429]);
    expect(world.entries()).toHaveLength(FAKE_LIMIT);

    const limited = await answer(await world.api(jsonRequest(VALID)));
    expect(limited.body).toMatchObject({ code: 'RateLimitedError' });
  });

  it('counts a request that would be refused for its body too', async () => {
    const world = testWorld();
    for (let attempt = 0; attempt < FAKE_LIMIT; attempt++) {
      await world.api(jsonRequest({ email: 'nope' }));
    }
    expect((await world.api(jsonRequest(VALID))).status).toBe(429);
  });

  it('gives each client its own allowance', async () => {
    const world = testWorld();
    for (let attempt = 0; attempt <= FAKE_LIMIT; attempt++) {
      await world.api(jsonRequest(VALID, { 'cf-connecting-ip': '198.51.100.1' }));
    }
    const other = await world.api(jsonRequest(VALID, { 'cf-connecting-ip': '198.51.100.2' }));
    expect(other.status).toBe(200);
  });

  it('keys the limit on the client address, and keeps the address nowhere else', async () => {
    const world = testWorld();
    await world.api(jsonRequest(VALID, { 'cf-connecting-ip': '198.51.100.1' }));
    expect(world.limit.keys).toEqual(['198.51.100.1']);
    expect(JSON.stringify(world.entries())).not.toContain('198.51.100.1');
  });
});

describe('clientKey', () => {
  it('is an IPv4 address as it is', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('is the /64 of an IPv6 address, however it is written', () => {
    const key = '2001:0db8:0000:0042::/64';
    expect(clientKey('2001:db8:0:42:1:2:3:4')).toBe(key);
    expect(clientKey('2001:DB8:0:42::1')).toBe(key);
    expect(clientKey('2001:db8:0:42:ffff:ffff:ffff:ffff')).toBe(key);
    expect(clientKey('2001:db8:0:43::1')).not.toBe(key);
  });

  it('reads :: wherever it sits', () => {
    expect(clientKey('::1')).toBe('0000:0000:0000:0000::/64');
    expect(clientKey('fe80::')).toBe('fe80:0000:0000:0000::/64');
    expect(clientKey('2001:db8::1:2:3')).toBe('2001:0db8:0000:0000::/64');
  });

  it('is one shared key when Cloudflare did not say who it is, or said nothing', () => {
    expect(clientKey(undefined)).toBe('no-client-ip');
    expect(clientKey('')).toBe('no-client-ip');
  });

  it('reads the unspecified address and the loopback', () => {
    expect(clientKey('::')).toBe('0000:0000:0000:0000::/64');
    expect(clientKey('::1')).toBe('0000:0000:0000:0000::/64');
  });

  it('keys an uppercase address as its lower-case one', () => {
    expect(clientKey('2001:DB8:ABCD:EF01::1')).toBe(clientKey('2001:db8:abcd:ef01::1'));
  });

  it.each([':'.repeat(5000), '::'.repeat(2000), `${'a:'.repeat(3000)}::`, 'x'.repeat(5000)])(
    'does not throw on a malformed value of %#',
    value => {
      expect(() => clientKey(value)).not.toThrow();
    },
  );
});

describe('a page on another origin', () => {
  it('gets no CORS headers from the preflight, so the browser refuses the request', async () => {
    const world = testWorld();
    const response = await world.api(
      jsonRequest(
        undefined,
        {
          origin: 'https://other.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
          'content-type': undefined,
          'content-length': undefined,
        },
        'OPTIONS',
      ),
    );
    const corsHeaders = [...response.headers.keys()].filter(name =>
      name.startsWith('access-control-allow-'),
    );
    expect(corsHeaders).toEqual([]);
    expect(world.entries()).toEqual([]);
  });

  it('gets no CORS headers on a request that goes through, either', async () => {
    const world = testWorld();
    const response = await world.api(jsonRequest(VALID, { origin: 'https://other.example' }));
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('an address in punycode', () => {
  it.each(['dev@example.xn--p1ai', 'dev@sub.example.xn--80asehdb', 'dev@example.XN--P1AI'])(
    'is accepted: %s',
    async email => {
      const world = testWorld();
      expect((await world.api(jsonRequest({ ...VALID, email }))).status).toBe(200);
      expect(world.entries()).toHaveLength(1);
    },
  );

  it.each([
    'dev@example.xn--',
    'dev@example.xn--p1ai-',
    'dev@example.xn---',
    'dev@example.1xn--p1ai',
    'dev@xn--p1ai',
    `dev@example.xn--${'a'.repeat(60)}`,
    `dev@${'a-'.repeat(400)}.com`,
  ])('is refused when malformed: %s', async email => {
    const world = testWorld();
    expect((await world.api(jsonRequest({ ...VALID, email }))).status).toBe(400);
    expect(world.entries()).toEqual([]);
  });
});

describe('a database failure', () => {
  it('answers a generic JSON 500 and logs no address', async () => {
    const world = testWorld();
    world.sqlite.exec('DROP TABLE waitlist_entry');

    const response = await answer(
      await world.api(jsonRequest({ ...VALID, email: 'secret.person@example.com' })),
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: 'InternalServerError',
      message: 'An unexpected error occurred on the server — try again shortly.',
    });
    expect(world.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(world.logs)).not.toContain('secret.person');
  });
});

describe('concurrent signups', () => {
  it('of one address leave one row, and each is answered joined', async () => {
    const world = testWorld();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        world.api(
          jsonRequest(
            { ...VALID, email: index % 2 === 0 ? 'Ada@Example.com' : ' ada@example.com ' },
            { 'cf-connecting-ip': `198.51.100.${index}` },
          ),
        ),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual(Array.from({ length: 8 }, () => 200));
    expect(world.entries()).toHaveLength(1);
  });
});

describe('everything else', () => {
  it.each(['GET', 'PUT', 'DELETE'])(
    'answers %s /api/waitlist with 404 and the error contract',
    async method => {
      const world = testWorld();
      const response = await answer(await world.api(jsonRequest(VALID, {}, method)));
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NotFound' });
    },
  );

  it.each(['/api/rounds', '/api/projects/1', '/api/health'])('answers %s with 404', async path => {
    const world = testWorld();
    const response = await world.api(jsonRequest(VALID, {}, 'POST', path));
    expect(response.status).toBe(404);
    expect(world.entries()).toEqual([]);
  });
});
