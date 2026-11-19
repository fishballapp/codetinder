-- The waitlist: one row per person who asked to hear when CodeTinder relaunches. It holds
-- personal data from the first signup, so a later change to it is a new migration, never an edit.
--
-- email            the address as the person typed it, with the spaces around it trimmed.
-- email_normalised the same address lower-cased: what makes two spellings one row. Dots and
--                  `+tags` are left alone, because they can name different mailboxes. Both are
--                  ASCII (the API refuses anything else), so SQLite's lower() agrees with the
--                  Worker's toLowerCase().
-- platform         where they keep their code, if they said; a repeat signup that names one
--                  replaces it, and one that doesn't leaves it.
-- consent_version  the id of the wording they saw beside the form when they joined (`CONSENT_VERSIONS`
--                  in @codetinder/api/waitlist-form; the text of each id is in the site). A repeat
--                  signup leaves it: the row says what the person agreed to the first time.
-- joined_at        epoch milliseconds, UTC, of the first signup. A repeat never changes it.
--
-- No IP address and no user agent are kept.
create table waitlist_entry (
  id integer primary key,
  email text not null,
  email_normalised text not null unique,
  platform text,
  consent_version text not null,
  joined_at integer not null,
  check (email = trim(email)),
  check (email_normalised = lower(email)),
  check (platform in ('github', 'gitlab', 'both')),
  check (length(consent_version) between 1 and 32)
) strict;
