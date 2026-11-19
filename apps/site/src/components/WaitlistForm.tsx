import { Field } from '@base-ui/react/field';
import { Fieldset } from '@base-ui/react/fieldset';
import { Form } from '@base-ui/react/form';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import {
  EMAIL_PATTERN,
  HONEYPOT_FIELD,
  MAX_EMAIL_LENGTH,
  PLATFORMS,
  type Platform,
  WAITLIST_PATH,
} from '@codetinder/api/waitlist-form';
import { cn, pillVariants } from '@codetinder/ui';
import { GitLabMark } from '@codetinder/ui/react';
import {
  CheckIcon,
  GithubLogoIcon,
  HeartBreakIcon,
  HeartIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  trackWaitlistFailed,
  trackWaitlistInvalid,
  trackWaitlistJoined,
  trackWaitlistSubmitted,
  type WaitlistFailure,
} from '../analytics';
import { CONSENT_TEXT, CURRENT_CONSENT } from '../consent';

const PLATFORM_CHOICES: Record<Platform, { readonly label: string; readonly icon: ReactNode }> = {
  github: { label: 'GitHub', icon: <GithubLogoIcon weight="fill" aria-hidden="true" /> },
  gitlab: { label: 'GitLab', icon: <GitLabMark className="size-[1.1em]" /> },
  both: { label: 'Both', icon: null },
};

const FAILURE_MESSAGES: Record<WaitlistFailure, string> = {
  rate_limited: 'Too many signups. Try again in a minute.',
  refused: 'Check your email address and try again.',
  unreachable: "We couldn't reach the waitlist. Try again.",
};

type Status =
  | { readonly kind: 'editing' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'joined'; readonly email: string }
  | { readonly kind: 'failed'; readonly failure: WaitlistFailure };

/** What is wrong with the address as typed, in the words the field shows; `null` when it's fine. */
const emailProblem = (value: unknown): string | null => {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email === '') return 'Enter your email address.';
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return 'Enter a valid email address.';
  }
  return null;
};

