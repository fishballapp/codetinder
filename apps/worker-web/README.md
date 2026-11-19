# @codetinder/worker-web

codetinder.dev's one Worker, `codetinder-web`: the marketing site (`@codetinder/site`) as static
assets, and **`POST /api/waitlist`**, which adds an email address to the waitlist in D1. Nothing
else is served: every other path is a file of the site or the site's 404 page with status 404.

The endpoint's contract is `@codetinder/api/waitlist` (the API definition) and
`@codetinder/api/waitlist-form` (plain values the site's form shares: the email pattern, the
platforms, the consent ids, the hidden field's name). The table is `migrations/0001_waitlist.sql`,
whose comments say what each column is for.

## Run it

```sh
pnpm -F @codetinder/worker-web dev        # port 8791, CODETINDER_WORKER_PORT to change it
pnpm -F @codetinder/worker-web test
```

`dev` assembles whatever the site has built into `dist/`, applies the migrations to a local D1 and
starts `wrangler dev`. Build the site first (`pnpm -F @codetinder/site build`) to see it.

```sh
curl -si localhost:8791/does-not-exist | head -1    # HTTP/1.1 404 Not Found, with the site's 404 page
curl -s -X POST localhost:8791/api/waitlist -H 'content-type: application/json' \
  -d '{"email":"you@example.com","consent":"v1"}'    # {"status":"joined"}
```

## Reading the list

Needs the `cf` CLI signed in (`cf auth login`) to the account that holds the Worker, whose id is
`account_id` in `wrangler.jsonc`. `<DB_ID>` is the `database_id` there.

```sh
export CLOUDFLARE_ACCOUNT_ID=<account_id from wrangler.jsonc>

# How many people are on it
cf d1 query <DB_ID> --sql "SELECT COUNT(*) AS people FROM waitlist_entry"

# Everyone, oldest first
cf d1 query <DB_ID> --sql "SELECT email, platform, datetime(joined_at / 1000, 'unixepoch') AS joined_utc FROM waitlist_entry ORDER BY joined_at"
```

## Removing one person

When someone asks to be removed, delete their row, then answer them. The address is matched the way
it was stored (trimmed, lower-cased); a `'` in it is written `''`.

```sh
cf d1 query <DB_ID> --sql "DELETE FROM waitlist_entry WHERE email_normalised = lower(trim('person@example.com'))"
```

## Deploying

`pnpm -F @codetinder/worker-web run deploy` builds the site, applies the migrations to the remote
database and deploys the Worker to the domains in `DOMAINS` in `scripts/deploy-worker.ts`. It needs
the baymutt environment named in `.env.schema`.

The D1 database was made once by hand, and its id is in `wrangler.jsonc`:

```sh
cf d1 create --name codetinder --jurisdiction eu
```

**The waitlist is stored in the EU.** A jurisdiction can only be set when a database is created, so
a database in another place would be a new one with the rows copied over. The Worker and its
config need nothing for it: the binding, `wrangler d1 migrations apply --remote` and
`wrangler deploy` reach the database by its id, from wherever the Worker runs.

The Worker has no runtime secrets. Workers Logs keep its own error logs but not the per-request
invocation logs (`wrangler.jsonc`), which record each request's URL and metadata that Cloudflare does
not list.
