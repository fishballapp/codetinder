import { describe, expect, it } from 'vitest';
import { jsonRequest, testWorld, VALID } from '../test-support';
import { normaliseEmail } from './waitlist';

const join = async (world: ReturnType<typeof testWorld>, body: unknown) => {
  const response = await world.api(jsonRequest(body));
  return { status: response.status, text: await response.text() };
};

describe('normaliseEmail', () => {
  it('trims and lower-cases, and keeps dots and +tags', () => {
    expect(normaliseEmail('  Ada.Lovelace+Tag@Example.COM ')).toBe('ada.lovelace+tag@example.com');
  });
});

describe('joining the waitlist', () => {
  it('stores a new address with every column', async () => {
    const world = testWorld();
    const before = Date.now();

    const response = await join(world, {
      email: '  Ada@Example.COM ',
      platform: 'gitlab',
      consent: 'v1',
    });

    expect(response).toEqual({ status: 200, text: '{"status":"joined"}' });
    const [row, ...others] = world.entries();
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      email: 'Ada@Example.COM',
      email_normalised: 'ada@example.com',
      platform: 'gitlab',
      consent_version: 'v1',
    });
    expect(row?.joined_at).toBeGreaterThanOrEqual(before);
    expect(row?.joined_at).toBeLessThanOrEqual(Date.now());
  });

  it('stores no platform when none is given', async () => {
    const world = testWorld();
    await join(world, VALID);
    expect(world.entries()[0]?.platform).toBeNull();
  });

  it.each(['github', 'gitlab', 'both'])('accepts the platform %s', async platform => {
    const world = testWorld();
    expect(await join(world, { ...VALID, platform })).toMatchObject({ status: 200 });
    expect(world.entries()[0]?.platform).toBe(platform);
  });

  it('answers the same, byte for byte, for an address already on the list', async () => {
    const world = testWorld();
    const first = await join(world, VALID);
    const again = await join(world, { ...VALID, email: ' ADA@example.com ' });

    expect(again).toEqual(first);
    expect(world.entries()).toHaveLength(1);
  });

  it('keeps the first row’s address, join time and consent on a repeat', async () => {
    const world = testWorld();
    await join(world, { email: 'Ada@Example.com', consent: 'v1' });
    world.sqlite.exec('UPDATE waitlist_entry SET joined_at = 1000');

    await join(world, { email: 'ada@example.com', consent: 'v1' });

    expect(world.entries()).toEqual([
      {
        id: 1,
        email: 'Ada@Example.com',
        email_normalised: 'ada@example.com',
        platform: null,
        consent_version: 'v1',
        joined_at: 1000,
      },
    ]);
  });

  it('takes the platform a repeat names, and keeps it when a repeat names none', async () => {
    const world = testWorld();
    await join(world, { ...VALID, platform: 'github' });

    await join(world, { ...VALID, platform: 'both' });
    expect(world.entries()[0]?.platform).toBe('both');

    await join(world, VALID);
    expect(world.entries()[0]?.platform).toBe('both');
  });

  it('keeps dots and +tags: they can be different mailboxes', async () => {
    const world = testWorld();
    await join(world, { ...VALID, email: 'ada.l@example.com' });
    await join(world, { ...VALID, email: 'adal@example.com' });
    await join(world, { ...VALID, email: 'ada.l+news@example.com' });

    expect(world.entries().map(({ email_normalised }) => email_normalised)).toEqual([
      'ada.l@example.com',
      'adal@example.com',
      'ada.l+news@example.com',
    ]);
  });

  it('answers a bot that filled the hidden field as a success and stores nothing', async () => {
    const world = testWorld();
    const real = await join(testWorld(), VALID);

    const bot = await join(world, { ...VALID, website: 'https://spam.example' });

    expect(bot).toEqual(real);
    expect(world.entries()).toEqual([]);
  });

  it('stores an address whose hidden field came empty', async () => {
    const world = testWorld();
    await join(world, { ...VALID, website: '' });
    expect(world.entries()).toHaveLength(1);
  });
});

describe('the table', () => {
  const insert = (world: ReturnType<typeof testWorld>, email: string, normalised: string) =>
    world.sqlite
      .prepare(
        'INSERT INTO waitlist_entry (email, email_normalised, consent_version, joined_at) VALUES (?, ?, ?, ?)',
      )
      .run(email, normalised, 'v1', 1);

  it('refuses a second row for one normalised address', () => {
    const world = testWorld();
    insert(world, 'ada@example.com', 'ada@example.com');
    expect(() => insert(world, 'ada@example.com', 'ada@example.com')).toThrow(/UNIQUE/u);
  });

  it('refuses a key that is not the address lower-cased, or an address with spaces', () => {
    const world = testWorld();
    expect(() => insert(world, 'Ada@example.com', 'Ada@example.com')).toThrow(/CHECK/u);
    expect(() => insert(world, ' ada@example.com', ' ada@example.com')).toThrow(/CHECK/u);
  });

  it('refuses a platform outside the three', () => {
    const world = testWorld();
    expect(() =>
      world.sqlite
        .prepare(
          "INSERT INTO waitlist_entry (email, email_normalised, platform, consent_version, joined_at) VALUES ('a@b.co', 'a@b.co', 'bitbucket', 'v1', 1)",
        )
        .run(),
    ).toThrow(/CHECK/u);
  });
});