/** The waitlist's answer to a join: nothing when it took it, else why not. */
const join = async (body: Record<string, string>): Promise<WaitlistFailure | undefined> => {
  try {
    const response = await fetch(WAITLIST_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return undefined;
    if (response.status === 429) return 'rate_limited';
    if (response.status === 400) return 'refused';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
};

/**
 * The waitlist's signup: an email, an optional platform, then the button. Joining
 * answers the same for a new address and one already listed, so the joined state never says which.
 *
 * `ph-no-capture` on the form, its field and the joined message keeps PostHog's autocapture off
 * everything that holds or shows the address: an event whose target or any ancestor has the class
 * is dropped whole.
 */
export const WaitlistForm = () => {
  const [email, setEmail] = useState('');
  const [platform, setPlatform] = useState<Platform>();
  const [status, setStatus] = useState<Status>({ kind: 'editing' });
  const honeypotRef = useRef<HTMLInputElement>(null);
  const joinedRef = useRef<HTMLDivElement>(null);
  const isSending = status.kind === 'sending';

  useEffect(() => {
    if (status.kind === 'joined') joinedRef.current?.focus();
  }, [status.kind]);

  const submit = async () => {
    const trimmedEmail = email.trim();
    setStatus({ kind: 'sending' });
    trackWaitlistSubmitted(platform);
    const failure = await join({
      email: trimmedEmail,
      ...(platform === undefined ? {} : { platform }),
      consent: CURRENT_CONSENT,
      [HONEYPOT_FIELD]: honeypotRef.current?.value ?? '',
    });
    if (failure === undefined) {
      trackWaitlistJoined(platform);
    } else {
      trackWaitlistFailed(failure);
    }
    setStatus(
      failure === undefined ? { kind: 'joined', email: trimmedEmail } : { kind: 'failed', failure },
    );
  };

  if (status.kind === 'joined') {
    return (
      <div
        ref={joinedRef}
        tabIndex={-1}
        className="ph-no-capture mt-6 flex items-center gap-4 rounded-[1.25rem] bg-petal-wash p-5 outline-none"
      >
        <HeartIcon
          weight="fill"
          aria-hidden="true"
          className="size-12 flex-none text-lipstick animate-beat-once motion-reduce:animate-none"
        />
        <div>
          <h3 className="font-display text-[1.6rem] font-bold leading-[1.1] text-candy-red text-shadow-emboss">
            You're on the waitlist!
          </h3>
          <p className="mt-1 text-[1.05rem] leading-normal text-ink-soft">
            We'll write to <strong className="font-semibold text-ink">{status.email}</strong> when
            CodeTinder is ready.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Form
      className="ph-no-capture mt-5 grid gap-5"
      // Before Base UI's own handler, which stops an invalid form and says nothing about it.
      onSubmitCapture={() => {
        if (emailProblem(email) !== null) trackWaitlistInvalid();
      }}
      onFormSubmit={() => void submit()}
    >
      <Field.Root name="email" validate={emailProblem} disabled={isSending} className="grid gap-2">
        <Field.Label className="text-[1.05rem] font-semibold text-ink">Email address</Field.Label>
        <Field.Control
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onValueChange={setEmail}
          className="ph-no-capture w-full rounded-pill border-2 border-petal bg-card px-5 py-[0.8rem] text-[1.15rem] text-ink transition-[border-color,box-shadow] duration-150 placeholder:text-ink-faint focus:border-hot-pink focus:shadow-[0_0_0_4px_rgb(247_23_90/0.18)] focus-visible:outline-none data-[disabled]:border-rule data-[disabled]:bg-card-sunk data-[disabled]:text-ink-soft data-[invalid]:border-lipstick data-[invalid]:bg-petal-wash"
        />
        <Field.Error className="flex items-center gap-2 text-[1rem] font-semibold text-wine [&_svg]:size-[1.15em] [&_svg]:flex-none [&_svg]:text-lipstick">
          <WarningCircleIcon weight="fill" aria-hidden="true" />
          {emailProblem(email)}
        </Field.Error>
      </Field.Root>

      <Fieldset.Root className="grid gap-3" disabled={isSending}>
        <Fieldset.Legend className="text-[1.05rem] font-semibold text-ink">
          Where would you use it? <span className="font-normal text-ink-faint">(optional)</span>
        </Fieldset.Legend>
        <ToggleGroup
          value={platform === undefined ? [] : [platform]}
          onValueChange={values => setPlatform(PLATFORMS.find(choice => choice === values[0]))}
          disabled={isSending}
          className="flex flex-wrap gap-2"
        >
          {PLATFORMS.map(choice => (
            <Toggle
              key={choice}
              value={choice}
              className="group inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-pill border-[1.5px] border-petal bg-card px-4 text-[1rem] font-semibold text-wine transition-colors duration-150 hover:border-lipstick data-[disabled]:cursor-default data-[disabled]:opacity-60 data-[pressed]:border-hot-pink data-[pressed]:bg-petal-wash data-[pressed]:text-ink [&_svg]:size-[1.1em]"
            >
              <CheckIcon
                weight="bold"
                aria-hidden="true"
                className="hidden text-hot-pink group-data-[pressed]:inline"
              />
              {PLATFORM_CHOICES[choice].icon}
              {PLATFORM_CHOICES[choice].label}
            </Toggle>
          ))}
        </ToggleGroup>
      </Fieldset.Root>

      {/* For bots only: a person never sees it, a bot that fills in every field fills it in. */}
      <input
        ref={honeypotRef}
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute -left-[9999px] size-px overflow-hidden opacity-0"
      />

      <p className="text-[0.95rem] leading-[1.45] text-pretty text-ink-soft">
        {CONSENT_TEXT[CURRENT_CONSENT]}{' '}
        <a href="/privacy" className="whitespace-nowrap font-semibold text-wine underline">
          Privacy policy
        </a>
      </p>

      <div className="grid gap-3">
        <button
          type="submit"
          disabled={isSending}
          className={cn(pillVariants({ size: 'md' }), 'w-full justify-center text-[1.15rem]')}
        >
          {isSending ? (
            <>
              <HeartIcon
                weight="fill"
                aria-hidden="true"
                className="animate-beat motion-reduce:animate-none"
              />
              Joining…
            </>
          ) : (
            <>
              {status.kind === 'failed' ? 'Try again' : 'Join the waitlist'}
              <HeartIcon weight="fill" aria-hidden="true" />
            </>
          )}
        </button>
        {status.kind === 'failed' && (
          <p
            role="alert"
            className="flex items-center gap-2 text-[1rem] font-semibold text-wine [&_svg]:size-[1.15em] [&_svg]:flex-none [&_svg]:text-lipstick"
          >
            <HeartBreakIcon weight="fill" aria-hidden="true" />
            {FAILURE_MESSAGES[status.failure]}
          </p>
        )}
        <p role="status" className="sr-only">
          {isSending ? 'Joining the waitlist.' : ''}
        </p>
      </div>
    </Form>
  );
};
